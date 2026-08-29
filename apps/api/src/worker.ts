/**
 * Standalone worker entry point.
 *
 * The in-process queue lives inside the API process by default. This entry
 * point exists so the same job handlers can be run as a separate container
 * (docker compose `worker` service) once a shared queue backend is configured;
 * with the in-process queue it drains jobs enqueued in this process only, and
 * otherwise idles while keeping analysis runs from becoming stuck.
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
