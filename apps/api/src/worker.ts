/**
 * Maintenance / worker entry point.
 *
 * Today this is a maintenance sidecar, not a second consumer of the queue.
 * The in-process queue keeps its pending list in the API process's heap, so
 * no other container can pick work out of it - what this process actually
 * does is sweep runs abandoned by a restart and mark them failed, instead of
 * leaving them stuck at "running" forever.
 *
 * It already registers the real job handlers, so the day a shared queue
 * backend (Redis) exists this becomes a true worker with no other changes:
 * set WORKER_ENABLED=true here and false on the API.
 */
import { prisma } from './db';
import { env } from './env';
import { registerJobs } from './jobs/analysisJob';
import { getQueue, queueMode } from './jobs/queue';

const STALE_RUN_MINUTES = 60;

async function main(): Promise<void> {
  registerJobs();
  // eslint-disable-next-line no-console
  console.log(`[worker] started; queue mode: ${queueMode()}; ai provider: ${env.AI_PROVIDER}`);

  const tick = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000);
    const stale = await prisma.analysisRun.updateMany({
      where: { status: { in: ['queued', 'running'] }, updatedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: `Run exceeded ${STALE_RUN_MINUTES} minutes without progress and was marked failed.`,
        finishedAt: new Date(),
      },
    });
    if (stale.count) {
      // eslint-disable-next-line no-console
      console.warn(`[worker] marked ${stale.count} stale run(s) as failed`);
    }
  };

  await tick();
  setInterval(() => void tick().catch(() => undefined), 60_000);

  const shutdown = async (): Promise<void> => {
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process alive for the interval timer and any queued work.
  setInterval(() => {
    const queue = getQueue();
    if (queue.size() || queue.running()) {
      // eslint-disable-next-line no-console
      console.log(`[worker] pending=${queue.size()} running=${queue.running()}`);
    }
  }, 30_000);
}

void main();
