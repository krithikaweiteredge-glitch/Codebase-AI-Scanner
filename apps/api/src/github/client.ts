import { env } from '../env';
import { githubAuthFailed, githubUnavailable, repositoryInaccessible } from '../errors';
import { sleep } from '../lib/pool';

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; type: string; avatar_url: string };
  private: boolean;
  description: string | null;
  html_url: string;
  default_branch: string;
  size: number;
  language: string | null;
  updated_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  archived: boolean;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string } | null;
    committer: { name: string; email: string; date: string } | null;
  };
  author: { login: string } | null;
  html_url: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubTree {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  html_url: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface GitHubPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha: string;
  previous_filename?: string;
}

export interface GitHubComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  html_url: string;
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: Date | null;
}

/**
 * Thin, typed GitHub REST client.
 *
 * - Never logs or serialises the access token.
 * - Maps GitHub failures onto the application error taxonomy.
 * - Retries once on secondary rate limits / 5xx with a short backoff.
 */
export class GitHubClient {
  private readonly base: string;
  private lastRateLimit: RateLimitInfo | null = null;

  constructor(private readonly token: string) {
    this.base = env.GITHUB_API_URL.replace(/\/$/, '');
  }

  get rateLimit(): RateLimitInfo | null {
    return this.lastRateLimit;
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<{ data: T; headers: Headers }> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'codebase-ai-platform',
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (cause) {
      throw githubUnavailable('Could not reach the GitHub API. Check your network connection.');
    }

    const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? Number.NaN);
    if (!Number.isNaN(remaining)) {
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      this.lastRateLimit = {
        remaining,
        limit: Number(response.headers.get('x-ratelimit-limit') ?? 0),
        resetAt: reset ? new Date(reset * 1000) : null,
      };
    }

    if (response.ok) {
      const text = await response.text();
      const data = (text ? JSON.parse(text) : null) as T;
      return { data, headers: response.headers };
    }

    if ((response.status === 403 || response.status === 429) && attempt < 1) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      if (retryAfter > 0 && retryAfter <= 30) {
        await sleep(retryAfter * 1000);
        return this.request<T>(path, init, attempt + 1);
      }
    }
    if (response.status >= 500 && attempt < 1) {
      await sleep(750);
      return this.request<T>(path, init, attempt + 1);
    }

    const body = await response.text().catch(() => '');
    const message = safeMessage(body);

    if (response.status === 401) throw githubAuthFailed();
    if (response.status === 404) {
      throw repositoryInaccessible(
        'GitHub returned 404. The resource does not exist, or your token lacks access to it.',
      );
    }
    if (response.status === 403) {
      if (this.lastRateLimit && this.lastRateLimit.remaining === 0) {
        const at = this.lastRateLimit.resetAt?.toISOString() ?? 'shortly';
        throw githubUnavailable(`GitHub API rate limit exhausted. It resets at ${at}.`);
      }
      throw githubUnavailable(`GitHub denied the request: ${message}`);
    }
    throw githubUnavailable(`GitHub API error (${response.status}): ${message}`);
  }

  private async paginate<T>(path: string, max = 500): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    while (next && out.length < max) {
      const { data, headers } = await this.request<T[]>(next);
      if (!Array.isArray(data)) break;
      out.push(...data);
      next = parseNextLink(headers.get('link'));
    }
    return out.slice(0, max);
  }

  async getUser(): Promise<GitHubUser> {
    return (await this.request<GitHubUser>('/user')).data;
  }

  async getTokenScopes(): Promise<string[]> {
    const { headers } = await this.request<GitHubUser>('/user');
    const scopes = headers.get('x-oauth-scopes');
    return scopes ? scopes.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }

  async listRepositories(): Promise<GitHubRepo[]> {
    return this.paginate<GitHubRepo>('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', 600);
  }

  async listInstallationRepositories(): Promise<GitHubRepo[]> {
    const out: GitHubRepo[] = [];
    let page = 1;
    while (out.length < 500) {
      const { data } = await this.request<{ total_count: number; repositories: GitHubRepo[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      if (!data?.repositories || data.repositories.length === 0) break;
      out.push(...data.repositories);
      if (out.length >= data.total_count) break;
      page++;
    }
    return out;
  }

  async listOrganizations(): Promise<{ login: string; avatar_url: string }[]> {
    return this.paginate<{ login: string; avatar_url: string }>('/user/orgs?per_page=100', 100);
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepo> {
    return (await this.request<GitHubRepo>(`/repos/${enc(owner)}/${enc(repo)}`)).data;
  }

  async getLanguages(owner: string, repo: string): Promise<Record<string, number>> {
    return (await this.request<Record<string, number>>(`/repos/${enc(owner)}/${enc(repo)}/languages`)).data ?? {};
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    return this.paginate<GitHubBranch>(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`, 300);
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch & { commit: GitHubCommit }> {
    return (
      await this.request<GitHubBranch & { commit: GitHubCommit }>(
        `/repos/${enc(owner)}/${enc(repo)}/branches/${encodeURIComponent(branch)}`,
      )
    ).data;
  }

  async listCommits(owner: string, repo: string, sha: string, perPage = 20): Promise<GitHubCommit[]> {
    const { data } = await this.request<GitHubCommit[]>(
      `/repos/${enc(owner)}/${enc(repo)}/commits?sha=${encodeURIComponent(sha)}&per_page=${perPage}`,
    );
    return data ?? [];
  }

  async getTree(owner: string, repo: string, sha: string): Promise<GitHubTree> {
    return (
      await this.request<GitHubTree>(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`)
    ).data;
  }

  /** Returns raw file bytes for a blob SHA. */
  async getBlob(owner: string, repo: string, sha: string): Promise<Buffer> {
    const { data } = await this.request<{ content: string; encoding: string; size: number }>(
      `/repos/${enc(owner)}/${enc(repo)}/git/blobs/${encodeURIComponent(sha)}`,
    );
    if (data.encoding === 'base64') return Buffer.from(data.content, 'base64');
    return Buffer.from(data.content, 'utf8');
  }

  async compareCommits(owner: string, repo: string, base: string, head: string) {
    return (
      await this.request<{
        status: string;
        ahead_by: number;
        behind_by: number;
        files?: GitHubPullFile[];
        commits: GitHubCommit[];
      }>(`/repos/${enc(owner)}/${enc(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
    ).data;
  }

  async listPullRequests(owner: string, repo: string, state = 'open'): Promise<GitHubPullRequest[]> {
    return this.paginate<GitHubPullRequest>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=50&sort=updated&direction=desc`,
      150,
    );
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    return (await this.request<GitHubPullRequest>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`)).data;
  }

  async listPullRequestFiles(owner: string, repo: string, number: number): Promise<GitHubPullFile[]> {
    return this.paginate<GitHubPullFile>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/files?per_page=100`, 300);
  }

  async listPullRequestComments(owner: string, repo: string, number: number): Promise<GitHubComment[]> {
    return this.paginate<GitHubComment>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments?per_page=100`, 200);
  }

  /** Posting is only ever invoked behind an explicit user confirmation. */
  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<GitHubComment> {
    return (
      await this.request<GitHubComment>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    ).data;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function safeMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message ?? 'unknown error';
  } catch {
    return body.slice(0, 200) || 'unknown error';
  }
}
