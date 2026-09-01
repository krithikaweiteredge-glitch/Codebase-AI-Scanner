import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exportDocumentationMarkdown, generateDocumentation } from '../analyzers/documentation';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { badRequest, notFound } from '../errors';
import { normaliseStackProfile, type StackProfile } from '../indexer/projectMap';
import { loadRepository, resolveBranch } from '../lib/access';
import { DOCUMENTATION_SECTIONS } from '../prompts/documentation';

const idParam = z.object({ id: z.string().uuid() });

export async function documentationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/repositories/:id/documentation', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const docs = await prisma.documentation.findMany({
      where: { repositoryId: id },
      orderBy: { position: 'asc' },
    });
    return {
      sections: docs.map((doc) => ({
        id: doc.id,
        section: doc.section,
        title: doc.title,
        contentMd: doc.contentMd,
        sources: doc.sources,
        updatedAt: doc.updatedAt,
      })),
      availableSections: DOCUMENTATION_SECTIONS,
    };
  });

  app.post('/api/repositories/:id/documentation/generate', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const body = z
      .object({
        branch: z.string().optional(),
        sections: z.array(z.enum(DOCUMENTATION_SECTIONS)).max(20).optional(),
      })
      .parse(request.body ?? {});

    const branch = await resolveBranch(id, body.branch);
    const insight = await prisma.repositoryInsight.findUnique({
      where: { repositoryId_kind: { repositoryId: id, kind: 'stack' } },
    });
    if (!insight) throw badRequest('Index this repository before generating documentation.');

    const sections = await generateDocumentation({
      repositoryId: id,
      branchId: branch.id,
      repositoryName: repository.fullName,
      stack: normaliseStackProfile(insight.data),
      ...(body.sections ? { sections: body.sections } : {}),
    });

    return { sections: sections.map((s) => ({ section: s.section, title: s.title, generatedBy: s.generatedBy })) };
  });

  app.get('/api/repositories/:id/documentation/export', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const markdown = await exportDocumentationMarkdown(id, repository.fullName);
    if (!markdown.trim()) throw notFound('No documentation has been generated for this repository yet');

    const filename = `${repository.name}-documentation.md`;
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(markdown);
  });

  app.get('/api/repositories/:id/architecture', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const insight = await prisma.repositoryInsight.findUnique({
      where: { repositoryId_kind: { repositoryId: id, kind: 'architecture' } },
    });
    if (!insight) throw notFound('Architecture analysis has not been generated yet. Run an analysis first.');
    return { architecture: insight.data, updatedAt: insight.updatedAt };
  });
}
