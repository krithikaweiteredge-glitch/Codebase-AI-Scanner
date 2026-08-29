import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { AI_DISCLAIMER } from '../prompts/shared';
import { forbidden, notFound } from '../errors';
import { loadRepository, resolveBranch } from '../lib/access';
import { askCodebase } from '../rag/chat';

const listQuery = z.object({
  branch: z.string().optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  search: z.string().max(200).optional(),
  includeFalsePositives: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export async function findingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const listFindings = async (
    userId: string,
    repositoryId: string,
    category: string | undefined,
    rawQuery: unknown,
  ) => {
    await loadRepository(userId, repositoryId);
    const query = listQuery.parse(rawQuery ?? {});

    const where = {
      repositoryId,
      reviewId: null,
      ...(category ? { category } : {}),
      ...(query.severity ? { severity: { in: query.severity.split(',') } } : {}),
      ...(query.status ? { status: { in: query.status.split(',') } } : {}),
      ...(query.source ? { source: { in: query.source.split(',') } } : {}),
      ...(query.includeFalsePositives ? {} : { falsePositive: false }),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' as const } },
              { filePath: { contains: query.search, mode: 'insensitive' as const } },
              { description: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [findings, total, severityCounts] = await Promise.all([
      prisma.analysisFinding.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      prisma.analysisFinding.count({ where }),
      prisma.analysisFinding.groupBy({
        by: ['severity'],
        where: { repositoryId, reviewId: null, ...(category ? { category } : {}), falsePositive: false },
        _count: { _all: true },
      }),
    ]);

    const sorted = [...findings].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        b.confidence - a.confidence ||
        a.filePath!.localeCompare(b.filePath ?? ''),
    );

    return {
      findings: sorted,
      total,
      counts: Object.fromEntries(severityCounts.map((row) => [row.severity, row._count._all])),
      disclaimer: AI_DISCLAIMER,
    };
  };

  app.get('/api/repositories/:id/findings', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = request.query as Record<string, unknown>;
    return listFindings(request.user!.id, id, typeof query.category === 'string' ? query.category : undefined, query);
  });

  for (const [path, category] of [
    ['security', 'security'],
    ['bugs', 'bug'],
    ['performance', 'performance'],
    ['duplicates', 'duplicate'],
    ['quality', 'quality'],
  ] as const) {
    app.get(`/api/repositories/:id/${path}`, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return listFindings(request.user!.id, id, category, request.query);
    });
  }

  app.get('/api/repositories/:id/findings/:findingId', async (request) => {
    const params = z.object({ id: z.string().uuid(), findingId: z.string().uuid() }).parse(request.params);
    await loadRepository(request.user!.id, params.id);

    const finding = await prisma.analysisFinding.findFirst({
      where: { id: params.findingId, repositoryId: params.id },
      include: { file: { select: { id: true, path: true, content: true, language: true, lineCount: true } } },
    });
    if (!finding) throw notFound('Finding not found');

    // Return a focused window of the real file so the UI can show the evidence.
    let excerpt: { startLine: number; endLine: number; text: string } | null = null;
    if (finding.file?.content && finding.startLine) {
      const lines = finding.file.content.split('\n');
      const start = Math.max(1, finding.startLine - 6);
      const end = Math.min(lines.length, (finding.endLine ?? finding.startLine) + 6);
      excerpt = { startLine: start, endLine: end, text: lines.slice(start - 1, end).join('\n') };
    }

    return { finding, excerpt, disclaimer: AI_DISCLAIMER };
  });

  app.patch('/api/repositories/:id/findings/:findingId', async (request) => {
    const params = z.object({ id: z.string().uuid(), findingId: z.string().uuid() }).parse(request.params);
    const body = z.object({ falsePositive: z.boolean().optional(), resolved: z.boolean().optional() }).parse(request.body);
    await loadRepository(request.user!.id, params.id);

    const existing = await prisma.analysisFinding.findFirst({
      where: { id: params.findingId, repositoryId: params.id },
    });
    if (!existing) throw notFound('Finding not found');

    const updated = await prisma.analysisFinding.update({
      where: { id: params.findingId },
      data: {
        ...(body.falsePositive === undefined ? {} : { falsePositive: body.falsePositive }),
        ...(body.resolved === undefined ? {} : { resolved: body.resolved }),
      },
    });
    return { finding: updated };
  });

  /** Explain a finding using the RAG pipeline, so the explanation is cited too. */
  app.post('/api/repositories/:id/findings/:findingId/explain', async (request) => {
    const params = z.object({ id: z.string().uuid(), findingId: z.string().uuid() }).parse(request.params);
    const repository = await loadRepository(request.user!.id, params.id);

    const finding = await prisma.analysisFinding.findFirst({
      where: { id: params.findingId, repositoryId: params.id },
    });
    if (!finding) throw notFound('Finding not found');

    const branch = await resolveBranch(params.id);
    const question =
      `Explain this ${finding.category} finding in detail: "${finding.title}" reported at ` +
      `${finding.filePath}:${finding.startLine}. What exactly does the code do there, why is it a problem, ` +
      `what is the concrete failure or attack scenario, and what is the minimal correct fix?`;

    const result = await askCodebase({
      repositoryId: params.id,
      branchId: branch.id,
      repositoryName: repository.fullName,
      branchName: branch.name,
      question,
      maxChunks: 10,
    });

    return { explanation: result.answer, citations: result.citations, sources: result.sources, degraded: result.degraded };
  });

  /** Cross-repository summary for the top-level dashboard. */
  app.get('/api/findings/summary', async (request) => {
    const repositories = await prisma.repository.findMany({
      where: { userId: request.user!.id },
      select: { id: true, fullName: true },
    });
    if (!repositories.length) return { repositories: [] };

    const counts = await prisma.analysisFinding.groupBy({
      by: ['repositoryId', 'category', 'severity'],
      where: { repositoryId: { in: repositories.map((r) => r.id) }, falsePositive: false, reviewId: null },
      _count: { _all: true },
    });

    return {
      repositories: repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        counts: counts
          .filter((row) => row.repositoryId === repository.id)
          .map((row) => ({ category: row.category, severity: row.severity, count: row._count._all })),
      })),
    };
  });

  app.get('/api/findings/:findingId/raw', async (request) => {
    const params = z.object({ findingId: z.string().uuid() }).parse(request.params);
    const finding = await prisma.analysisFinding.findUnique({
      where: { id: params.findingId },
      include: { repository: { select: { userId: true } } },
    });
    if (!finding) throw notFound('Finding not found');
    if (finding.repository.userId !== request.user!.id) throw forbidden();
    return { finding };
  });
}
