import { buildApp } from './app';
import { prisma } from './db';
import { env } from './env';
import { queueConfigurationWarning } from './jobs/queue';
import { startStaleRunSweeper } from './jobs/staleRuns';

async function main(): Promise<void> {
  const app = await buildApp();

  // A misconfigured queue has no symptom until an analysis silently never
  // starts, so it is worth being loud about at boot.
  const queueWarning = queueConfigurationWarning();
  if (queueWarning) app.log.error(queueWarning);

  // This process runs the jobs it accepts, so it owns cleaning up after itself.
  // The sweeper used to live only in the worker entry point, which the Render
  // blueprint never declared, so in production nothing ever marked an abandoned
  // run as failed and it sat at "running" indefinitely.
  const stopSweeper = env.WORKER_ENABLED ? startStaleRunSweeper('api') : null;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopSweeper?.();
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
