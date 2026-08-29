import { useQuery } from '@tanstack/react-query';
import { GitPullRequest, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, Tabs } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import type { PullRequestSummary } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';

export function PullRequestsPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');

  const query = useQuery({
    queryKey: ['pull-requests', repositoryId, state],
    queryFn: () =>
      get<{ pullRequests: PullRequestSummary[] }>(
        `/api/repositories/${repositoryId}/pull-requests?state=${state}&refresh=true`,
      ),
    enabled: Boolean(repositoryId),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">Pull Requests</h1>
            <p className="mt-0.5 text-xs text-ink-muted">
              Reviews combine the diff, the surrounding indexed code and the repository's existing tests.
            </p>
          </div>
          <Button onClick={() => void query.refetch()} loading={query.isFetching}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh from GitHub
          </Button>
        </div>
        <Tabs
          className="mt-3 border-b-0"
          value={state}
          onChange={setState}
          items={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
            { value: 'all', label: 'All' },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

        {query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        ) : (query.data?.pullRequests.length ?? 0) === 0 ? (
          <Card>
            <EmptyState
              icon={<GitPullRequest className="h-8 w-8" />}
              title={`No ${state} pull requests`}
              description="Pull requests are fetched live from GitHub using your connected token."
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {query.data!.pullRequests.map((pull) => (
                <li key={pull.id}>
                  <Link
                    to={`/repositories/${repositoryId}/pull-requests/${pull.number}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-surface-raised"
                  >
                    <GitPullRequest
                      className={`h-4 w-4 shrink-0 ${
                        pull.state === 'open' ? 'text-ok' : pull.state === 'merged' ? 'text-accent' : 'text-ink-faint'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">
                        <span className="font-mono text-ink-faint">#{pull.number}</span> {pull.title}
                      </p>
                      <p className="mt-0.5 truncate text-2xs text-ink-faint">
                        {pull.author ?? 'unknown'} · {pull.headRef} → {pull.baseRef} · {pull.changedFiles} files ·{' '}
                        <span className="text-ok">+{pull.additions}</span>{' '}
                        <span className="text-danger">-{pull.deletions}</span> · updated{' '}
                        {formatRelativeTime(pull.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {pull.draft ? <Badge tone="neutral">draft</Badge> : null}
                      {pull.latestReview ? (
                        <Badge tone={pull.latestReview.status === 'request_changes' ? 'danger' : pull.latestReview.status === 'approve' ? 'ok' : 'warn'}>
                          {pull.latestReview.verdict ?? pull.latestReview.status}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">not reviewed</Badge>
                      )}
                      {pull.latestReview?.postedToGithub ? <Badge tone="accent">posted</Badge> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
