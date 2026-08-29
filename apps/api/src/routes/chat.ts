import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session';
import { prisma } from '../db';
import { notFound } from '../errors';
import { loadRepository, resolveBranch } from '../lib/access';
import { askCodebase, persistChatTurn } from '../rag/chat';

const idParam = z.object({ id: z.string().uuid() });

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/repositories/:id/chat/sessions', async (request) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);

    const sessions = await prisma.chatSession.findMany({
      where: { repositoryId: id, userId: request.user!.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { _count: { select: { messages: true } } },
    });

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        messageCount: session._count.messages,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
    };
  });

  app.post('/api/repositories/:id/chat/sessions', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await loadRepository(request.user!.id, id);
    const body = z.object({ title: z.string().max(160).optional() }).parse(request.body ?? {});

    const session = await prisma.chatSession.create({
      data: { repositoryId: id, userId: request.user!.id, title: body.title ?? 'New conversation' },
    });
    return reply.code(201).send({ session });
  });

  app.get('/api/repositories/:id/chat/sessions/:sessionId', async (request) => {
    const params = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    await loadRepository(request.user!.id, params.id);

    const session = await prisma.chatSession.findFirst({
      where: { id: params.sessionId, repositoryId: params.id, userId: request.user!.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound('Conversation not found');

    return {
      session: { id: session.id, title: session.title, createdAt: session.createdAt },
      messages: session.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations,
        groundingScore: message.groundingScore,
        model: message.model,
        provider: message.provider,
        latencyMs: message.latencyMs,
        createdAt: message.createdAt,
      })),
    };
  });

  app.delete('/api/repositories/:id/chat/sessions/:sessionId', async (request) => {
    const params = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    await loadRepository(request.user!.id, params.id);
    await prisma.chatSession.deleteMany({
      where: { id: params.sessionId, repositoryId: params.id, userId: request.user!.id },
    });
    return { deleted: true };
  });

  /**
   * Ask a question about the repository.
   *
   * `sessionId` is optional: without it the question is answered without being
   * persisted (used by the command palette and the "explain" affordances).
   */
  app.post('/api/repositories/:id/chat', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const body = z
      .object({
        question: z.string().min(2).max(2000),
        sessionId: z.string().uuid().optional(),
        branch: z.string().optional(),
        persist: z.boolean().default(true),
        maxChunks: z.number().int().min(4).max(40).optional(),
      })
      .parse(request.body);

    const branch = await resolveBranch(id, body.branch);
    if (!branch.indexedSha) throw notFound('This branch has not been indexed yet. Run an analysis first.');

    let sessionId = body.sessionId;
    let history: { role: 'user' | 'assistant'; content: string }[] = [];

    if (sessionId) {
      const session = await prisma.chatSession.findFirst({
        where: { id: sessionId, repositoryId: id, userId: request.user!.id },
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 6 } },
      });
      if (!session) throw notFound('Conversation not found');
      history = session.messages
        .reverse()
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    } else if (body.persist) {
      const session = await prisma.chatSession.create({
        data: {
          repositoryId: id,
          userId: request.user!.id,
          title: body.question.slice(0, 80),
        },
      });
      sessionId = session.id;
    }

    const result = await askCodebase({
      repositoryId: id,
      branchId: branch.id,
      repositoryName: repository.fullName,
      branchName: branch.name,
      question: body.question,
      history,
      ...(body.maxChunks ? { maxChunks: body.maxChunks } : {}),
    });

    let messageIds: { userMessageId: string; assistantMessageId: string } | null = null;
    if (sessionId && body.persist) {
      messageIds = await persistChatTurn({ sessionId, question: body.question, result });
    }

    return {
      sessionId: sessionId ?? null,
      messageIds,
      answer: result.answer,
      citations: result.citations,
      invalidCitations: result.invalidCitations,
      sources: result.sources,
      groundingScore: result.groundingScore,
      answered: result.answered,
      followUps: result.followUps,
      retrieval: result.retrieval,
      usage: result.usage ?? null,
      degraded: result.degraded,
    };
  });

  /** Explain a specific file, symbol, or selected range - same grounded pipeline. */
  app.post('/api/repositories/:id/explain', async (request) => {
    const { id } = idParam.parse(request.params);
    const repository = await loadRepository(request.user!.id, id);
    const body = z
      .object({
        filePath: z.string().min(1),
        symbolName: z.string().max(200).optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        question: z.string().max(500).optional(),
        branch: z.string().optional(),
      })
      .parse(request.body);

    const branch = await resolveBranch(id, body.branch);

    const scope = body.symbolName
      ? `the ${body.symbolName} symbol in ${body.filePath}`
      : body.startLine
        ? `lines ${body.startLine}-${body.endLine ?? body.startLine} of ${body.filePath}`
        : `the file ${body.filePath}`;

    const question =
      body.question ??
      `Explain ${scope}: what it does, what calls it, what it depends on, and any risks or edge cases visible in the code.`;

    const result = await askCodebase({
      repositoryId: id,
      branchId: branch.id,
      repositoryName: repository.fullName,
      branchName: branch.name,
      question: `${question}\n\n(Focus on ${scope}.)`,
      maxChunks: 12,
    });

    return {
      answer: result.answer,
      citations: result.citations,
      sources: result.sources,
      groundingScore: result.groundingScore,
      degraded: result.degraded,
    };
  });
}
