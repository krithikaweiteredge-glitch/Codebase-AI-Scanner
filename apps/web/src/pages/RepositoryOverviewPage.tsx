import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bug,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  Gauge,
  MinusCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  FlaskConical,
  Loader2,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  ProgressBar,
  ScoreRing,
  SeverityBadge,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, post } from '@/lib/api';
import type { AnalysisRun, DashboardResponse, RunStep, Score } from '@/lib/types';
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils';

export function RepositoryOverviewPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();

  const dashboard = useQuery({
    queryKey: ['dashboard', repositoryId],
    queryFn: () => get<DashboardResponse>(`/api/repositories/${repositoryId}/dashboard`),
    enabled: Boolean(repositoryId),
  });

  const activeRun = dashboard.data?.latestRun;
  const isRunning = activeRun?.status === 'queued' || activeRun?.status === 'running';

  // Poll only while a run is in flight - progress is written by the worker.
  const run = useQuery({
    queryKey: ['analysis-run', repositoryId],
    queryFn: () => get<{ run: AnalysisRun | null }>(`/api/repositories/${repositoryId}/analysis`),
    enabled: Boolean(repositoryId) && isRunning,
    refetchInterval: 1500,
  });

  const currentRun = run.data?.run ?? activeRun ?? null;

  const analyze = useMutation({
    mutationFn: (incremental: boolean) =>
      post(`/api/repositories/${repositoryId}/analyze`, { incremental, generateDocs: true }),
    onSuccess: () => {
      toast.info('Analysis queued', 'Progress updates below as each stage completes.');
      void queryClient.invalidateQueries({ queryKey: ['dashboard', repositoryId] });
      void queryClient.invalidateQueries({ queryKey: ['analysis-run', repositoryId] });
    },
    onError: (error: Error) => toast.error('Could not start analysis', error.message),
  });

  if (dashboard.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-20" />
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (dashboard.isError) return <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />;
  if (!dashboard.data) return null;

  const { repository, stats, findings, scores, recentCommits, branch } = dashboard.data;
  const notIndexed = !branch || stats.files === 0;

  return (
    <div className="h-full overflow-y-auto">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold">{repository.fullName}</h1>
              {repository.htmlUrl ? (
                <a
                  href={repository.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-faint hover:text-accent"
                  aria-label="Open on GitHub"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              {repository.owner} · branch <span className="font-mono text-ink">{branch ?? repository.defaultBranch}</span>{' '}
              · last analyzed {formatRelativeTime(repository.lastAnalyzedAt)}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={() => analyze.mutate(true)} loading={analyze.isPending} disabled={isRunning}>
              <RefreshCw className="h-3.5 w-3.5" /> Re-analyze changed files
            </Button>
            <Button variant="primary" onClick={() => analyze.mutate(false)} loading={analyze.isPending} disabled={isRunning}>
              <Play className="h-3.5 w-3.5" /> Full analysis
            </Button>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-5">
        {currentRun && (isRunning || currentRun.status === 'failed') ? (
          <RunProgressCard run={currentRun} />
        ) : null}

        {notIndexed && !isRunning ? (
          <Card>
            <EmptyState
              title="This repository has not been indexed yet"
              description="Run a full analysis to fetch file contents, parse symbols, build the dependency graph and generate embeddings. Nothing is cloned or executed."
              action={
                <Button variant="primary" onClick={() => analyze.mutate(false)} loading={analyze.isPending}>
                  <Play className="h-3.5 w-3.5" /> Start analysis
                </Button>
              }
            />
          </Card>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <FindingCard
            to={`/repositories/${repositoryId}/security`}
            icon={<ShieldAlert className="h-4 w-4" />}
            label="Security issues"
            counts={findings.security}
          />
          <FindingCard
            to={`/repositories/${repositoryId}/bugs`}
            icon={<Bug className="h-4 w-4" />}
            label="Potential bugs"
            counts={findings.bug}
          />
          <FindingCard
            to={`/repositories/${repositoryId}/performance`}
            icon={<Gauge className="h-4 w-4" />}
            label="Performance"
            counts={findings.performance}
          />
          <FindingCard
            to={`/repositories/${repositoryId}/duplicates`}
            icon={<Copy className="h-4 w-4" />}
            label="Duplicate code"
            counts={findings.duplicate}
          />
          <FindingCard
            to={`/repositories/${repositoryId}/tests`}
            icon={<FlaskConical className="h-4 w-4" />}
            label="Quality signals"
            counts={findings.quality}
          />
        </div>

        {scores?.length ? <ScoresCard scores={scores} /> : null}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Repository" description="Everything below is measured from the indexed branch" />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <dl className="space-y-2 text-xs">
                <Row label="Files indexed" value={formatNumber(stats.files)} />
                <Row label="Lines of code" value={formatNumber(stats.lines)} />
                <Row label="HTTP endpoints detected" value={formatNumber(stats.routes)} />
                <Row label="Frameworks" value={stats.frameworks.join(', ') || 'none detected'} />
                <Row label="Test frameworks" value={stats.testFrameworks.join(', ') || 'none detected'} />
              </dl>

              <div>
                <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-faint">Languages</p>
                <div className="space-y-1">
                  {stats.languages.slice(0, 7).map((language) => (
                    <div key={language.key} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate text-2xs text-ink-muted">{language.language}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-overlay">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${language.percent}%` }} />
                      </div>
                      <span className="w-10 text-right font-mono text-2xs text-ink-faint">{language.percent}%</span>
                    </div>
                  ))}
                  {stats.languages.length === 0 ? (
                    <p className="text-2xs text-ink-faint">No languages recorded yet.</p>
                  ) : null}
                </div>

                {stats.entryPoints.length ? (
                  <>
                    <p className="mb-1.5 mt-4 text-2xs uppercase tracking-wider text-ink-faint">Entry points</p>
                    <ul className="space-y-1">
                      {stats.entryPoints.slice(0, 5).map((entry) => (
                        <li key={entry.file} className="truncate font-mono text-2xs text-ink-muted">
                          <Link
                            className="hover:text-accent"
                            to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(entry.file)}`}
                          >
                            {entry.file}
                          </Link>
                          {entry.detail ? <span className="text-ink-faint"> — {entry.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent commits" description="From the indexed branch" />
            <div className="divide-y divide-line">
              {recentCommits.length === 0 ? (
                <p className="p-4 text-2xs text-ink-faint">No commits recorded.</p>
              ) : (
                recentCommits.map((commit) => (
                  <div key={commit.sha} className="px-4 py-2.5">
                    <p className="truncate text-xs text-ink">{commit.message}</p>
                    <p className="mt-0.5 font-mono text-2xs text-ink-faint">
                      {commit.sha.slice(0, 7)} · {commit.author ?? 'unknown'} · {formatRelativeTime(commit.committedAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate text-right font-mono text-ink">{value}</dd>
    </div>
  );
}

function FindingCard({
  to,
  icon,
  label,
  counts,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  counts?: Record<string, number>;
}) {
  const total = counts?.total ?? 0;
  return (
    <Link to={to} className="panel block p-3.5 transition-colors hover:border-accent/40">
      <div className="flex items-center gap-2 text-ink-muted">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold text-ink">{total}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {(['critical', 'high', 'medium', 'low'] as const).map((severity) =>
          counts?.[severity] ? (
            <span key={severity} className="flex items-center gap-1">
              <SeverityBadge severity={severity} />
              <span className="font-mono text-2xs text-ink-muted">{counts[severity]}</span>
            </span>
          ) : null,
        )}
        {total === 0 ? <span className="text-2xs text-ink-faint">nothing detected</span> : null}
      </div>
    </Link>
  );
}

function ScoresCard({ scores }: { scores: Score[] }) {
  return (
    <Card>
      <CardHeader
        title="Scores"
        description="Every score is computed from counted inputs; expand a score to see exactly what moved it."
      />
      <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-5">
        {scores.map((score) => (
          <details key={score.key} className="group">
            <summary className="cursor-pointer list-none">
              <ScoreRing score={score.score} label={score.label} />
              <p className="mt-1 text-2xs text-ink-faint group-open:hidden">Grade {score.grade} · click for breakdown</p>
            </summary>
            <div className="mt-2 space-y-1.5 rounded border border-line bg-canvas p-2">
              <p className="text-2xs leading-relaxed text-ink-muted">{score.summary}</p>
              {score.factors.map((factor, index) => (
                <div key={index} className="border-t border-line/60 pt-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-2xs text-ink">{factor.label}</span>
                    <span
                      className={cn(
                        'font-mono text-2xs',
                        factor.impact < 0 ? 'text-danger' : factor.impact > 0 ? 'text-ok' : 'text-ink-faint',
                      )}
                    >
                      {factor.impact > 0 ? '+' : ''}
                      {factor.impact}
                    </span>
                  </div>
                  <p className="mt-0.5 text-2xs leading-snug text-ink-faint">{factor.detail}</p>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}

function RunProgressCard({ run }: { run: AnalysisRun }) {
  const steps: RunStep[] = Array.isArray(run.steps) ? run.steps : [];
  const stats = (run.stats ?? {}) as Record<string, unknown>;

  return (
    <Card>
      <CardHeader
        title={run.status === 'failed' ? 'Analysis failed' : 'Analyzing repository'}
        description={`${run.kind} run · ${run.aiProvider ?? 'local'}/${run.aiModel ?? '—'}${
          run.commitSha ? ` · ${run.commitSha.slice(0, 7)}` : ''
        }`}
        actions={
          <Badge tone={run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'ok' : 'accent'}>
            {run.status}
          </Badge>
        }
      />
      <div className="p-4">
        <ProgressBar value={run.progress} />

        {run.error ? (
          <div className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <AlertCircle className="h-3.5 w-3.5" /> {run.error}
            </p>
          </div>
        ) : null}

        <ul className="mt-3 space-y-1">
          {steps.map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0">
                {step.status === 'completed' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                ) : step.status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                ) : step.status === 'failed' ? (
                  <AlertCircle className="h-3.5 w-3.5 text-danger" />
                ) : step.status === 'skipped' ? (
                  <MinusCircle className="h-3.5 w-3.5 text-ink-faint" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-ink-faint/50" />
                )}
              </span>
              <span className="min-w-0">
                <span className={cn(step.status === 'pending' ? 'text-ink-faint' : 'text-ink')}>{step.label}</span>
                {step.detail ? <span className="ml-2 text-2xs text-ink-muted">{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>

        {Object.keys(stats).length ? (
          <details className="mt-3 text-2xs text-ink-faint">
            <summary className="cursor-pointer hover:text-ink-muted">Run statistics</summary>
            <pre className="mt-1.5 max-h-56 overflow-auto rounded border border-line bg-canvas p-2 font-mono">
              {JSON.stringify(stats, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
