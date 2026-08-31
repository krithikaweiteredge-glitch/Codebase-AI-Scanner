import { describe, expect, it, vi } from 'vitest';
import { InProcessQueue, TerminalJobError, type JobRecord, type QueueOptions } from '../jobs/queue';
import { isTransient } from '../jobs/analysisJob';
import {
  AppError,
  githubUnavailable,
  aiUnavailable,
  repositoryInaccessible,
  githubAuthFailed,
  repositoryTooLarge,
} from '../errors';

/**
 * Retries are scheduled through an injected timer so the suite never waits on
 * real backoff. Delays are captured for assertion instead.
 */
function immediateScheduler() {
  const delays: number[] = [];
  return {
    delays,
    schedule: (run: () => void, delayMs: number) => {
      delays.push(delayMs);
      queueMicrotask(run);
    },
  };
}

function queueWith(overrides: QueueOptions = {}) {
  const scheduler = immediateScheduler();
  const queue = new InProcessQueue({ scheduleRetry: scheduler.schedule, ...overrides });
  return { queue, scheduler };
}

/** Resolves once the queue has gone idle. */
async function settle(queue: InProcessQueue): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!queue.size() && !queue.running()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('queue did not settle');
}

describe('job retries', () => {
  it('runs a job once when it succeeds', async () => {
    const { queue } = queueWith();
    const handler = vi.fn(async () => undefined);

    queue.register('job', handler);
    await queue.enqueue('job', { x: 1 });
    await settle(queue);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries a failing job up to maxAttempts', async () => {
    const { queue } = queueWith({ maxAttempts: 3 });
    const handler = vi.fn(async () => {
      throw new Error('transient boom');
    });

    queue.register('job', handler);
    await queue.enqueue('job', {});
    await settle(queue);

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('stops retrying as soon as an attempt succeeds', async () => {
    const { queue } = queueWith({ maxAttempts: 5 });
    let calls = 0;
    const handler = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
    });

    queue.register('job', handler);
    await queue.enqueue('job', {});
    await settle(queue);

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('tells the handler which attempt it is on', async () => {
    const { queue } = queueWith({ maxAttempts: 3 });
    const seen: { attempts: number; maxAttempts: number }[] = [];

    queue.register('job', async (_payload, job: JobRecord) => {
      seen.push({ attempts: job.attempts, maxAttempts: job.maxAttempts });
      throw new Error('boom');
    });
    await queue.enqueue('job', {});
    await settle(queue);

    // A handler needs this to know whether the current failure is its last.
    expect(seen).toEqual([
      { attempts: 1, maxAttempts: 3 },
      { attempts: 2, maxAttempts: 3 },
      { attempts: 3, maxAttempts: 3 },
    ]);
  });

  it('does not retry a terminal failure', async () => {
    const { queue } = queueWith({ maxAttempts: 5 });
    const handler = vi.fn(async () => {
      throw new TerminalJobError('repository was deleted');
    });

    queue.register('job', handler);
    await queue.enqueue('job', {});
    await settle(queue);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially, with jitter, under a cap', async () => {
    const { queue, scheduler } = queueWith({ maxAttempts: 4, retryBaseMs: 1000, retryCapMs: 3000 });

    queue.register('job', async () => {
      throw new Error('boom');
    });
    await queue.enqueue('job', {});
    await settle(queue);

    expect(scheduler.delays).toHaveLength(3);
    // Jitter is half-to-full of the exponential value: 1000, 2000, capped 3000.
    expect(scheduler.delays[0]).toBeGreaterThanOrEqual(500);
    expect(scheduler.delays[0]).toBeLessThanOrEqual(1000);
    expect(scheduler.delays[1]).toBeGreaterThanOrEqual(1000);
    expect(scheduler.delays[1]).toBeLessThanOrEqual(2000);
    expect(scheduler.delays[2]).toBeLessThanOrEqual(3000);
  });

  it('emits retrying before failed, and failed only once', async () => {
    const { queue } = queueWith({ maxAttempts: 3 });
    const retrying: unknown[] = [];
    const failed: unknown[] = [];

    queue.events.on('retrying', (e) => retrying.push(e));
    queue.events.on('failed', (e) => failed.push(e));

    queue.register('job', async () => {
      throw new Error('boom');
    });
    await queue.enqueue('job', {});
    await settle(queue);

    expect(retrying).toHaveLength(2);
    // Consumers must not see a job reported failed while retries remain.
    expect(failed).toHaveLength(1);
  });

  it('disables retries when maxAttempts is 1', async () => {
    const { queue } = queueWith({ maxAttempts: 1 });
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });

    queue.register('job', handler);
    await queue.enqueue('job', {});
    await settle(queue);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('autoDrain', () => {
  it('accepts but never runs jobs when draining is off', async () => {
    const { queue } = queueWith({ autoDrain: false });
    const handler = vi.fn(async () => undefined);

    queue.register('job', handler);
    await queue.enqueue('job', {});
    await new Promise((resolve) => setImmediate(resolve));

    // This is exactly the trap WORKER_ENABLED=false used to set silently.
    expect(handler).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
  });
});

describe('transient failure classification', () => {
  it('treats server-side and unknown failures as retryable', () => {
    expect(isTransient(githubUnavailable('GitHub is down'))).toBe(true);
    expect(isTransient(aiUnavailable('provider timeout'))).toBe(true);
    expect(isTransient(new AppError('gateway', 504, 'TIMEOUT'))).toBe(true);
    // Socket resets and driver faults arrive unclassified.
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
  });

  it('treats client-side failures as terminal', () => {
    // Retrying these produces the identical error and wastes the attempt.
    expect(isTransient(repositoryInaccessible('repository was deleted'))).toBe(false);
    expect(isTransient(githubAuthFailed())).toBe(false);
    expect(isTransient(repositoryTooLarge('too big'))).toBe(false);
  });
});
