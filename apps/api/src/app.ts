import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authRoutes } from './auth/routes';
import { env, isProd, webOrigins } from './env';
import { AppError } from './errors';
import { registerJobs } from './jobs/analysisJob';
import { loggerOptions } from './logger';
import { chatRoutes } from './routes/chat';
import { documentationRoutes } from './routes/documentation';
import { findingRoutes } from './routes/findings';
import { githubRoutes } from './routes/github';
import { pullRequestRoutes } from './routes/pullRequests';
import { repositoryRoutes } from './routes/repositories';
import { systemRoutes } from './routes/system';
import { testRoutes } from './routes/tests';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
    bodyLimit: 2_000_000,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: webOrigins,
    credentials: true,
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: () => false,
    keyGenerator: (request) => request.ip,
  });

  // Tighter limit on the endpoints that cost money or hit GitHub hard.
  app.register(async (scoped) => {
    await scoped.register(rateLimit, { max: 60, timeWindow: '1 minute' });
    await scoped.register(chatRoutes);
  });

  // Structured request logging with user + repository context, no secrets.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        userId: request.user?.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request payload is invalid',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error, requestId: request.id }, error.message);
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'unhandled error');
    }

    return reply.code(statusCode).send({
      error: {
        code: (error as { code?: string }).code ?? 'INTERNAL_ERROR',
        // Internal details are never leaked in production.
        message:
          statusCode >= 500 && isProd
            ? 'An internal error occurred. The incident has been logged.'
            : ((error as Error).message ?? 'Unexpected error'),
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` } });
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(githubRoutes);
  await app.register(repositoryRoutes);
  await app.register(findingRoutes);
  await app.register(pullRequestRoutes);
  await app.register(testRoutes);
  await app.register(documentationRoutes);

  registerJobs();

  return app;
}
