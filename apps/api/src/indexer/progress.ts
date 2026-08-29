import { prisma } from '../db';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepState {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export const INDEXING_STEPS: { key: string; label: string }[] = [
  { key: 'connect', label: 'Repository connected' },
  { key: 'discover', label: 'Files discovered' },
  { key: 'fetch', label: 'File contents fetched' },
  { key: 'languages', label: 'Languages detected' },
  { key: 'structure', label: 'Project structure analysed' },
  { key: 'ast', label: 'AST parsed and symbols extracted' },
  { key: 'chunks', label: 'Code chunked and indexed' },
  { key: 'embeddings', label: 'Embeddings generated' },
  { key: 'dependencies', label: 'Dependency graph built' },
  { key: 'static', label: 'Static analysis completed' },
  { key: 'ai', label: 'AI architecture analysis' },
  { key: 'docs', label: 'Documentation generated' },
  { key: 'scores', label: 'Scores computed' },
];

/**
 * Persists step-by-step progress for an analysis run so the UI can poll it.
 * Every transition is written immediately - a crashed worker leaves an
 * accurate partial record rather than a silent gap.
 */
export class RunProgress {
  private steps: StepState[];
  private stats: Record<string, unknown> = {};

  constructor(
    private readonly runId: string,
    steps: { key: string; label: string }[] = INDEXING_STEPS,
  ) {
    this.steps = steps.map((s) => ({ ...s, status: 'pending' as StepStatus }));
  }

  snapshot(): StepState[] {
    return this.steps.map((s) => ({ ...s }));
  }

  async begin(): Promise<void> {
    await prisma.analysisRun.update({
      where: { id: this.runId },
      data: { status: 'running', startedAt: new Date(), steps: this.steps as unknown as object, progress: 0 },
    });
  }

  async start(key: string, detail?: string): Promise<void> {
    this.patch(key, { status: 'running', startedAt: new Date().toISOString(), ...(detail ? { detail } : {}) });
    await this.flush();
  }

  async complete(key: string, detail?: string): Promise<void> {
    this.patch(key, { status: 'completed', finishedAt: new Date().toISOString(), ...(detail ? { detail } : {}) });
    await this.flush();
  }

  async skip(key: string, detail: string): Promise<void> {
    this.patch(key, { status: 'skipped', finishedAt: new Date().toISOString(), detail });
    await this.flush();
  }

  async fail(key: string, detail: string): Promise<void> {
    this.patch(key, { status: 'failed', finishedAt: new Date().toISOString(), detail });
    await this.flush();
  }

  async detail(key: string, detail: string): Promise<void> {
    this.patch(key, { detail });
    await this.flush();
  }

  setStat(key: string, value: unknown): void {
    this.stats[key] = value;
  }

  mergeStats(values: Record<string, unknown>): void {
    Object.assign(this.stats, values);
  }

  getStats(): Record<string, unknown> {
    return { ...this.stats };
  }

  private patch(key: string, changes: Partial<StepState>): void {
    this.steps = this.steps.map((s) => (s.key === key ? { ...s, ...changes } : s));
  }

  private get percent(): number {
    const done = this.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
    return Math.round((done / this.steps.length) * 100);
  }

  private async flush(): Promise<void> {
    await prisma.analysisRun
      .update({
        where: { id: this.runId },
        data: {
          steps: this.steps as unknown as object,
          progress: this.percent,
          stats: this.stats as unknown as object,
        },
      })
      .catch(() => undefined);
  }
}
