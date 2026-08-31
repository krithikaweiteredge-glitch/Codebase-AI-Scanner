import { buildApp } from './app';
import { prisma } from './db';
import { env } from './env';
import { queueConfigurationWarning } from './jobs/queue';

async function main(): Promise<void> {
  const app = await buildApp();

  // A misconfigured queue has no symptom until an analysis silently never
  // starts, so it is worth being loud about at boot.
  const queueWarning = queueConfigurationWarning();
  if (queueWarning) app.log.error(queueWarning);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  try {
    await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
    app.log.info(
      {
        port: env.API_PORT,
        aiProvider: env.AI_PROVIDER,
        aiModel: env.AI_MODEL,
        embeddingProvider: env.EMBEDDING_PROVIDER,
      },
      'API ready',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
