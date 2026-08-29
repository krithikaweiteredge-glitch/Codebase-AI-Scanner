import { EventEmitter } from 'node:events';
import { env } from '../env';

export interface JobRecord<P = unknown> {
  id: string;
  name: string;
  payload: P;
  enqueuedAt: number;
  attempts: number;
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
 * In-process job queue.
 *
 * Expensive work (indexing, analysis, documentation) never runs inside an HTTP
 * request: routes enqueue a job and return the run id, and the UI polls run
 * progress. The interface is deliberately small so a Redis/BullMQ-backed
 * implementation can be dropped in without touching callers - `REDIS_URL` is
 * read here purely to report which mode is active.
 */
export class InProcessQueue implements Queue {
  readonly events = new EventEmitter();
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly pending: JobRecord[] = [];
  private active = 0;
  private counter = 0;

  constructor(private readonly concurrency = 1) {}

  register<P>(name: string, handler: JobHandler<P>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async enqueue<P>(name: string, payload: P): Promise<string> {
    if (!this.handlers.has(name)) throw new Error(`No handler registered for job "${name}"`);
    const id = `${name}-${++this.counter}-${Date.now().toString(36)}`;
    this.pending.push({ id, name, payload, enqueuedAt: Date.now(), attempts: 0 });
    this.events.emit('enqueued', { id, name });
    queueMicrotask(() => void this.drain());
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
      this.events.emit('failed', { job, error });
    }
  }
}

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) queue = new InProcessQueue(1);
  return queue;
}

export function queueMode(): string {
  return env.REDIS_URL ? 'in-process (REDIS_URL set but the Redis driver is not enabled)' : 'in-process';
}
