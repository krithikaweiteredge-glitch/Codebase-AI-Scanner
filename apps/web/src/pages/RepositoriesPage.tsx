import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, GitBranch, Lock, Plus, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { del, get } from '@/lib/api';
import type { Repository } from '@/lib/types';
import { formatNumber, formatRelativeTime } from '@/lib/utils';

export function RepositoriesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['repositories'],
    queryFn: () => get<{ repositories: Repository[] }>('/api/repositories'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/repositories/${id}`),
    onSuccess: () => {
      toast.success('Repository disconnected');
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
    onError: (error: Error) => toast.error('Could not disconnect', error.message),
  });

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h1 className="text-base font-semibold">Repositories</h1>
          <p className="mt-0.5 text-xs text-ink-muted">Connected GitHub repositories available for analysis.</p>
        </div>
        <Button variant="primary" onClick={() => navigate('/repositories/connect')}>
          <Plus className="h-3.5 w-3.5" /> Connect repository
        </Button>
      </header>

      {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      <div className="p-5">
        {query.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-32" />
            ))}
          </div>
        ) : (query.data?.repositories.length ?? 0) === 0 ? (
          <Card>
            <EmptyState
              icon={<Boxes className="h-8 w-8" />}
              title="No repositories connected"
              description="Connect a GitHub repository to index it, ask questions about it, and run security, bug and performance analysis."
              action={
                <Button variant="primary" onClick={() => navigate('/repositories/connect')}>
                  <Plus className="h-3.5 w-3.5" /> Connect your first repository
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {query.data!.repositories.map((repository) => (
              <Card key={repository.id} className="flex flex-col p-4 transition-colors hover:border-line-strong">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/repositories/${repository.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink hover:text-accent">{repository.fullName}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                      {repository.description ?? 'No description'}
                    </p>
                  </Link>
                  {repository.isPrivate ? (
                    <Badge tone="neutral">
                      <Lock className="h-3 w-3" /> private
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral">
                    <GitBranch className="h-3 w-3" />
                    {repository.indexedBranch ?? repository.defaultBranch}
                  </Badge>
                  {repository.primaryLanguage ? <Badge tone="accent">{repository.primaryLanguage}</Badge> : null}
                  {repository.fileCount ? <Badge tone="neutral">{formatNumber(repository.fileCount)} files</Badge> : null}
                  {repository.findingCount ? (
                    <Badge tone="warn">{formatNumber(repository.findingCount)} findings</Badge>
                  ) : null}
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-2xs text-ink-faint">
                    {repository.lastAnalyzedAt
                      ? `Analyzed ${formatRelativeTime(repository.lastAnalyzedAt)}`
                      : 'Never analyzed'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" onClick={() => navigate(`/repositories/${repository.id}`)}>
                      Open
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Disconnect ${repository.fullName}`}
                      onClick={() => {
                        if (window.confirm(`Disconnect ${repository.fullName}? Indexed data will be deleted.`)) {
                          remove.mutate(repository.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
