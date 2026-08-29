import type { FastifyInstance } from 'fastify';
import { getAIProvider } from '../ai/provider';
import { getEmbeddingProvider } from '../ai/embeddings';
import { prisma } from '../db';
import { env, githubOAuthConfigured } from '../env';
import { queueMode, getQueue } from '../jobs/queue';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    let database = 'ok';
    let pgvector = 'unknown';
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      const rows = await prisma.$queryRawUnsafe<{ installed: boolean }[]>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
      );
      pgvector = rows[0]?.installed ? 'installed' : 'missing';
    } catch (error) {
      database = `unavailable: ${(error as Error).message}`;
    }

    const ai = getAIProvider();
    const embeddings = getEmbeddingProvider();

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      pgvector,
      ai: { provider: ai.name, model: ai.model, generation: ai.supportsGeneration },
      embeddings: { provider: embeddings.name, model: embeddings.model, dimensions: embeddings.dimensions },
      github: { oauthConfigured: githubOAuthConfigured, apiUrl: env.GITHUB_API_URL },
      queue: { mode: queueMode(), pending: getQueue().size(), running: getQueue().running() },
      limits: {
        maxRepoFiles: env.MAX_REPO_FILES,
        maxFileBytes: env.MAX_FILE_BYTES,
        contextTokenBudget: env.CONTEXT_TOKEN_BUDGET,
      },
    };
  });

  /** Non-secret configuration the frontend needs to render the right affordances. */
  app.get('/api/config', async () => {
    const ai = getAIProvider();
    return {
      aiProvider: ai.name,
      aiModel: ai.model,
      aiGeneration: ai.supportsGeneration,
      embeddingProvider: getEmbeddingProvider().name,
      githubOAuthConfigured,
      contextTokenBudget: env.CONTEXT_TOKEN_BUDGET,
    };
  });
}
