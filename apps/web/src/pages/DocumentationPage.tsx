import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Markdown } from '@/components/Markdown';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { api, get, post } from '@/lib/api';
import type { DocSection } from '@/lib/types';
import { cn, formatRelativeTime } from '@/lib/utils';

export function DocumentationPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<string | null>(null);

  const docs = useQuery({
    queryKey: ['documentation', repositoryId],
    queryFn: () => get<{ sections: DocSection[] }>(`/api/repositories/${repositoryId}/documentation`),
    enabled: Boolean(repositoryId),
  });

  const generate = useMutation({
    mutationFn: () => post(`/api/repositories/${repositoryId}/documentation/generate`, {}),
    onSuccess: () => {
      toast.success('Documentation regenerated');
      void queryClient.invalidateQueries({ queryKey: ['documentation', repositoryId] });
    },
    onError: (error: Error) => toast.error('Generation failed', error.message),
  });

  const download = useMutation({
    mutationFn: () => api<string>(`/api/repositories/${repositoryId}/documentation/export`, { raw: true }),
    onSuccess: (markdown) => {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'documentation.md';
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: (error: Error) => toast.error('Export failed', error.message),
  });

  const sections = docs.data?.sections ?? [];

  useEffect(() => {
    if (!active && sections.length) setActive(sections[0]!.section);
  }, [sections, active]);

  const current = sections.find((section) => section.section === active) ?? sections[0] ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-2">
          <Button className="w-full" onClick={() => generate.mutate()} loading={generate.isPending}>
            <RefreshCw className="h-3.5 w-3.5" /> Regenerate
          </Button>
          <Button className="mt-1.5 w-full" onClick={() => download.mutate()} loading={download.isPending}>
            <Download className="h-3.5 w-3.5" /> Export markdown
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto py-1">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActive(section.section)}
              className={cn(
                'block w-full px-3 py-1.5 text-left text-xs',
                current?.section === section.section
                  ? 'bg-accent-subtle text-accent'
                  : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
              )}
            >
              {section.title}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {docs.isLoading ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-64" />
          </div>
        ) : docs.isError ? (
          <ErrorState error={docs.error} retry={() => void docs.refetch()} />
        ) : !current ? (
          <Card className="m-6">
            <EmptyState
              icon={<FileText className="h-8 w-8" />}
              title="No documentation generated yet"
              description="Documentation is written from the indexed repository: detected endpoints, environment variables, data layer, workflows and entry points. Run an analysis, or generate it directly."
              action={
                <Button variant="primary" onClick={() => generate.mutate()} loading={generate.isPending}>
                  Generate documentation
                </Button>
              }
            />
          </Card>
        ) : (
          <article className="mx-auto max-w-4xl px-8 py-6">
            <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
              <h1 className="text-lg font-semibold">{current.title}</h1>
              <span className="text-2xs text-ink-faint">updated {formatRelativeTime(current.updatedAt)}</span>
            </div>

            <Markdown
              content={current.contentMd}
              onOpenReference={(path, line) => {
                const params = new URLSearchParams({ path });
                if (line) params.set('line', String(line));
                navigate(`/repositories/${repositoryId}/explorer?${params.toString()}`);
              }}
            />

            {current.sources?.length ? (
              <div className="mt-6 border-t border-line pt-3">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Sources</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {current.sources.map((source) => (
                    <button
                      key={source}
                      onClick={() =>
                        navigate(`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(source)}`)
                      }
                      className="rounded border border-line bg-surface-raised px-2 py-1 font-mono text-2xs text-ink-muted hover:border-accent/40 hover:text-accent"
                    >
                      {source}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </article>
        )}
      </div>
    </div>
  );
}
