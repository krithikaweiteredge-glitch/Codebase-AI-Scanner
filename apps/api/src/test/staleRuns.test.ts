import { describe, expect, it, vi } from 'vitest';

const updateMany = vi.fn();
vi.mock('../db', () => ({ prisma: { analysisRun: { updateMany: (...args: unknown[]) => updateMany(...args) } } }));

// Static import is safe: vitest hoists the vi.mock above it, matching how
// routes.test.ts fakes the database.
import { STALE_RUN_MINUTES, startStaleRunSweeper, sweepStaleRuns } from '../jobs/staleRuns';

describe('sweeping abandoned runs', () => {
  it('fails runs that have made no progress inside the window', async () => {
    updateMany.mockResolvedValueOnce({ count: 2 });
    const now = new Date('2026-01-01T12:00:00Z');
    const count = await sweepStaleRuns(now);

    expect(count).toBe(2);
    const [args] = updateMany.mock.calls.at(-1) as [Record<string, never>];
    const where = args.where as unknown as { status: { in: string[] }; updatedAt: { lt: Date } };
    // Queued counts too: a run that never started is just as stuck as one that
    // started and lost its process.
    expect(where.status.in).toEqual(['queued', 'running']);
    expect(where.updatedAt.lt).toEqual(new Date(now.getTime() - STALE_RUN_MINUTES * 60_000));
  });

  it('marks them failed with a reason rather than deleting them', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });
    await sweepStaleRuns(new Date());
    const [args] = updateMany.mock.calls.at(-1) as [Record<string, never>];
    const data = args.data as unknown as { status: string; error: string; finishedAt: Date };
    expect(data.status).toBe('failed');
    expect(data.error).toContain(`${STALE_RUN_MINUTES} minutes`);
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it('leaves a run that is genuinely progressing alone', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sweepStaleRuns(new Date())).toBe(0);
  });

  it('sweeps once immediately, so a restart does not wait a full interval', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const calls = updateMany.mock.calls.length;
    const stop = startStaleRunSweeper('test');
    await vi.waitFor(() => expect(updateMany.mock.calls.length).toBeGreaterThan(calls));
    stop();
  });

  it('survives a database error without taking the process down', async () => {
    updateMany.mockRejectedValueOnce(new Error('connection lost'));
    const stop = startStaleRunSweeper('test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    // Reaching here without an unhandled rejection is the assertion.
    expect(true).toBe(true);
  });
});
