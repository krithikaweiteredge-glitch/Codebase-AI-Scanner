import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, FileCode2, Sparkles, ShieldCheck, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Markdown } from '@/components/Markdown';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SeverityBadge,
  Skeleton,
  StatusBadge,
  Select,
  Input,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, patch, post } from '@/lib/api';
import type { Finding } from '@/lib/types';
import { cn, severityRank } from '@/lib/utils';

interface FindingsResponse {
  findings: Finding[];
  total: number;
  counts: Record<string, number>;
  disclaimer: string;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function FindingList({
  repositoryId,
  endpoint,
  title,
  description,
  emptyMessage,
}: {
  repositoryId: string;
  endpoint: string;
  title: string;
  description: string;
  emptyMessage: string;
}) {
  const [severity, setSeverity] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showFalsePositives, setShowFalsePositives] = useState(false);

  const queryKey = ['findings', repositoryId, endpoint, severity, status, search, showFalsePositives];
  const query = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (severity) params.set('severity', severity);
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      if (showFalsePositives) params.set('includeFalsePositives', 'true');
      return get<FindingsResponse>(`/api/repositories/${repositoryId}/${endpoint}?${params.toString()}`);
    },
  });

  const findings = useMemo(
    () => [...(query.data?.findings ?? [])].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    [query.data],
  );
  const selected = findings.find((f) => f.id === selectedId) ?? findings[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-ink">{title}</h1>
            <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Filter by title or path…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 w-56"
            />
            <Select value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="">All severities</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All confidence</option>
              <option value="confirmed">Confirmed</option>
              <option value="likely">Likely</option>
              <option value="potential">Potential</option>
            </Select>
            <Button
              variant={showFalsePositives ? 'primary' : 'secondary'}
              onClick={() => setShowFalsePositives((current) => !current)}
            >
              <EyeOff className="h-3 w-3" /> False positives
            </Button>
          </div>
        </div>

        {query.data ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SEVERITIES.map((value) =>
              query.data!.counts[value] ? (
                <button
                  key={value}
                  onClick={() => setSeverity(severity === value ? '' : value)}
                  className={cn('transition-opacity', severity && severity !== value && 'opacity-40')}
                >
                  <Badge tone="neutral">
                    <SeverityBadge severity={value} className="border-0 bg-transparent p-0" />
                    {query.data!.counts[value]}
                  </Badge>
                </button>
              ) : null,
            )}
            <span className="text-2xs text-ink-faint">{query.data.total} total</span>
          </div>
        ) : null}
      </header>

      {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      <div className="flex min-h-0 flex-1">
        <div className="w-[26rem] shrink-0 overflow-y-auto border-r border-line">
          {query.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : findings.length === 0 ? (
            <EmptyState
              title="No findings"
              description={emptyMessage}
              icon={<ShieldCheck className="h-8 w-8" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {findings.map((finding) => (
                <li key={finding.id}>
                  <button
                    onClick={() => setSelectedId(finding.id)}
                    className={cn(
                      'w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-raised',
                      selected?.id === finding.id && 'bg-surface-raised',
                      finding.falsePositive && 'opacity-50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={finding.severity} />
                      <span className="truncate text-xs font-medium text-ink">{finding.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-2xs text-ink-faint">
                      <FileCode2 className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {finding.filePath}
                        {finding.startLine ? `:${finding.startLine}` : ''}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <StatusBadge status={finding.status} source={finding.source} />
                      <span className="text-2xs text-ink-faint">{Math.round(finding.confidence * 100)}%</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <FindingDetail repositoryId={repositoryId} finding={selected} queryKey={queryKey} />
          ) : (
            <EmptyState title="Select a finding" description="Details, evidence and the exact code appear here." />
          )}
        </div>
      </div>

      {query.data?.disclaimer ? (
        <footer className="border-t border-line bg-surface px-5 py-2 text-2xs text-ink-faint">
          {query.data.disclaimer}
        </footer>
      ) : null}
    </div>
  );
}

function FindingDetail({
  repositoryId,
  finding,
  queryKey,
}: {
  repositoryId: string;
  finding: Finding;
  queryKey: unknown[];
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [explanation, setExplanation] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['finding-detail', finding.id],
    queryFn: () =>
      get<{ finding: Finding; excerpt: { startLine: number; endLine: number; text: string } | null }>(
        `/api/repositories/${repositoryId}/findings/${finding.id}`,
      ),
  });

  const explain = useMutation({
    mutationFn: () => post<{ explanation: string }>(`/api/repositories/${repositoryId}/findings/${finding.id}/explain`),
    onSuccess: (data) => setExplanation(data.explanation),
    onError: (error: Error) => toast.error('Could not explain this finding', error.message),
  });

  const markFalsePositive = useMutation({
    mutationFn: (value: boolean) =>
      patch(`/api/repositories/${repositoryId}/findings/${finding.id}`, { falsePositive: value }),
    onSuccess: (_data, value) => {
      toast.success(value ? 'Marked as a false positive' : 'Restored finding');
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const openFile = (): void => {
    if (!finding.filePath) return;
    const params = new URLSearchParams({ path: finding.filePath });
    if (finding.startLine) params.set('line', String(finding.startLine));
    navigate(`/repositories/${repositoryId}/explorer?${params.toString()}`);
  };

  return (
    <article className="space-y-4 p-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <StatusBadge status={finding.status} source={finding.source} />
          <Badge tone="neutral">confidence {Math.round(finding.confidence * 100)}%</Badge>
          {finding.cwe ? <Badge tone="neutral">{finding.cwe}</Badge> : null}
          {finding.ruleId ? <Badge tone="neutral">{finding.ruleId}</Badge> : null}
          {finding.falsePositive ? <Badge tone="warn">false positive</Badge> : null}
        </div>
        <h2 className="mt-2 text-base font-semibold text-ink">{finding.title}</h2>
        <button onClick={openFile} className="mt-1 font-mono text-xs text-accent hover:underline">
          {finding.filePath}
          {finding.startLine ? `:${finding.startLine}` : ''}
          {finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}
        </button>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button onClick={openFile}>
          <FileCode2 className="h-3 w-3" /> Open file
        </Button>
        <Button onClick={() => explain.mutate()} loading={explain.isPending}>
          <Sparkles className="h-3 w-3" /> Explain
        </Button>
        <Button
          variant={finding.falsePositive ? 'secondary' : 'danger'}
          onClick={() => markFalsePositive.mutate(!finding.falsePositive)}
          loading={markFalsePositive.isPending}
        >
          <EyeOff className="h-3 w-3" /> {finding.falsePositive ? 'Restore' : 'Mark false positive'}
        </Button>
      </div>

      <Card className="p-4">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Problem</h3>
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{finding.description}</p>

        {finding.evidence ? (
          <>
            <h3 className="mt-4 text-2xs font-semibold uppercase tracking-wider text-ink-faint">Evidence</h3>
            <p className="mt-1.5 whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink-muted">
              {finding.evidence}
            </p>
          </>
        ) : null}

        {finding.recommendation ? (
          <>
            <h3 className="mt-4 text-2xs font-semibold uppercase tracking-wider text-ink-faint">Recommendation</h3>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{finding.recommendation}</p>
          </>
        ) : null}
      </Card>

      {finding.relatedFilePath ? (
        <Card className="p-4">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Duplicate counterpart</h3>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="font-mono text-ink-muted">
              {finding.filePath}:{finding.startLine}
            </span>
            <ChevronRight className="h-3 w-3 text-ink-faint" />
            <button
              className="font-mono text-accent hover:underline"
              onClick={() => {
                const params = new URLSearchParams({ path: finding.relatedFilePath! });
                if (finding.relatedStartLine) params.set('line', String(finding.relatedStartLine));
                navigate(`/repositories/${repositoryId}/explorer?${params.toString()}`);
              }}
            >
              {finding.relatedFilePath}:{finding.relatedStartLine}
            </button>
            {finding.similarity ? (
              <Badge tone="accent">{Math.round(finding.similarity * 100)}% similar</Badge>
            ) : null}
          </div>
        </Card>
      ) : null}

      {detail.data?.excerpt ? (
        <Card>
          <div className="border-b border-line px-3 py-2 font-mono text-2xs text-ink-faint">
            {finding.filePath}:{detail.data.excerpt.startLine}-{detail.data.excerpt.endLine}
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-ink">
            {detail.data.excerpt.text.split('\n').map((line, index) => {
              const lineNumber = detail.data!.excerpt!.startLine + index;
              const isTarget =
                finding.startLine !== null &&
                lineNumber >= finding.startLine &&
                lineNumber <= (finding.endLine ?? finding.startLine);
              return (
                <div key={lineNumber} className={cn('flex', isTarget && 'bg-severity-critical/10')}>
                  <span className="w-12 shrink-0 select-none pr-3 text-right text-ink-faint">{lineNumber}</span>
                  <span className="whitespace-pre">{line}</span>
                </div>
              );
            })}
          </pre>
        </Card>
      ) : null}

      {explanation ? (
        <Card className="p-4">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Grounded explanation</h3>
          <Markdown className="mt-2" content={explanation} />
        </Card>
      ) : null}
    </article>
  );
}
