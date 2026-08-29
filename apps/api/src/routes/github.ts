import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { env, githubAppConfigured, githubOAuthConfigured } from '../env';
import { beginOAuth, consumeOAuthState, exchangeCodeForToken } from '../github/oauth';
import {
  deleteGitHubInstallation,
  disconnectGitHub,
  githubClientForInstallation,
  githubClientForUser,
  listUserInstallations,
  saveGitHubInstallation,
  storeGitHubToken,
} from '../github/service';
import { verifyWebhookSignature } from '../github/appAuth';
import type { GitHubRepo } from '../github/client';

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  /** Reports whether GitHub App and/or OAuth are available. */
  app.get('/api/github/status', { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      select: {
        githubLogin: true,
        githubTokenScope: true,
        githubLinkedAt: true,
        githubTokenEnc: true,
        installations: { orderBy: { createdAt: 'desc' } },
      },
    });

    const isConnected = Boolean(user.githubTokenEnc || user.installations.length > 0);
    const primaryLogin = user.githubLogin || user.installations[0]?.accountLogin || null;

    return {
      oauthConfigured: githubOAuthConfigured,
      appConfigured: githubAppConfigured,
      appSlug: env.GITHUB_APP_SLUG || null,
      connected: isConnected,
      login: primaryLogin,
      scopes: user.githubTokenScope ? user.githubTokenScope.split(',') : [],
      linkedAt: user.githubLinkedAt || user.installations[0]?.createdAt || null,
      installationsCount: user.installations.length,
      installations: user.installations.map((inst) => ({
        id: inst.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        accountAvatar: inst.accountAvatar,
        repositorySelection: inst.repositorySelection,
      })),
    };
  });

  /** Returns the direct installation URL for the GitHub App. */
  app.get('/api/github/app/install-url', { preHandler: requireAuth }, async () => {
    if (!githubAppConfigured) {
      return { installUrl: null, configured: false };
    }
    const installUrl = `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`;
    return { installUrl, configured: true };
  });

  /** GitHub App post-installation redirect handler. */
  app.get('/api/github/app/callback', async (request, reply) => {
    const query = z
      .object({
        installation_id: z.string().optional(),
        setup_action: z.string().optional(),
      })
      .safeParse(request.query);

    const installationId = query.success ? query.data.installation_id : undefined;

    // Check if user session exists from cookie
    if (request.user?.id && installationId) {
      try {
        await saveGitHubInstallation(request.user.id, installationId);
      } catch (err) {
        request.log.error({ err }, 'Failed to save installation from app callback');
      }
      return reply.redirect(`${env.WEB_ORIGIN}/repositories/connect?github=installed&installation_id=${installationId}`);
    }

    // Redirect to connect page with installation_id query param so client can link it if needed
    const dest = installationId
      ? `${env.WEB_ORIGIN}/repositories/connect?github=installed&installation_id=${installationId}`
      : `${env.WEB_ORIGIN}/repositories/connect?github=installed`;
    return reply.redirect(dest);
  });

  /** Explicitly link an installation ID to the current authenticated user. */
  app.post('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ installationId: z.string().min(1) }).parse(request.body);
    const installation = await saveGitHubInstallation(request.user!.id, body.installationId);
    return { success: true, installation };
  });

  /** List installations for the current user. */
  app.get('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const installations = await listUserInstallations(request.user!.id);
    return { installations };
  });

  /** Unlink/delete a specific installation for the user. */
  app.delete('/api/github/installations/:installationId', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ installationId: z.string().min(1) }).parse(request.params);
    await deleteGitHubInstallation(request.user!.id, params.installationId);
    return { success: true };
  });

  /** GitHub Webhook endpoint for events (installations, PR reviews, push). */
  app.post('/api/github/webhook', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);

    if (!verifyWebhookSignature(rawBody, signature)) {
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }

    const event = request.headers['x-github-event'] as string;
    const payload = request.body as Record<string, any>;

    request.log.info({ event, action: payload?.action }, 'Received GitHub Webhook');

    if (event === 'installation' && payload.action === 'deleted') {
      const instId = String(payload.installation?.id);
      if (instId) {
        await prisma.gitHubInstallation.deleteMany({ where: { installationId: instId } });
      }
    }

    return reply.send({ ok: true });
  });

  app.get('/api/github/connect', { preHandler: requireAuth }, async (request, reply) => {
    const url = await beginOAuth(request.user!.id, env.WEB_ORIGIN);
    return reply.send({ authorizeUrl: url });
  });

  /** OAuth callback - exchanges the code and redirects back into the web app. */
  app.get('/api/github/callback', async (request, reply) => {
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(request.query);

    if (!query.success) {
      return reply.redirect(`${env.WEB_ORIGIN}/settings?github=error&reason=missing_code`);
    }

    try {
      const { userId, redirect } = await consumeOAuthState(query.data.state);
      const { token, scopes } = await exchangeCodeForToken(query.data.code);
      const result = await storeGitHubToken(userId, token, scopes);
      return reply.redirect(`${redirect ?? env.WEB_ORIGIN}/repositories/connect?github=connected&login=${result.login}`);
    } catch (error) {
      request.log.error({ err: error }, 'GitHub OAuth callback failed');
      return reply.redirect(`${env.WEB_ORIGIN}/settings?github=error`);
    }
  });

  /** Personal access token path. */
  app.post('/api/github/token', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ token: z.string().min(20).max(255) }).parse(request.body);
    const result = await storeGitHubToken(request.user!.id, body.token.trim());
    return { connected: true, ...result };
  });

  app.delete('/api/github/token', { preHandler: requireAuth }, async (request) => {
    await disconnectGitHub(request.user!.id);
    return { connected: false };
  });

  app.get('/api/github/organizations', { preHandler: requireAuth }, async (request) => {
    const accounts: { login: string; type: string; avatarUrl: string; installationId?: string }[] = [];
    const seen = new Set<string>();

    // 1. Fetch from App installations
    const installations = await listUserInstallations(request.user!.id);
    for (const inst of installations) {
      if (!seen.has(inst.accountLogin.toLowerCase())) {
        seen.add(inst.accountLogin.toLowerCase());
        accounts.push({
          login: inst.accountLogin,
          type: inst.accountType,
          avatarUrl: inst.accountAvatar ?? '',
          installationId: inst.installationId,
        });
      }
    }

    // 2. Fetch from User OAuth/PAT token if present
    try {
      const github = await githubClientForUser(request.user!.id);
      const [orgs, user] = await Promise.all([github.listOrganizations().catch(() => []), github.getUser().catch(() => null)]);
      if (user && !seen.has(user.login.toLowerCase())) {
        seen.add(user.login.toLowerCase());
        accounts.push({ login: user.login, type: 'User', avatarUrl: user.avatar_url });
      }
      for (const org of orgs) {
        if (!seen.has(org.login.toLowerCase())) {
          seen.add(org.login.toLowerCase());
          accounts.push({ login: org.login, type: 'Organization', avatarUrl: org.avatar_url });
        }
      }
    } catch {
      // Ignored if user only has App installations
    }

    return { accounts };
  });

  app.get('/api/github/repositories', { preHandler: requireAuth }, async (request) => {
    const query = z
      .object({
        owner: z.string().optional(),
        search: z.string().optional(),
        installationId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(300).default(100),
      })
      .parse(request.query);

    const userInstallations = await listUserInstallations(request.user!.id);
    const reposMap = new Map<string, GitHubRepo & { installationId?: string }>();

    // 1. Fetch repos from GitHub App installations
    for (const inst of userInstallations) {
      if (query.installationId && query.installationId !== inst.installationId) continue;
      try {
        const instClient = await githubClientForInstallation(inst.installationId);
        const instRepos = await instClient.listInstallationRepositories();
        for (const repo of instRepos) {
          reposMap.set(repo.full_name.toLowerCase(), { ...repo, installationId: inst.installationId });
        }
      } catch (err) {
        request.log.warn({ err, installationId: inst.installationId }, 'Failed to list installation repos');
      }
    }

    // 2. Fetch repos from User token if present
    try {
      const userClient = await githubClientForUser(request.user!.id);
      const userRepos = await userClient.listRepositories();
      for (const repo of userRepos) {
        if (!reposMap.has(repo.full_name.toLowerCase())) {
          reposMap.set(repo.full_name.toLowerCase(), repo);
        }
      }
    } catch {
      // Ignored if user only has App installations
    }

    let repos = Array.from(reposMap.values());

    if (query.owner) repos = repos.filter((r) => r.owner.login.toLowerCase() === query.owner!.toLowerCase());
    if (query.search) {
      const needle = query.search.toLowerCase();
      repos = repos.filter((r) => r.full_name.toLowerCase().includes(needle));
    }

    const connected = await prisma.repository.findMany({
      where: { userId: request.user!.id },
      select: { id: true, fullName: true },
    });
    const connectedByName = new Map(connected.map((r) => [r.fullName, r.id]));

    return {
      repositories: repos.slice(0, query.limit).map((repo) => ({
        githubId: String(repo.id),
        name: repo.name,
        owner: repo.owner.login,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch,
        sizeKb: repo.size,
        language: repo.language,
        stars: repo.stargazers_count,
        archived: repo.archived,
        pushedAt: repo.pushed_at,
        installationId: repo.installationId ?? null,
        connectedRepositoryId: connectedByName.get(repo.full_name) ?? null,
      })),
    };
  });

  /** Pre-import preview: languages, size and branches before any indexing happens. */
  app.get('/api/github/repositories/:owner/:name/preview', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ owner: z.string().min(1), name: z.string().min(1) }).parse(request.params);
    const query = z.object({ installationId: z.string().optional() }).parse(request.query);

    const github = query.installationId
      ? await githubClientForInstallation(query.installationId)
      : await githubClientForUser(request.user!.id);

    const [repo, languages, branches] = await Promise.all([
      github.getRepository(params.owner, params.name),
      github.getLanguages(params.owner, params.name).catch(() => ({}) as Record<string, number>),
      github.listBranches(params.owner, params.name).catch(() => []),
    ]);

    const totalBytes = Object.values(languages).reduce((sum, value) => sum + value, 0) || 1;

    return {
      repository: {
        githubId: String(repo.id),
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch,
        sizeKb: repo.size,
        archived: repo.archived,
        permissions: repo.permissions ?? null,
      },
      languages: Object.entries(languages)
        .map(([language, bytes]) => ({
          language,
          bytes,
          percent: Math.round((bytes / totalBytes) * 1000) / 10,
        }))
        .sort((a, b) => b.bytes - a.bytes),
      branches: branches.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
        protected: branch.protected,
        isDefault: branch.name === repo.default_branch,
      })),
      limits: {
        maxFiles: env.MAX_REPO_FILES,
        maxFileBytes: env.MAX_FILE_BYTES,
        maxTotalBytes: env.MAX_TOTAL_BYTES,
      },
    };
  });

  app.get('/api/github/rate-limit', { preHandler: requireAuth }, async (request) => {
    const github = await githubClientForUser(request.user!.id);
    await github.getUser().catch(() => null);
    return { rateLimit: github.rateLimit };
  });
}
