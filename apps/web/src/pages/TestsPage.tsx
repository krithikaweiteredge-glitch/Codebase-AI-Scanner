import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, FlaskConical, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, post } from '@/lib/api';
import type { TestSuggestion } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Candidate {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  language: string | null;
  role: string | null;
  startLine: number;
  endLine: number;
  complexity: number;
  referencedInTests: boolean;
  priority: number;
}

const KIND_TONE: Record<string, 'danger' | 'warn' | 'accent' | 'neutral'> = {
  'error-path': 'danger',
  'edge-case': 'warn',
  security: 'danger',
  'happy-path': 'accent',
  regression: 'neutral',
};

export function TestsPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const toast = useToast();
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [suggestion, setSuggestion] = useState<TestSuggestion | null>(null);
  const [copied, setCopied] = useState(false);

  const candidates = useQuery({
    queryKey: ['test-candidates', repositoryId],
    queryFn: () => get<{ branch: string; candidates: Candidate[] }>(`/api/repositories/${repositoryId}/tests/candidates`),
    enabled: Boolean(repositoryId),
  });

  const generate = useMutation({
    mutationFn: (candidate: Candidate) =>
      post<{ suggestion: TestSuggestion }>(`/api/repositories/${repositoryId}/tests/generate`, {
        filePath: candidate.filePath,
        symbolName: candidate.name,
      }),
    onSuccess: (data) => setSuggestion(data.suggestion),
    onError: (error: Error) => toast.error('Could not generate tests', error.message),
  });

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[26rem] shrink-0 flex-col border-r border-line">
        <header className="border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold">What to test</h1>
          <p className="mt-0.5 text-2xs text-ink-muted">
            Ranked by branch complexity, architectural role, and whether the symbol is already referenced by a test.
          </p>
        </header>

        {candidates.isError ? <ErrorState error={candidates.error} retry={() => void candidates.refetch()} /> : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {candidates.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-14" />
              ))}
            </div>
          ) : (candidates.data?.candidates.length ?? 0) === 0 ? (
            <EmptyState
              title="Nothing to rank yet"
              description="Index the repository first; candidates come from parsed symbols and their complexity."
              icon={<FlaskConical className="h-8 w-8" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {candidates.data!.candidates.map((candidate) => (
                <li key={candidate.symbolId}>
                  <button
                    onClick={() => {
                      setSelected(candidate);
                      setSuggestion(null);
                      generate.mutate(candidate);
                    }}
                    className={cn(
                      'w-full px-3 py-2.5 text-left hover:bg-surface-raised',
                      selected?.symbolId === candidate.symbolId && 'bg-surface-raised',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-ink">{candidate.name}</span>
                      <Badge tone="neutral">{candidate.kind}</Badge>
                      {candidate.referencedInTests ? <Badge tone="ok">referenced in tests</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-2xs text-ink-faint">
                      {candidate.filePath}:{candidate.startLine}
                    </p>
                    <p className="mt-1 text-2xs text-ink-muted">
                      complexity {candidate.complexity} · priority {candidate.priority}
                      {candidate.role && candidate.role !== 'unknown' ? ` · ${candidate.role}` : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected ? (
          <EmptyState
            title="Select a function or class"
            description="Test cases are derived from the real branches, throws and catch blocks in the selected code."
            icon={<FlaskConical className="h-8 w-8" />}
          />
        ) : generate.isPending ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-40" />
            <Skeleton className="h-60" />
          </div>
        ) : suggestion ? (
          <div className="space-y-4 p-5">
            <div>
              <h2 className="text-base font-semibold">{suggestion.target}</h2>
              <Link
                to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(suggestion.filePath)}&line=${suggestion.startLine}`}
                className="mt-0.5 block font-mono text-xs text-accent hover:underline"
              >
                {suggestion.filePath}:{suggestion.startLine}-{suggestion.endLine}
              </Link>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="accent">{suggestion.framework}</Badge>
                <Badge tone={suggestion.generatedBy === 'ai' ? 'neutral' : 'warn'}>
                  {suggestion.generatedBy === 'ai' ? 'AI generated' : 'derived from code structure'}
                </Badge>
                <span className="text-2xs text-ink-faint">{suggestion.frameworkEvidence}</span>
              </div>
              {suggestion.rationale ? (
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">{suggestion.rationale}</p>
              ) : null}
            </div>

            <Card>
              <CardHeader title="Suggested test cases" description={`${suggestion.cases.length} cases`} />
              <ul className="divide-y divide-line">
                {suggestion.cases.map((testCase, index) => (
                  <li key={index} className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-ink">{testCase.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge tone={KIND_TONE[testCase.kind] ?? 'neutral'}>{testCase.kind}</Badge>
                          <Badge tone="neutral">{testCase.priority} priority</Badge>
                        </div>
                        <dl className="mt-1.5 space-y-0.5 text-2xs text-ink-muted">
                          <div>
                            <span className="text-ink-faint">Given: </span>
                            {testCase.given}
                          </div>
                          <div>
                            <span className="text-ink-faint">Expect: </span>
                            {testCase.expected}
                          </div>
                        </dl>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            {suggestion.uncoveredBehaviour?.length ? (
              <Card className="p-4">
                <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Uncovered behaviour</h3>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-ink-muted">
                  {suggestion.uncoveredBehaviour.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {suggestion.code ? (
              <Card>
                <CardHeader
                  title="Test file"
                  description={`Written for ${suggestion.framework}`}
                  actions={
                    <Button
                      onClick={() => {
                        void navigator.clipboard.writeText(suggestion.code ?? '');
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
                    </Button>
                  }
                />
                <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-2xs leading-relaxed text-ink">
                  {suggestion.code}
                </pre>
              </Card>
            ) : (
              <Card className="p-4">
                <p className="flex items-center gap-2 text-xs text-ink-muted">
                  <Sparkles className="h-3.5 w-3.5 text-warn" />
                  Runnable test code requires a configured AI provider. The case list above is derived deterministically
                  from the code and is accurate without one.
                </p>
              </Card>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
