import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Boxes, FileCode2, Search, Sparkles, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '@/lib/api';
import type { Repository, SearchResult } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  group: string;
}

/**
 * Cmd/Ctrl+K palette. Actions are static; below them the same hybrid search the
 * chat pipeline uses streams in live results from the indexed repository.
 */
export function CommandPalette({
  open,
  onClose,
  repositoryId,
  repositories,
}: {
  open: boolean;
  onClose: () => void;
  repositoryId: string | null;
  repositories: Repository[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const isSearchQuery = query.trim().length >= 3 && Boolean(repositoryId);

  const search = useQuery({
    queryKey: ['palette-search', repositoryId, query],
    queryFn: () =>
      get<{ results: SearchResult[] }>(
        `/api/repositories/${repositoryId}/search?q=${encodeURIComponent(query)}&limit=6`,
      ),
    enabled: open && isSearchQuery,
    staleTime: 15_000,
    retry: false,
  });

  const go = (path: string): void => {
    onClose();
    navigate(path);
  };

  const commands = useMemo<Command[]>(() => {
    const base = repositoryId ? `/repositories/${repositoryId}` : '';
    const repositoryCommands: Command[] = repositoryId
      ? [
          { id: 'search', label: 'Search codebase', icon: <Search className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/search`) },
          { id: 'ask', label: 'Ask AI about this codebase', icon: <Sparkles className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/chat`) },
          { id: 'explorer', label: 'Open code explorer', icon: <FileCode2 className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/explorer`) },
          { id: 'analyze', label: 'Analyze repository', hint: 'runs indexing + analysis', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}`) },
          { id: 'security', label: 'Analyze security', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/security`) },
          { id: 'bugs', label: 'Find bugs', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/bugs`) },
          { id: 'prs', label: 'Review a pull request', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/pull-requests`) },
          { id: 'docs', label: 'Generate documentation', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/docs`) },
          { id: 'tests', label: 'Generate tests', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Repository', run: () => go(`${base}/tests`) },
        ]
      : [];

    const repositoryList: Command[] = repositories.slice(0, 8).map((repository) => ({
      id: `repo-${repository.id}`,
      label: repository.fullName,
      hint: repository.indexedBranch ?? repository.defaultBranch,
      icon: <Boxes className="h-3.5 w-3.5" />,
      group: 'Open repository',
      run: () => go(`/repositories/${repository.id}`),
    }));

    const all = [
      ...repositoryCommands,
      ...repositoryList,
      { id: 'connect', label: 'Connect a GitHub repository', icon: <Boxes className="h-3.5 w-3.5" />, group: 'Global', run: () => go('/repositories/connect') },
      { id: 'settings', label: 'Open settings', icon: <Terminal className="h-3.5 w-3.5" />, group: 'Global', run: () => go('/settings') },
    ];

    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((command) => command.label.toLowerCase().includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, repositoryId, repositories]);

  const results = search.data?.results ?? [];
  const totalItems = commands.length + results.length;

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!open) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % Math.max(totalItems, 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (activeIndex < commands.length) commands[activeIndex]?.run();
        else {
          const result = results[activeIndex - commands.length];
          if (result && repositoryId) {
            go(`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(result.filePath)}&line=${result.startLine}`);
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, totalItems, commands, results]);

  if (!open) return null;

  let cursor = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-xl animate-slide-up overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder={repositoryId ? 'Run a command, or search the codebase…' : 'Run a command…'}
            className="h-11 w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="max-h-[24rem] overflow-y-auto py-1">
          {groupBy(commands).map(([group, groupCommands]) => (
            <div key={group}>
              <p className="px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">{group}</p>
              {groupCommands.map((command) => {
                cursor++;
                const index = cursor;
                return (
                  <button
                    key={command.id}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={command.run}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs',
                      index === activeIndex ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:bg-surface-raised',
                    )}
                  >
                    {command.icon}
                    <span className="flex-1 truncate text-ink">{command.label}</span>
                    {command.hint ? <span className="text-2xs text-ink-faint">{command.hint}</span> : null}
                    <ArrowRight className="h-3 w-3 opacity-40" />
                  </button>
                );
              })}
            </div>
          ))}

          {isSearchQuery ? (
            <div>
              <p className="px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                Code matches {search.isFetching ? '· searching…' : ''}
              </p>
              {results.length === 0 && !search.isFetching ? (
                <p className="px-3 py-2 text-2xs text-ink-faint">No indexed code matched.</p>
              ) : null}
              {results.map((result) => {
                cursor++;
                const index = cursor;
                return (
                  <button
                    key={result.chunkId}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() =>
                      go(
                        `/repositories/${repositoryId}/explorer?path=${encodeURIComponent(result.filePath)}&line=${result.startLine}`,
                      )
                    }
                    className={cn(
                      'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left',
                      index === activeIndex ? 'bg-accent-subtle' : 'hover:bg-surface-raised',
                    )}
                  >
                    <span className="flex items-center gap-2 font-mono text-2xs text-ink">
                      <FileCode2 className="h-3 w-3 shrink-0 text-ink-faint" />
                      <span className="truncate">
                        {result.filePath}:{result.startLine}
                      </span>
                      {result.symbolName ? <span className="text-accent">{result.symbolName}</span> : null}
                    </span>
                    <span className="truncate pl-5 font-mono text-2xs text-ink-faint">
                      {result.snippet.split('\n').find((line) => line.trim())?.slice(0, 90)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-2xs text-ink-faint">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}

function groupBy(commands: Command[]): [string, Command[]][] {
  const map = new Map<string, Command[]>();
  for (const command of commands) {
    const list = map.get(command.group) ?? [];
    list.push(command);
    map.set(command.group, list);
  }
  return [...map.entries()];
}
