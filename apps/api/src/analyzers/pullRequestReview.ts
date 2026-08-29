import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import { notFound } from '../errors';
import type { GitHubClient, GitHubPullFile } from '../github/client';
import type { StackProfile } from '../indexer/projectMap';
import {
  PR_REVIEW_SYSTEM_PROMPT,
  buildPRReviewPrompt,
  prReviewSchema,
  renderReviewMarkdown,
  type PullRequestReviewPayload,
} from '../prompts/pullRequestReview';
import { confidenceLabel, findingStatus } from '../prompts/shared';
import { buildRepositoryOverview } from '../search/context';
import { runStaticRules } from './static/rules';
import { persistFindings } from './engine';
import type { AnalysisFindingDraft, AnalyzableFile } from './types';

const MAX_DIFF_CHARS = 60_000;
const MAX_PATCH_PER_FILE = 12_000;

export interface SyncedPullRequest {
  id: string;
  number: number;
  title: string;
  files: GitHubPullFile[];
}

export async function syncPullRequests(
  github: GitHubClient,
  repository: { id: string; owner: string; name: string },
  state = 'open',
): Promise<number> {
  const pulls = await github.listPullRequests(repository.owner, repository.name, state);

  for (const pull of pulls) {
    await prisma.pullRequest.upsert({
      where: { repositoryId_number: { repositoryId: repository.id, number: pull.number } },
      create: {
        repositoryId: repository.id,
        number: pull.number,
        title: pull.title,
        body: pull.body ?? null,
        state: pull.merged_at ? 'merged' : pull.state,
        authorLogin: pull.user?.login ?? null,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        baseSha: pull.base.sha,
        url: pull.html_url,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changed_files ?? 0,
        draft: pull.draft,
        ghCreatedAt: new Date(pull.created_at),
        ghUpdatedAt: new Date(pull.updated_at),
      },
      update: {
        title: pull.title,
        body: pull.body ?? null,
        state: pull.merged_at ? 'merged' : pull.state,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changed_files ?? 0,
        draft: pull.draft,
        ghUpdatedAt: new Date(pull.updated_at),
      },
    });
  }

  return pulls.length;
}

export interface ReviewResult {
  reviewId: string;
  verdict: PullRequestReviewPayload['verdict'];
  summary: string;
  findings: AnalysisFindingDraft[];
  counts: Record<string, number>;
  testGaps: string[];
  breakingChanges: string[];
  generatedBy: 'ai' | 'deterministic';
  markdown: string;
  rejectedFindings: number;
}

export async function reviewPullRequest(params: {
  github: GitHubClient;
  repository: { id: string; owner: string; name: string; fullName: string };
  branchId: string;
  stack: StackProfile;
  pullNumber: number;
}): Promise<ReviewResult> {
  const { github, repository } = params;

  const pull = await github.getPullRequest(repository.owner, repository.name, params.pullNumber);
  const files = await github.listPullRequestFiles(repository.owner, repository.name, params.pullNumber);

  const record = await prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId: repository.id, number: pull.number } },
    create: {
      repositoryId: repository.id,
      number: pull.number,
      title: pull.title,
      body: pull.body ?? null,
      state: pull.merged_at ? 'merged' : pull.state,
      authorLogin: pull.user?.login ?? null,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      url: pull.html_url,
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? files.length,
      draft: pull.draft,
      ghCreatedAt: new Date(pull.created_at),
      ghUpdatedAt: new Date(pull.updated_at),
    },
    update: {
      title: pull.title,
      body: pull.body ?? null,
      state: pull.merged_at ? 'merged' : pull.state,
      headSha: pull.head.sha,
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? files.length,
      ghUpdatedAt: new Date(pull.updated_at),
    },
  });

  // ---- deterministic pass over the added lines ---------------------------
  const staticFindings = analyseDiffStatically(files);

  // ---- context from the indexed branch ----------------------------------
  const changedPaths = files.map((f) => f.filename);
  const related = await prisma.repositoryFile.findMany({
    where: { branchId: params.branchId, path: { in: changedPaths } },
    select: { path: true, content: true, lineCount: true },
    take: 20,
  });

  const relatedContext = related
    .map((file) => {
      const body = (file.content ?? '').split('\n').slice(0, 160).join('\n');
      return `--- ${file.path} (indexed base version, first 160 of ${file.lineCount} lines) ---\n${body}`;
    })
    .join('\n\n')
    .slice(0, 30_000);

  const testFiles = await findRelatedTests(params.branchId, changedPaths);

  const diff = buildDiffText(files);

  let payload: PullRequestReviewPayload | null = null;
  let generatedBy: ReviewResult['generatedBy'] = 'deterministic';
  let rejected = 0;

  if (aiEnabled()) {
    try {
      const { data } = await generateStructured({
        system: PR_REVIEW_SYSTEM_PROMPT,
        user: buildPRReviewPrompt({
          repositoryName: repository.fullName,
          prNumber: pull.number,
          title: pull.title,
          body: pull.body ?? '',
          overview: buildRepositoryOverview(params.stack, { maxRoutes: 20, maxDirectories: 15 }),
          diff,
          relatedContext,
          existingTests: testFiles,
        }),
        schema: prReviewSchema,
        task: 'pull-request-review',
        maxTokens: env.AI_MAX_OUTPUT_TOKENS,
      });

      // Findings must point at files the PR actually touches.
      const changedSet = new Set(changedPaths);
      const kept = data.findings.filter((finding) => {
        const match = changedSet.has(finding.filePath) || changedPaths.some((p) => p.endsWith(finding.filePath));
        if (!match) rejected++;
        return match;
      });

      payload = { ...data, findings: kept };
      generatedBy = 'ai';
    } catch (error) {
      if (!(error instanceof AIGenerationUnavailable)) throw error;
    }
  }

  const aiDrafts: AnalysisFindingDraft[] =
    payload?.findings.map((finding) => ({
      category: finding.category,
      ruleId: `ai.pr.${finding.type}`.slice(0, 80),
      type: finding.type,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
      filePath: finding.filePath,
      startLine: finding.startLine,
      endLine: finding.endLine ?? finding.startLine,
      confidence: finding.confidence,
      confidenceLabel: confidenceLabel(finding.confidence),
      status: findingStatus('ai', finding.confidence),
      source: 'ai' as const,
      metadata: { detector: 'ai-pr-review', pullRequest: pull.number },
    })) ?? [];

  const allFindings = [...staticFindings, ...aiDrafts];
  const counts = countSeverities(allFindings);

  const verdict: PullRequestReviewPayload['verdict'] =
    payload?.verdict ??
    (counts.critical || counts.high ? 'request_changes' : counts.medium ? 'comment' : 'approve');

  const summary =
    payload?.summary ??
    buildDeterministicSummary(files, staticFindings, counts, testFiles.length > 0);

  const review = await prisma.pullRequestReview.create({
    data: {
      pullRequestId: record.id,
      status: verdict,
      verdict: verdict === 'request_changes' ? 'Needs Changes' : verdict === 'approve' ? 'Approved' : 'Comment',
      summary,
      counts: counts as unknown as Prisma.InputJsonValue,
      model: generatedBy === 'ai' ? env.AI_MODEL : null,
      provider: generatedBy === 'ai' ? env.AI_PROVIDER : 'static',
    },
  });

  await persistFindings(repository.id, null, params.branchId, allFindings, review.id);

  const markdownPayload: PullRequestReviewPayload = {
    verdict,
    summary,
    breakingChanges: payload?.breakingChanges ?? [],
    testGaps: payload?.testGaps ?? deterministicTestGaps(files, testFiles),
    findings: allFindings.map((finding) => ({
      category: finding.category === 'duplicate' ? 'quality' : (finding.category as 'security' | 'bug' | 'performance' | 'quality' | 'test'),
      type: finding.type,
      title: finding.title,
      description: finding.description,
      filePath: finding.filePath,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      confidence: finding.confidence,
      evidence: finding.evidence ?? '',
      recommendation: finding.recommendation ?? '',
    })),
  };

  return {
    reviewId: review.id,
    verdict,
    summary,
    findings: allFindings,
    counts,
    testGaps: markdownPayload.testGaps,
    breakingChanges: markdownPayload.breakingChanges,
    generatedBy,
    markdown: renderReviewMarkdown(markdownPayload, repository.fullName),
    rejectedFindings: rejected,
  };
}

/**
 * Run the deterministic rule set over the lines the PR adds.
 *
 * Added lines are reconstructed at their real position in the new file (gaps
 * padded with blank lines) so reported line numbers match GitHub exactly.
 */
export function analyseDiffStatically(files: readonly GitHubPullFile[]): AnalysisFindingDraft[] {
  const findings: AnalysisFindingDraft[] = [];

  for (const file of files) {
    if (!file.patch || file.status === 'removed') continue;
    const { content, addedLines } = reconstructAddedLines(file.patch);
    if (!addedLines.size) continue;

    const analyzable: AnalyzableFile = {
      id: `pr:${file.filename}`,
      path: file.filename,
      language: languageOf(file.filename),
      role: 'unknown',
      content,
      lineCount: content.split('\n').length,
      isTest: /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(file.filename),
      isConfig: false,
      isGenerated: false,
    };

    for (const finding of runStaticRules(analyzable)) {
      // Only report on lines this PR introduced.
      if (!addedLines.has(finding.startLine)) continue;
      findings.push({
        ...finding,
        metadata: { ...(finding.metadata ?? {}), detector: 'static-rule-on-diff' },
      });
    }
  }

  return findings;
}

function reconstructAddedLines(patch: string): { content: string; addedLines: Set<number> } {
  const lines: string[] = [];
  const added = new Set<number>();
  let newLine = 0;

  for (const raw of patch.slice(0, MAX_PATCH_PER_FILE).split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;

    const isAdded = raw.startsWith('+');
    const text = raw.slice(1);
    while (lines.length < newLine - 1) lines.push('');
    lines[newLine - 1] = text;
    if (isAdded) added.add(newLine);
    newLine++;
  }

  return { content: lines.join('\n'), addedLines: added };
}

function buildDiffText(files: readonly GitHubPullFile[]): string {
  const parts: string[] = [];
  let budget = MAX_DIFF_CHARS;

  for (const file of files) {
    const header = `diff --git a/${file.filename} b/${file.filename}\nstatus: ${file.status} (+${file.additions} -${file.deletions})`;
    const patch = file.patch ? file.patch.slice(0, MAX_PATCH_PER_FILE) : '(binary or patch unavailable)';
    const block = `${header}\n${patch}`;
    if (block.length > budget) {
      parts.push(`${header}\n(patch omitted - diff budget exhausted)`);
      budget = 0;
      continue;
    }
    budget -= block.length;
    parts.push(block);
  }

  return parts.join('\n\n');
}

async function findRelatedTests(branchId: string, changedPaths: readonly string[]): Promise<string> {
  const basenames = changedPaths
    .map((path) => path.split('/').pop()?.replace(/\.[^.]+$/, ''))
    .filter((name): name is string => Boolean(name && name.length > 2))
    .slice(0, 12);

  if (!basenames.length) return '';

  const tests = await prisma.repositoryFile.findMany({
    where: { branchId, isTest: true, OR: basenames.map((name) => ({ content: { contains: name } })) },
    select: { path: true, content: true },
    take: 4,
  });

  return tests
    .map((test) => `--- ${test.path} ---\n${(test.content ?? '').slice(0, 3000)}`)
    .join('\n\n')
    .slice(0, 12_000);
}

function deterministicTestGaps(files: readonly GitHubPullFile[], existingTests: string): string[] {
  const touchedSource = files.filter(
    (f) => !/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(f.filename) && f.additions > 0,
  );
  const touchedTests = files.filter((f) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(f.filename));

  const gaps: string[] = [];
  if (touchedSource.length && !touchedTests.length) {
    gaps.push(
      `${touchedSource.length} source file(s) changed with no test files touched: ${touchedSource
        .slice(0, 5)
        .map((f) => f.filename)
        .join(', ')}.`,
    );
  }
  if (!existingTests) {
    gaps.push('No existing tests were found that reference the changed modules.');
  }
  return gaps;
}

function buildDeterministicSummary(
  files: readonly GitHubPullFile[],
  staticFindings: readonly AnalysisFindingDraft[],
  counts: Record<string, number>,
  hasTests: boolean,
): string {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const lines = [
    `**Static review only** — no generative AI provider is configured (\`AI_PROVIDER=local\`), so this review reports ` +
      'deterministic rule matches on the added lines and diff statistics. No behaviour was inferred.',
    '',
    `${files.length} file(s) changed, +${additions} / -${deletions} lines.`,
    '',
    staticFindings.length
      ? `${staticFindings.length} rule match(es) on added lines: ${Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([severity, count]) => `${count} ${severity}`)
          .join(', ')}.`
      : 'No static rule matched the added lines.',
  ];

  if (!hasTests) lines.push('', 'No existing tests referencing the changed modules were found in the index.');
  return lines.join('\n');
}

function countSeverities(findings: readonly AnalysisFindingDraft[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
}

function languageOf(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.'));
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.go': 'go',
    '.java': 'java',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.rs': 'rust',
    '.sql': 'sql',
  };
  return map[ext] ?? 'unknown';
}

/** Posting to GitHub happens only from an endpoint that requires explicit confirmation. */
export async function postReviewToGitHub(params: {
  github: GitHubClient;
  repository: { owner: string; name: string };
  pullNumber: number;
  reviewId: string;
  markdown: string;
}): Promise<{ url: string }> {
  const review = await prisma.pullRequestReview.findUnique({ where: { id: params.reviewId } });
  if (!review) throw notFound('Review not found');

  const comment = await params.github.createIssueComment(
    params.repository.owner,
    params.repository.name,
    params.pullNumber,
    params.markdown,
  );

  await prisma.pullRequestReview.update({
    where: { id: params.reviewId },
    data: { postedToGithub: true, githubCommentUrl: comment.html_url, postedAt: new Date() },
  });

  return { url: comment.html_url };
}
