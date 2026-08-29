import { useQuery } from '@tanstack/react-query';
import { FileCode2, Search as SearchIcon, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton, Tabs } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import type { SearchResult } from '@/lib/types';

const EXAMPLES = [
  'Where are payments processed?',
  'Find all places where JWT tokens are generated',
  'Show database queries related to orders',
  'Where is email verification implemented?',
  'Find code that sends OTPs',
  'Where is AWS S3 used?',
];

type Mode = 'hybrid' | 'text' | 'symbol';

interface HybridResponse {
  mode: 'hybrid';
  understood: { intent: string; terms: string[]; literals: string[]; preferredRoles: string[] };
  retrievers: { name: string; hits: number; error?: string }[];
  results: SearchResult[];
}

interface TextResponse {
  mode: 'text';
  matches: { filePath: string; line: number; text: string }[];
}

interface SymbolResponse {
  mode: 'symbol';
  symbols: { id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; signature: string | null }[];
}

export function SearchPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('hybrid');

  const search = useQuery({
    queryKey: ['search', repositoryId, query, mode],
    queryFn: () =>
      get<HybridResponse | TextResponse | SymbolResponse>(
        `/api/repositories/${repositoryId}/search?q=${encodeURIComponent(query)}&mode=${mode}&limit=25`,
      ),
    enabled: Boolean(repositoryId) && query.trim().length > 1,
  });

  const open = (filePath: string, line?: number): void => {
    const params = new URLSearchParams({ path: filePath });
    if (line) params.set('line', String(line));
    navigate(`/repositories/${repositoryId}/explorer?${params.toString()}`);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setQuery(input);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 py-4">
        <h1 className="text-base font-semibold">Search the codebase</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Natural language, identifiers or literal text. Hybrid search fuses semantic, keyword and symbol retrieval.
        </p>

        <form onSubmit={submit} className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input
              autoFocus
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search the codebase…"
              className="h-9 pl-8 text-sm"
            />
          </div>
          <Button type="submit" variant="primary" size="md">
            Search
          </Button>
        </form>

        <Tabs
          className="mt-3 border-b-0"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'hybrid', label: 'Hybrid (semantic + keyword + symbol)' },
            { value: 'text', label: 'Literal text' },
            { value: 'symbol', label: 'Symbols' },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!query ? (
          <div className="mx-auto max-w-2xl">
            <p className="text-2xs uppercase tracking-wider text-ink-faint">Try</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  onClick={() => {
                    setInput(example);
                    setQuery(example);
                  }}
                  className="rounded-md border border-line bg-surface px-3 py-2 text-left text-xs text-ink-muted hover:border-accent/40 hover:text-ink"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : search.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-24" />
            ))}
          </div>
        ) : search.isError ? (
          <ErrorState error={search.error} retry={() => void search.refetch()} />
        ) : search.data?.mode === 'hybrid' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-faint">
              <Badge tone="accent">intent: {search.data.understood.intent}</Badge>
              {search.data.retrievers.map((retriever) => (
                <Badge key={retriever.name} tone={retriever.error ? 'danger' : 'neutral'}>
                  {retriever.name}: {retriever.error ? 'error' : retriever.hits}
                </Badge>
              ))}
              <span>expanded terms: {search.data.understood.terms.slice(0, 12).join(', ')}</span>
            </div>

            {search.data.results.length === 0 ? (
              <EmptyState
                title="No indexed code matched"
                description="Try naming a specific file, function or endpoint, or re-index if the repository changed."
                icon={<Sparkles className="h-8 w-8" />}
              />
            ) : (
              search.data.results.map((result) => (
                <Card key={result.chunkId} className="overflow-hidden">
                  <button
                    onClick={() => open(result.filePath, result.startLine)}
                    className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left hover:bg-surface-raised"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="truncate font-mono text-xs text-accent">
                        {result.filePath}:{result.startLine}-{result.endLine}
                      </span>
                      {result.symbolName ? (
                        <Badge tone="neutral">
                          {result.symbolType} {result.symbolName}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {result.matchedBy.map((matcher) => (
                        <Badge key={matcher} tone="neutral">
                          {matcher}
                        </Badge>
                      ))}
                      <span className="font-mono text-2xs text-ink-faint">{result.score.toFixed(4)}</span>
                    </span>
                  </button>
                  <pre className="max-h-52 overflow-auto p-3 font-mono text-2xs leading-relaxed text-ink-muted">
                    {result.snippet}
                  </pre>
                </Card>
              ))
            )}
          </div>
        ) : search.data?.mode === 'text' ? (
          <Card>
            {search.data.matches.length === 0 ? (
              <EmptyState title="No matches" description="No indexed file contains that text." />
            ) : (
              <ul className="divide-y divide-line">
                {search.data.matches.map((match, index) => (
                  <li key={`${match.filePath}-${match.line}-${index}`}>
                    <button
                      onClick={() => open(match.filePath, match.line)}
                      className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left hover:bg-surface-raised"
                    >
                      <span className="w-72 shrink-0 truncate font-mono text-2xs text-accent">
                        {match.filePath}:{match.line}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">{match.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : search.data?.mode === 'symbol' ? (
          <Card>
            {search.data.symbols.length === 0 ? (
              <EmptyState title="No symbols matched" description="No indexed function, class or type has that name." />
            ) : (
              <ul className="divide-y divide-line">
                {search.data.symbols.map((symbol) => (
                  <li key={symbol.id}>
                    <button
                      onClick={() => open(symbol.filePath, symbol.startLine)}
                      className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-surface-raised"
                    >
                      <span className="w-20 shrink-0 text-2xs text-ink-faint">{symbol.kind}</span>
                      <span className="w-56 shrink-0 truncate font-mono text-xs text-ink">{symbol.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-accent">
                        {symbol.filePath}:{symbol.startLine}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
