import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { postReviewToGitHub, reviewPullRequest, syncPullRequests } from '../analyzers/pullRequestReview';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { badRequest, notFound } from '../errors';
import { githubClientForRepository } from '../github/service';
import type { StackProfile } from '../indexer/projectMap';
import { loadRepository, resolveBranch } from '../lib/access';
import { AI_DISCLAIMER } from '../prompts/shared';

const idParam = z.object({ id: z.string().uuid() });

async function loadStack(repositoryId: string): Promise<StackProfile> {
  const insight = await prisma.repositoryInsight.findUnique({
    where: { repositoryId_kind: { repositoryId, kind: 'stack' } },
  });
  if (!insight) {
    throw badRequest('Index this repository before reviewing pull requests - the review uses the indexed project map.');
  }
  return insight.data as unknown as StackProfile;
}

export async function pullRequestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/repositories/:id/pull-requests', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const query = z
      .object({ state: z.enum(['open', 'closed', 'all']).default('open'), refresh: z.coerce.boolean().default(false) })
      .parse(request.query);

    if (query.refresh) {
      const github = await githubClientForRepository(repository.id, request.user!.id);
      await syncPullRequests(github, repository, query.state);
    }

    const pulls = await prisma.pullRequest.findMany({
      where: { repositoryId: id, ...(query.state === 'all' ? {} : { state: query.state }) },
      orderBy: { ghUpdatedAt: 'desc' },
      take: 100,
      include: {
        reviews: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, verdict: true, createdAt: true, postedToGithub: true } },
      },
    });

    return {
      pullRequests: pulls.map((pull) => ({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        draft: pull.draft,
        author: pull.authorLogin,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        additions: pull.additions,
        deletions: pull.deletions,
        changedFiles: pull.changedFiles,
        url: pull.url,
        updatedAt: pull.ghUpdatedAt,
        latestReview: pull.reviews[0] ?? null,
      })),
    };
  });

  app.get('/api/repositories/:id/pull-requests/:number', async (request) => {
    const params = z.object({ id: z.string().uuid(), number: z.coerce.number().int().positive() }).parse(request.params);
    const repository = await loadRepository(request.user!.id, params.id);
    const github = await githubClientForRepository(repository.id, request.user!.id);

    const [pull, files, comments] = await Promise.all([
      github.getPullRequest(repository.owner, repository.name, params.number),
      github.listPullRequestFiles(repository.owner, repository.name, params.number),
      github.listPullRequestComments(repository.owner, repository.name, params.number).catch(() => []),
    ]);

    const record = await prisma.pullRequest.findUnique({
      where: { repositoryId_number: { repositoryId: params.id, number: params.number } },
      include: {
        reviews: {
          orderBy: { createdAt: 'desc' },
          include: { findings: { orderBy: { severity: 'asc' } } },
        },
      },
    });

    return {
      pullRequest: {
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        draft: pull.draft,
        author: pull.user?.login ?? null,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        url: pull.html_url,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changed_files ?? files.length,
      },
      files: files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
      })),
      comments: comments.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? null,
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
      })),
      reviews: record?.reviews ?? [],
    };
  });

  app.post('/api/repositories/:id/pull-requests/:number/review', async (request) => {
    const params = z.object({ id: z.string().uuid(), number: z.coerce.number().int().positive() }).parse(request.params);
    const repository = await loadRepository(request.user!.id, params.id);
    const branch = await resolveBranch(params.id);
    const stack = await loadStack(params.id);
    const github = await githubClientForRepository(repository.id, request.user!.id);

    const result = await reviewPullRequest({
      github,
      repository,
      branchId: branch.id,
      stack,
      pullNumber: params.number,
    });

    return {
      review: {
        id: result.reviewId,
        verdict: result.verdict,
        summary: result.summary,
        counts: result.counts,
        testGaps: result.testGaps,
        breakingChanges: result.breakingChanges,
        generatedBy: result.generatedBy,
        rejectedFindings: result.rejectedFindings,
        markdown: result.markdown,
      },
      findings: result.findings,
      disclaimer: AI_DISCLAIMER,
    };
  });

  /**
   * Posting a review to GitHub is an outward-facing action: it requires the
   * client to echo back the review id and an explicit confirm flag.
   */
  app.post('/api/repositories/:id/pull-requests/:number/review/:reviewId/post', async (request) => {
    const params = z
      .object({ id: z.string().uuid(), number: z.coerce.number().int().positive(), reviewId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ confirm: z.literal(true) }).parse(request.body);
    if (!body.confirm) throw badRequest('Explicit confirmation is required before posting to GitHub');

    const repository = await loadRepository(request.user!.id, params.id);

    const review = await prisma.pullRequestReview.findFirst({
      where: { id: params.reviewId, pullRequest: { repositoryId: params.id, number: params.number } },
      include: { findings: true, pullRequest: true },
    });
    if (!review) throw notFound('Review not found for this pull request');
    if (review.postedToGithub) {
      return { alreadyPosted: true, url: review.githubCommentUrl };
    }

    const github = await githubClientForRepository(repository.id, request.user!.id);
    const markdown = rebuildMarkdown(review, repository.fullName);

    const result = await postReviewToGitHub({
      github,
      repository,
      pullNumber: params.number,
      reviewId: review.id,
      markdown,
    });

    return { posted: true, url: result.url };
  });
}

function rebuildMarkdown(
  review: {
    verdict: string | null;
    summary: string;
    counts: unknown;
    findings: {
      severity: string;
      category: string;
      title: string;
      description: string;
      filePath: string | null;
      startLine: number | null;
      endLine: number | null;
      confidence: number;
      evidence: string | null;
      recommendation: string | null;
    }[];
  },
  repoLabel: string,
): string {
  const lines: string[] = ['## AI code review', '', `**Verdict:** ${review.verdict ?? 'Comment'}`, '', review.summary];

  if (review.findings.length) {
    lines.push('', '### Findings');
    for (const finding of review.findings) {
      lines.push('');
      lines.push(
        `**${finding.severity.toUpperCase()} · ${finding.category}** — ${finding.title}  \n` +
          `\`${finding.filePath}:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}\` ` +
          `(confidence ${Math.round(finding.confidence * 100)}%)`,
      );
      lines.push('', finding.description);
      if (finding.evidence) lines.push('', `_Evidence:_ ${finding.evidence}`);
      if (finding.recommendation) lines.push('', `_Suggested fix:_ ${finding.recommendation}`);
    }
  }

  lines.push('', '---', `Generated by the internal Codebase Intelligence platform for ${repoLabel}. ${AI_DISCLAIMER}`);
  return lines.join('\n');
}
