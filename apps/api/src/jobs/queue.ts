import { EventEmitter } from 'node:events';
import { env } from '../env';

export interface JobRecord<P = unknown> {
  id: string;
  name: string;
  payload: P;
  enqueuedAt: number;
  /** 1 on the first run of a handler, incremented before each retry. */
  attempts: number;
  /** Total tries allowed, so a handler can tell whether this is its last one. */
  maxAttempts: number;
}

export type JobHandler<P = never> = (payload: P, job: JobRecord<P>) => Promise<void>;

export interface Queue {
  register<P>(name: string, handler: JobHandler<P>): void;
  enqueue<P>(name: string, payload: P): Promise<string>;
  size(): number;
  running(): number;
  readonly events: EventEmitter;
}

/**
 * Thrown (or wrapped) by a handler to say "this will fail identically next
 * time" - a malformed payload, a repository that no longer exists, a revoked
 * token. The queue gives up on these immediately instead of burning retries.
 */
export class TerminalJobError extends Error {
  constructor(message: string, cause?: unknown) {
    // Standard Error cause, rather than a field that shadows it.
    super(message, { cause });
    this.name = 'TerminalJobError';
  }
}

export interface QueueOptions {
  concurrency?: number;
  maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  retryBaseMs?: number;
  retryCapMs?: number;
  /**
   * When false the process accepts work but never runs it. Only meaningful
   * once a shared queue backend exists; with the in-process queue it means
   * jobs are dropped on the floor, which `assertQueueConfiguration` warns about.
   */
  autoDrain?: boolean;
  /** Injectable for tests, so retry timing does not make the suite slow. */
  scheduleRetry?: (run: () => void, delayMs: number) => void;
}

/**
 * In-process job queue.
 *
 * Expensive work (indexing, analysis, documentation) never runs inside an HTTP
 * request: routes enqueue a job and return the run id, and the UI polls run
 * progress. The interface is deliberately small so a Redis/BullMQ-backed
 * implementation can be dropped in without touching callers.
 *
 * Jobs live in memory, so a restart loses whatever was queued. The stale-run
 * sweeper in `worker.ts` is what stops those runs sitting at "running" forever.
 */
export class InProcessQueue implements Queue {
  readonly events = new EventEmitter();
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly pending: JobRecord[] = [];
  private active = 0;
  private counter = 0;

  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly autoDrain: boolean;
  private readonly scheduleRetry: (run: () => void, delayMs: number) => void;

  constructor(options: QueueOptions = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.retryCapMs = options.retryCapMs ?? 60_000;
    this.autoDrain = options.autoDrain ?? true;
    this.scheduleRetry =
      options.scheduleRetry ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        // A pending retry must not keep the process alive on shutdown.
        timer.unref?.();
      });
  }

  register<P>(name: string, handler: JobHandler<P>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async enqueue<P>(name: string, payload: P): Promise<string> {
    if (!this.handlers.has(name)) throw new Error(`No handler registered for job "${name}"`);
    const id = `${name}-${++this.counter}-${Date.now().toString(36)}`;
    this.pending.push({
      id,
      name,
      payload,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: this.maxAttempts,
    });
    this.events.emit('enqueued', { id, name });
    if (this.autoDrain) queueMicrotask(() => void this.drain());
    return id;
  }

  size(): number {
    return this.pending.length;
  }

  running(): number {
    return this.active;
  }

  private async drain(): Promise<void> {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      if (!job) break;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        if (this.pending.length) queueMicrotask(() => void this.drain());
      });
    }
  }

  private async run(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) return;
    job.attempts++;
    this.events.emit('started', job);

    try {
      await (handler as JobHandler<unknown>)(job.payload, job);
      this.events.emit('completed', job);
    } catch (error) {
      const terminal = error instanceof TerminalJobError;

      if (!terminal && job.attempts < job.maxAttempts) {
        const delayMs = this.backoffFor(job.attempts);
        this.events.emit('retrying', { job, error, delayMs });
        this.scheduleRetry(() => {
          this.pending.push(job);
          void this.drain();
        }, delayMs);
        return;
      }

      this.events.emit('failed', { job, error });
    }
  }

  /**
   * Exponential backoff with jitter. The jitter matters when a provider outage
   * fails several jobs at once - without it they would all retry in lockstep
   * and hit the recovering service together.
   */
  private backoffFor(attempt: number): number {
    const exponential = Math.min(this.retryCapMs, this.retryBaseMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  }
}

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) {
    queue = new InProcessQueue({
      concurrency: 1,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      autoDrain: env.WORKER_ENABLED,
    });
  }
  return queue;
}

/** Test seam: drop the singleton so the next getQueue() reads config again. */
export function resetQueue(): void {
  queue = null;
}

export function queueMode(): string {
  return env.REDIS_URL ? 'in-process (REDIS_URL set but the Redis driver is not enabled)' : 'in-process';
}

/**
 * Detects the one configuration that silently does nothing.
 *
 * `WORKER_ENABLED=false` is meant to say "another process runs the jobs", but
 * the in-process queue cannot hand work to another process - the pending list
 * lives in this heap. So that combination accepts analyses and never runs
 * them, and the only symptom is runs that sit at "queued" until the sweeper
 * fails them an hour later. Better to say so at boot.
 */
export function queueConfigurationWarning(): string | null {
  if (env.WORKER_ENABLED) return null;
  return (
    'WORKER_ENABLED=false, but the queue is in-process: jobs enqueued here will never run. ' +
    'A separate worker process can only pick up jobs once a shared queue backend is configured. ' +
    'Set WORKER_ENABLED=true on the process that serves the API.'
  );
}
