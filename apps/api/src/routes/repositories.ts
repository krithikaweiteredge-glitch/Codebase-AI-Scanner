import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDependencyGraphView } from '../analyzers/architecture';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { env } from '../env';
import { badRequest, conflict, notFound } from '../errors';
import { githubClientForUser } from '../github/service';
import { DEFAULT_IGNORE_PATTERNS } from '../indexer/ignore';
import type { StackProfile } from '../indexer/projectMap';
import { enqueueAnalysis } from '../jobs/analysisJob';
import { loadRepository, resolveBranch } from '../lib/access';
import { grepFiles, findSymbols, hybridSearch } from '../search/hybrid';
import { buildCodeContext } from '../search/context';

const idParam = z.object({ id: z.string().uuid() });

export async function repositoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ---------------------------------------------------------------- connect
  app.post('/api/repositories', async (request, reply) => {
    const body = z
      .object({
        owner: z.string().min(1),
        name: z.string().min(1),
        branch: z.string().min(1).optional(),
        installationId: z.string().optional(),
      })
      .parse(request.body);

    const github = await githubClientForUser(request.user!.id, body.installationId);
    const repo = await github.getRepository(body.owner, body.name);

    const existing = await prisma.repository.findUnique({
      where: { userId_fullName: { userId: request.user!.id, fullName: repo.full_name } },
    });
    if (existing) throw conflict(`${repo.full_name} is already connected`);

    const languages = await github.getLanguages(repo.owner.login, repo.name).catch(() => ({}));
    const branches = await github.listBranches(repo.owner.login, repo.name).catch(() => []);

    const created = await prisma.repository.create({
      data: {
        userId: request.user!.id,
        githubId: String(repo.id),
        installationId: body.installationId ?? null,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        htmlUrl: repo.html_url,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        sizeKb: repo.size,
        primaryLanguage: repo.language,
        languageStats: Object.entries(languages).map(([language, bytes]) => ({ language, bytes })),
        branches: {
          create: branches.slice(0, 100).map((branch) => ({
            name: branch.name,
            commitSha: branch.commit.sha,
            isDefault: branch.name === repo.default_branch,
          })),
        },
      },
      include: { branches: true },
    });

    return reply.code(201).send({
      repository: serialiseRepository(created),
      branches: created.branches.map((b) => ({ name: b.name, sha: b.commitSha, isDefault: b.isDefault })),
      selectedBranch: body.branch ?? repo.default_branch,
    });
  });

  // ------------------------------------------------------------------- list
  app.get('/api/repositories', async (request) => {
    const repositories = await prisma.repository.findMany({
      where: { userId: request.user!.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        branches: { where: { indexedSha: { not: null } }, orderBy: { indexedAt: 'desc' }, take: 1 },
        _count: { select: { files: true, findings: true } },
      },
    });

    return {
      repositories: repositories.map((repository) => ({
        ...serialiseRepository(repository),
        indexedBranch: repository.branches[0]?.name ?? null,
        indexedAt: repository.branches[0]?.indexedAt ?? null,
        fileCount: repository._count.files,
        findingCount: repository._count.findings,
      })),
    };
  });

  // ----------------------------------------------------------------- detail
  app.get('/api/repositories/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);

    const [branches, latestRun, insights] = await Promise.all([
      prisma.repositoryBranch.findMany({ where: { repositoryId: id }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
      prisma.analysisRun.findFirst({ where: { repositoryId: id }, orderBy: { createdAt: 'desc' } }),
      prisma.repositoryInsight.findMany({ where: { repositoryId: id } }),
    ]);

    return {
      repository: serialiseRepository(repository),
      branches: branches.map((branch) => ({
        name: branch.name,
        sha: branch.commitSha,
        isDefault: branch.isDefault,
        indexedSha: branch.indexedSha,
        indexedAt: branch.indexedAt,
      })),
      latestRun: latestRun ? serialiseRun(latestRun) : null,
      insightKinds: insights.map((insight) => insight.kind),
      ignorePatterns: repository.ignorePatterns,
      defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS,
    };
  });

  app.patch('/api/repositories/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const body = z.object({ ignorePatterns: z.array(z.string().max(200)).max(200) }).parse(request.body);

    const updated = await prisma.repository.update({
      where: { id },
      data: { ignorePatterns: body.ignorePatterns },
    });
    return { repository: serialiseRepository(updated) };
  });

  app.delete('/api/repositories/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    await prisma.repository.delete({ where: { id } });
    return { deleted: true };
  });

  // ---------------------------------------------------------------- analyse
  app.post('/api/repositories/:id/analyze', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const body = z
      .object({
        branch: z.string().min(1).optional(),
        incremental: z.boolean().default(true),
        generateDocs: z.boolean().default(true),
      })
      .parse(request.body ?? {});

    const active = await prisma.analysisRun.findFirst({
      where: { repositoryId: id, status: { in: ['queued', 'running'] } },
    });
    if (active) throw conflict('An analysis is already running for this repository');

    const branchName = body.branch ?? repository.defaultBranch;
    const branch = await prisma.repositoryBranch.findUnique({
      where: { repositoryId_name: { repositoryId: id, name: branchName } },
    });

    const run = await prisma.analysisRun.create({
      data: {
        repositoryId: id,
        branchId: branch?.id ?? null,
        kind: body.incremental && branch?.indexedSha ? 'incremental' : 'full',
        status: 'queued',
        aiProvider: env.AI_PROVIDER,
        aiModel: env.AI_MODEL,
      },
    });

    await enqueueAnalysis({
      runId: run.id,
      repositoryId: id,
      userId: request.user!.id,
      branchName,
      incremental: body.incremental && Boolean(branch?.indexedSha),
      generateDocs: body.generateDocs,
    });

    return reply.code(202).send({ run: serialiseRun(run), branch: branchName });
  });

  app.get('/api/repositories/:id/analysis', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const run = await prisma.analysisRun.findFirst({ where: { repositoryId: id }, orderBy: { createdAt: 'desc' } });
    if (!run) return { run: null };
    return { run: serialiseRun(run) };
  });

  app.get('/api/repositories/:id/runs', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const runs = await prisma.analysisRun.findMany({
      where: { repositoryId: id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    return { runs: runs.map(serialiseRun) };
  });

  app.get('/api/repositories/:id/runs/:runId', async (request) => {
    const params = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(request.params);
    await loadRepository(request.user!.id, params.id);
    const run = await prisma.analysisRun.findFirst({ where: { id: params.runId, repositoryId: params.id } });
    if (!run) throw notFound('Analysis run not found');

    const findings = await prisma.analysisFinding.groupBy({
      by: ['category', 'severity'],
      where: { runId: run.id },
      _count: { _all: true },
    });

    return {
      run: serialiseRun(run),
      findingCounts: findings.map((f) => ({ category: f.category, severity: f.severity, count: f._count._all })),
    };
  });

  // ------------------------------------------------------------------ files
  app.get('/api/repositories/:id/files', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const query = z.object({ branch: z.string().optional(), prefix: z.string().optional() }).parse(request.query);
    const branch = await resolveBranch(id, query.branch);

    const files = await prisma.repositoryFile.findMany({
      where: { branchId: branch.id, ...(query.prefix ? { path: { startsWith: query.prefix } } : {}) },
      select: {
        id: true,
        path: true,
        name: true,
        language: true,
        role: true,
        sizeBytes: true,
        lineCount: true,
        isTest: true,
        isConfig: true,
        hasSecrets: true,
        complexity: true,
      },
      orderBy: { path: 'asc' },
    });

    return { branch: branch.name, indexedAt: branch.indexedAt, files };
  });

  app.get('/api/repositories/:id/files/:fileId', async (request) => {
    const params = z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(request.params);
    await loadRepository(request.user!.id, params.id);

    const file = await prisma.repositoryFile.findFirst({
      where: { id: params.fileId, repositoryId: params.id },
      include: {
        symbols: { orderBy: { startLine: 'asc' } },
        outgoingDeps: { include: { toFile: { select: { id: true, path: true } } } },
        incomingDeps: { include: { fromFile: { select: { id: true, path: true } } } },
      },
    });
    if (!file) throw notFound('File not found');

    const findings = await prisma.analysisFinding.findMany({
      where: { fileId: file.id, falsePositive: false },
      orderBy: [{ severity: 'asc' }, { startLine: 'asc' }],
      take: 100,
    });

    return {
      file: {
        id: file.id,
        path: file.path,
        name: file.name,
        language: file.language,
        role: file.role,
        content: file.content,
        lineCount: file.lineCount,
        sizeBytes: file.sizeBytes,
        isTest: file.isTest,
        isConfig: file.isConfig,
        isGenerated: file.isGenerated,
        hasSecrets: file.hasSecrets,
        complexity: file.complexity,
        blobSha: file.blobSha,
      },
      symbols: file.symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        signature: symbol.signature,
        exported: symbol.exported,
        complexity: symbol.complexity,
        parentName: symbol.parentName,
      })),
      imports: file.outgoingDeps.map((dep) => ({
        specifier: dep.specifier,
        isExternal: dep.isExternal,
        target: dep.toFile ? { id: dep.toFile.id, path: dep.toFile.path } : null,
      })),
      importedBy: file.incomingDeps.map((dep) => ({ id: dep.fromFile.id, path: dep.fromFile.path })),
      findings,
    };
  });

  // ----------------------------------------------------------------- search
  app.get('/api/repositories/:id/search', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const query = z
      .object({
        q: z.string().min(1).max(500),
        branch: z.string().optional(),
        mode: z.enum(['hybrid', 'text', 'symbol']).default('hybrid'),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);

    const branch = await resolveBranch(id, query.branch);
    if (!branch.indexedSha) throw badRequest('This branch has not been indexed yet. Run an analysis first.');

    if (query.mode === 'text') {
      return { mode: 'text', matches: await grepFiles(id, branch.id, query.q, query.limit * 5) };
    }
    if (query.mode === 'symbol') {
      return { mode: 'symbol', symbols: await findSymbols(id, branch.id, query.q, query.limit) };
    }

    const outcome = await hybridSearch({
      repositoryId: id,
      branchId: branch.id,
      query: query.q,
      limit: query.limit,
    });
    const context = buildCodeContext(outcome.results, env.CONTEXT_TOKEN_BUDGET);

    return {
      mode: 'hybrid',
      repository: repository.fullName,
      branch: branch.name,
      understood: outcome.understood,
      retrievers: outcome.retrievers,
      results: outcome.results.map((result) => ({
        chunkId: result.id,
        fileId: result.fileId,
        filePath: result.filePath,
        language: result.language,
        role: result.role,
        symbolName: result.symbolName,
        symbolType: result.symbolType,
        startLine: result.startLine,
        endLine: result.endLine,
        score: Number(result.fusedScore.toFixed(6)),
        matchedBy: [...new Set(result.matchedBy)],
        snippet: result.content.split('\n').slice(0, 20).join('\n'),
      })),
      contextPreview: { tokens: context.tokensUsed, included: context.chunksIncluded, redactions: context.redactions },
    };
  });

  app.get('/api/repositories/:id/symbols', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const query = z
      .object({ q: z.string().min(1).max(200), branch: z.string().optional(), limit: z.coerce.number().int().max(100).default(30) })
      .parse(request.query);
    const branch = await resolveBranch(id, query.branch);
    return { symbols: await findSymbols(id, branch.id, query.q, query.limit) };
  });

  // ------------------------------------------------------------ dependencies
  app.get('/api/repositories/:id/dependencies', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const query = z.object({ branch: z.string().optional() }).parse(request.query);
    const branch = await resolveBranch(id, query.branch);
    const graph = await buildDependencyGraphView(id, branch.id);
    return { branch: branch.name, graph };
  });

  // --------------------------------------------------------------- insights
  app.get('/api/repositories/:id/insights/:kind', async (request) => {
    const params = z.object({ id: z.string().uuid(), kind: z.string().min(1).max(40) }).parse(request.params);
    await loadRepository(request.user!.id, params.id);
    const insight = await prisma.repositoryInsight.findUnique({
      where: { repositoryId_kind: { repositoryId: params.id, kind: params.kind } },
    });
    if (!insight) throw notFound(`No "${params.kind}" insight has been generated for this repository yet`);
    return { kind: insight.kind, data: insight.data, updatedAt: insight.updatedAt };
  });

  // -------------------------------------------------------------- dashboard
  app.get('/api/repositories/:id/dashboard', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const query = z.object({ branch: z.string().optional() }).parse(request.query);

    let branchId: string | null = null;
    let branchName: string | null = null;
    try {
      const branch = await resolveBranch(id, query.branch);
      branchId = branch.id;
      branchName = branch.name;
    } catch {
      branchId = null;
    }

    const [counts, scores, stack, latestRun, fileAggregate, commits] = await Promise.all([
      prisma.analysisFinding.groupBy({
        by: ['category', 'severity'],
        where: { repositoryId: id, falsePositive: false, reviewId: null },
        _count: { _all: true },
      }),
      prisma.repositoryInsight.findUnique({ where: { repositoryId_kind: { repositoryId: id, kind: 'scores' } } }),
      prisma.repositoryInsight.findUnique({ where: { repositoryId_kind: { repositoryId: id, kind: 'stack' } } }),
      prisma.analysisRun.findFirst({ where: { repositoryId: id }, orderBy: { createdAt: 'desc' } }),
      branchId
        ? prisma.repositoryFile.aggregate({
            where: { branchId },
            _count: { _all: true },
            _sum: { lineCount: true, sizeBytes: true },
          })
        : Promise.resolve(null),
      prisma.repositoryCommit.findMany({ where: { repositoryId: id }, orderBy: { committedAt: 'desc' }, take: 5 }),
    ]);

    const byCategory: Record<string, Record<string, number>> = {};
    for (const row of counts) {
      const bucket = (byCategory[row.category] ??= {});
      bucket[row.severity] = row._count._all;
      bucket.total = (bucket.total ?? 0) + row._count._all;
    }

    const stackData = stack?.data as unknown as StackProfile | undefined;

    return {
      repository: serialiseRepository(repository),
      branch: branchName,
      stats: {
        files: fileAggregate?._count._all ?? 0,
        lines: fileAggregate?._sum.lineCount ?? 0,
        bytes: fileAggregate?._sum.sizeBytes ?? 0,
        languages: stackData?.languages ?? [],
        frameworks: stackData?.frameworks?.map((f) => f.name) ?? [],
        routes: stackData?.routes?.length ?? 0,
        entryPoints: stackData?.entryPoints ?? [],
        testFrameworks: stackData?.testFrameworks?.map((t) => t.name) ?? [],
      },
      findings: byCategory,
      scores: scores?.data ?? null,
      latestRun: latestRun ? serialiseRun(latestRun) : null,
      recentCommits: commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message?.split('\n')[0] ?? '',
        author: commit.authorName,
        committedAt: commit.committedAt,
      })),
    };
  });

  app.get('/api/repositories/:id/commits', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const commits = await prisma.repositoryCommit.findMany({
      where: { repositoryId: id },
      orderBy: { committedAt: 'desc' },
      take: 50,
    });
    return { commits };
  });
}

function serialiseRepository(repository: {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  sizeKb: number | null;
  primaryLanguage: string | null;
  languageStats: unknown;
  lastAnalyzedAt: Date | null;
  createdAt: Date;
  ignorePatterns: string[];
}) {
  return {
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    description: repository.description,
    htmlUrl: repository.htmlUrl,
    isPrivate: repository.isPrivate,
    defaultBranch: repository.defaultBranch,
    sizeKb: repository.sizeKb,
    primaryLanguage: repository.primaryLanguage,
    languageStats: repository.languageStats,
    lastAnalyzedAt: repository.lastAnalyzedAt,
    createdAt: repository.createdAt,
    ignorePatterns: repository.ignorePatterns,
  };
}

function serialiseRun(run: {
  id: string;
  repositoryId: string;
  branchId: string | null;
  commitSha: string | null;
  kind: string;
  status: string;
  steps: unknown;
  progress: number;
  stats: unknown;
  error: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    branchId: run.branchId,
    commitSha: run.commitSha,
    kind: run.kind,
    status: run.status,
    steps: run.steps,
    progress: run.progress,
    stats: run.stats,
    error: run.error,
    aiProvider: run.aiProvider,
    aiModel: run.aiModel,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}
