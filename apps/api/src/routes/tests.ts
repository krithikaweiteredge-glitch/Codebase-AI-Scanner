import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTestSuggestions } from '../analyzers/tests';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { badRequest } from '../errors';
import { normaliseStackProfile } from '../indexer/projectMap';
import { loadRepository, resolveBranch } from '../lib/access';

const idParam = z.object({ id: z.string().uuid() });

export async function testRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/repositories/:id/tests/generate', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const body = z
      .object({
        filePath: z.string().min(1),
        symbolName: z.string().max(200).optional(),
        branch: z.string().optional(),
      })
      .parse(request.body);

    const branch = await resolveBranch(id, body.branch);
    const insight = await prisma.repositoryInsight.findUnique({
      where: { repositoryId_kind: { repositoryId: id, kind: 'stack' } },
    });
    if (!insight) throw badRequest('Index this repository before generating tests.');

    const result = await generateTestSuggestions({
      repositoryId: id,
      branchId: branch.id,
      repositoryName: repository.fullName,
      stack: normaliseStackProfile(insight.data),
      filePath: body.filePath,
      ...(body.symbolName ? { symbolName: body.symbolName } : {}),
    });

    return { suggestion: result };
  });

  app.get('/api/repositories/:id/tests', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const suggestions = await prisma.testSuggestion.findMany({
      where: { repositoryId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { suggestions };
  });

  /** Ranked list of what is worth testing, from complexity and missing coverage. */
  app.get('/api/repositories/:id/tests/candidates', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const query = z.object({ branch: z.string().optional(), limit: z.coerce.number().int().max(100).default(40) }).parse(request.query);
    const branch = await resolveBranch(id, query.branch);

    const symbols = await prisma.codeSymbol.findMany({
      where: {
        repositoryId: id,
        file: { branchId: branch.id, isTest: false, isGenerated: false },
        kind: { in: ['function', 'method', 'class'] },
        complexity: { gte: 4 },
      },
      include: { file: { select: { path: true, role: true, language: true } } },
      orderBy: { complexity: 'desc' },
      take: query.limit * 3,
    });

    const testFiles = await prisma.repositoryFile.findMany({
      where: { branchId: branch.id, isTest: true },
      select: { content: true },
    });
    const testCorpus = testFiles.map((f) => f.content ?? '').join('\n');

    const candidates = symbols
      .map((symbol) => {
        const mentioned = symbol.name.length > 3 && testCorpus.includes(symbol.name);
        const roleWeight = { service: 3, controller: 3, repository: 2, util: 2, route: 2, auth: 4 }[symbol.file.role ?? ''] ?? 1;
        return {
          symbolId: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          filePath: symbol.file.path,
          language: symbol.file.language,
          role: symbol.file.role,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          complexity: symbol.complexity,
          referencedInTests: mentioned,
          priority: Math.round(symbol.complexity * roleWeight * (mentioned ? 0.4 : 1)),
        };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, query.limit);

    return { branch: branch.name, candidates };
  });
}
