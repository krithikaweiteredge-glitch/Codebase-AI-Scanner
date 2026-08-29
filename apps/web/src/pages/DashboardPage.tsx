import { useQuery } from '@tanstack/react-query';
import { Boxes, Plus, ShieldAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, EmptyState, SeverityBadge, Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { get } from '@/lib/api';
import type { Repository } from '@/lib/types';
import { formatNumber, formatRelativeTime } from '@/lib/utils';

interface SummaryResponse {
  repositories: {
    id: string;
    fullName: string;
    counts: { category: string; severity: string; count: number }[];
  }[];
}

interface HealthResponse {
  status: string;
  database: string;
  pgvector: string;
  ai: { provider: string; model: string; generation: boolean };
  embeddings: { provider: string; model: string; dimensions: number };
  queue: { mode: string; pending: number; running: number };
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: () => get<{ repositories: Repository[] }>('/api/repositories'),
  });

  const summary = useQuery({
    queryKey: ['findings-summary'],
    queryFn: () => get<SummaryResponse>('/api/findings/summary'),
  });

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => get<HealthResponse>('/api/health'),
    refetchInterval: 30_000,
  });

  const list = repositories.data?.repositories ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h1 className="text-base font-semibold">Dashboard</h1>
          <p className="mt-0.5 text-xs text-ink-muted">
            {user?.name ? `${user.name} · ` : ''}
            {list.length} repositor{list.length === 1 ? 'y' : 'ies'} connected
          </p>
        </div>
        <Button variant="primary" onClick={() => navigate('/repositories/connect')}>
          <Plus className="h-3.5 w-3.5" /> Connect repository
        </Button>
      </header>

      <div className="space-y-4 p-5">
        {repositories.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Boxes className="h-8 w-8" />}
              title="Connect your first repository"
              description="Index a GitHub repository to search it in natural language, ask grounded questions about it, and run security, bug, performance and duplication analysis."
              action={
                <Button variant="primary" onClick={() => navigate('/repositories/connect')}>
                  <Plus className="h-3.5 w-3.5" /> Connect a repository
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((repository) => {
              const counts = summary.data?.repositories.find((entry) => entry.id === repository.id)?.counts ?? [];
              const bySeverity = counts.reduce<Record<string, number>>((accumulator, row) => {
                accumulator[row.severity] = (accumulator[row.severity] ?? 0) + row.count;
                return accumulator;
              }, {});

              return (
                <Link key={repository.id} to={`/repositories/${repository.id}`} className="panel p-4 hover:border-accent/40">
                  <p className="truncate text-sm font-semibold text-ink">{repository.fullName}</p>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {repository.indexedBranch ?? repository.defaultBranch} · {formatNumber(repository.fileCount ?? 0)}{' '}
                    files · analyzed {formatRelativeTime(repository.lastAnalyzedAt)}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(['critical', 'high', 'medium', 'low'] as const).map((severity) =>
                      bySeverity[severity] ? (
                        <span key={severity} className="flex items-center gap-1">
                          <SeverityBadge severity={severity} />
                          <span className="font-mono text-2xs text-ink-muted">{bySeverity[severity]}</span>
                        </span>
                      ) : null,
                    )}
                    {Object.keys(bySeverity).length === 0 ? (
                      <span className="text-2xs text-ink-faint">
                        {repository.lastAnalyzedAt ? 'no findings' : 'not analyzed yet'}
                      </span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Highest severity findings" description="Across every connected repository" />
            <div className="divide-y divide-line">
              {(summary.data?.repositories ?? [])
                .flatMap((repository) =>
                  repository.counts
                    .filter((row) => row.severity === 'critical' || row.severity === 'high')
                    .map((row) => ({ ...row, repositoryId: repository.id, fullName: repository.fullName })),
                )
                .sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'critical' ? -1 : 1))
                .slice(0, 8)
                .map((row, index) => (
                  <Link
                    key={`${row.repositoryId}-${row.category}-${row.severity}-${index}`}
                    to={`/repositories/${row.repositoryId}/${
                      row.category === 'bug' ? 'bugs' : row.category === 'duplicate' ? 'duplicates' : row.category
                    }`}
                    className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-raised"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <SeverityBadge severity={row.severity} />
                      <span className="truncate text-xs text-ink">{row.fullName}</span>
                      <Badge tone="neutral">{row.category}</Badge>
                    </span>
                    <span className="font-mono text-xs text-ink-muted">{row.count}</span>
                  </Link>
                ))}
              {(summary.data?.repositories ?? []).every((repository) => repository.counts.length === 0) ? (
                <EmptyState
                  icon={<ShieldAlert className="h-7 w-7" />}
                  title="No critical or high findings"
                  description="Either nothing was detected, or no analysis has run yet."
                />
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="System" description="Live configuration of this deployment" />
            {health.data ? (
              <dl className="space-y-2 p-4 text-xs">
                <Row label="Status" value={health.data.status} tone={health.data.status === 'ok' ? 'ok' : 'danger'} />
                <Row label="Database" value={health.data.database} />
                <Row
                  label="pgvector"
                  value={health.data.pgvector}
                  tone={health.data.pgvector === 'installed' ? 'ok' : 'danger'}
                />
                <Row
                  label="AI provider"
                  value={`${health.data.ai.provider}/${health.data.ai.model}${health.data.ai.generation ? '' : ' (no generation)'}`}
                  tone={health.data.ai.generation ? 'ok' : 'warn'}
                />
                <Row
                  label="Embeddings"
                  value={`${health.data.embeddings.provider}/${health.data.embeddings.model} · ${health.data.embeddings.dimensions}d`}
                />
                <Row
                  label="Job queue"
                  value={`${health.data.queue.mode} · ${health.data.queue.running} running / ${health.data.queue.pending} pending`}
                />
              </dl>
            ) : (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4" />
                <Skeleton className="h-4" />
                <Skeleton className="h-4" />
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono">
        {tone ? <Badge tone={tone}>{value}</Badge> : <span className="text-ink">{value}</span>}
      </dd>
    </div>
  );
}
