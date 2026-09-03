/**
 * Marks abandoned analysis runs as failed.
 *
 * The queue keeps its pending list in the running process's heap, so a restart
 * loses whatever was in flight and the rows it left behind sit at "running"
 * forever. A run that never finishes is worse than one that failed: the UI
 * shows it as in progress, and anyone debugging reads a dead run as a live one.
 *
 * This lived only in the worker entry point, which docker-compose runs as a
 * sidecar and the Render blueprint does not declare at all - so in the
 * deployment that matters it never ran, and a run really did sit at "running"
 * for over an hour while nothing was executing it.
 */

import { prisma } from '../db';

/** How long a run may go without progress before it is presumed dead. */
export const STALE_RUN_MINUTES = 60;

/** How often a process that owns the sweep should run it. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Fails every run that has made no progress inside the window. Returns how many. */
export async function sweepStaleRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
  const stale = await prisma.analysisRun.updateMany({
    where: { status: { in: ['queued', 'running'] }, updatedAt: { lt: cutoff } },
    data: {
      status: 'failed',
      error: `Run exceeded ${STALE_RUN_MINUTES} minutes without progress and was marked failed.`,
      finishedAt: now,
    },
  });
  return stale.count;
}

/**
 * Starts the periodic sweep and returns a stop function.
 *
 * `unref` so the timer never holds a process open on its own - a one-shot
 * command that happens to import this should still exit.
 */
export function startStaleRunSweeper(label: string): () => void {
  const tick = async (): Promise<void> => {
    const count = await sweepStaleRuns();
    if (count) {
      // eslint-disable-next-line no-console
      console.warn(`[${label}] marked ${count} stale run(s) as failed`);
    }
  };

  void tick().catch(() => undefined);
  const timer = setInterval(() => void tick().catch(() => undefined), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
