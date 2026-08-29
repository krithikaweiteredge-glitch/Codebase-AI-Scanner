import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Search,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CodeViewer, type CodeHighlight } from '@/components/CodeViewer';
import { Markdown } from '@/components/Markdown';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  SeverityBadge,
  Skeleton,
  Tabs,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, post } from '@/lib/api';
import type { FileDetail, RepositoryFileSummary } from '@/lib/types';
import { cn, formatNumber } from '@/lib/utils';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: RepositoryFileSummary;
}

export function CodeExplorerPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const activePath = searchParams.get('path');
  const activeLine = searchParams.get('line') ? Number(searchParams.get('line')) : null;
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['src', 'app', 'lib']));
  const [panel, setPanel] = useState<'explain' | 'symbols' | 'relations'>('explain');
  const [selection, setSelection] = useState<{ startLine: number; endLine: number; text: string } | null>(null);
  const [explanation, setExplanation] = useState<{ answer: string; degraded: boolean } | null>(null);

  const files = useQuery({
    queryKey: ['files', repositoryId],
    queryFn: () => get<{ branch: string; files: RepositoryFileSummary[] }>(`/api/repositories/${repositoryId}/files`),
    enabled: Boolean(repositoryId),
  });

  const activeFile = files.data?.files.find((file) => file.path === activePath) ?? null;

  const detail = useQuery({
    queryKey: ['file-detail', activeFile?.id],
    queryFn: () => get<FileDetail>(`/api/repositories/${repositoryId}/files/${activeFile!.id}`),
    enabled: Boolean(activeFile),
  });

  const explain = useMutation({
    mutationFn: (body: { filePath: string; symbolName?: string; startLine?: number; endLine?: number; question?: string }) =>
      post<{ answer: string; degraded: boolean }>(`/api/repositories/${repositoryId}/explain`, body),
    onSuccess: (data) => setExplanation({ answer: data.answer, degraded: data.degraded }),
    onError: (error: Error) => toast.error('Explanation failed', error.message),
  });

  useEffect(() => {
    setExplanation(null);
    setSelection(null);
  }, [activePath]);

  const tree = useMemo(() => buildTree(files.data?.files ?? [], filter), [files.data, filter]);

  const highlights: CodeHighlight[] = useMemo(() => {
    const list: CodeHighlight[] = (detail.data?.findings ?? [])
      .filter((finding) => finding.startLine && !finding.falsePositive)
      .map((finding) => ({
        startLine: finding.startLine!,
        endLine: finding.endLine ?? finding.startLine!,
        tone: finding.severity === 'critical' || finding.severity === 'high' ? 'danger' : 'warn',
        message: `**${finding.severity.toUpperCase()} · ${finding.title}**\n\n${finding.description}`,
      }));
    if (activeLine) list.push({ startLine: activeLine, tone: 'accent' });
    return list;
  }, [detail.data, activeLine]);

  const openFile = (path: string, line?: number): void => {
    const params = new URLSearchParams({ path });
    if (line) params.set('line', String(line));
    setSearchParams(params, { replace: false });
  };

  if (files.isLoading) {
    return (
      <div className="flex h-full">
        <Skeleton className="m-3 h-[calc(100%-1.5rem)] w-64" />
        <Skeleton className="m-3 h-[calc(100%-1.5rem)] flex-1" />
      </div>
    );
  }

  if (files.isError) return <ErrorState error={files.error} retry={() => void files.refetch()} />;

  if (!files.data?.files.length) {
    return (
      <EmptyState
        title="No indexed files"
        description="Run an analysis on this repository to index its files, then browse them here."
        action={<Button onClick={() => navigate(`/repositories/${repositoryId}`)}>Go to repository overview</Button>}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* File tree */}
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files…"
              className="pl-7"
            />
          </div>
          <p className="mt-1.5 px-1 text-2xs text-ink-faint">
            {formatNumber(files.data.files.length)} files · branch {files.data.branch}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <TreeView
            node={tree}
            depth={0}
            expanded={expanded}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            activePath={activePath}
            onOpen={openFile}
            forceOpen={filter.length > 1}
          />
        </div>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeFile && detail.data ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <Breadcrumbs path={activeFile.path} />
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {detail.data.file.language ? <Badge tone="neutral">{detail.data.file.language}</Badge> : null}
                  {detail.data.file.role && detail.data.file.role !== 'unknown' ? (
                    <Badge tone="accent">{detail.data.file.role}</Badge>
                  ) : null}
                  <Badge tone="neutral">{formatNumber(detail.data.file.lineCount)} lines</Badge>
                  <Badge tone="neutral">complexity {detail.data.file.complexity}</Badge>
                  {detail.data.file.hasSecrets ? (
                    <Badge tone="danger">
                      <TriangleAlert className="h-3 w-3" /> secret detected
                    </Badge>
                  ) : null}
                  {detail.data.findings.length ? (
                    <Badge tone="warn">{detail.data.findings.length} findings</Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {selection ? (
                  <Button
                    onClick={() =>
                      explain.mutate({
                        filePath: activeFile.path,
                        startLine: selection.startLine,
                        endLine: selection.endLine,
                      })
                    }
                    loading={explain.isPending}
                  >
                    <Sparkles className="h-3 w-3" /> Explain selection ({selection.startLine}–{selection.endLine})
                  </Button>
                ) : (
                  <Button onClick={() => explain.mutate({ filePath: activeFile.path })} loading={explain.isPending}>
                    <Sparkles className="h-3 w-3" /> Explain file
                  </Button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <CodeViewer
                value={detail.data.file.content ?? ''}
                path={detail.data.file.path}
                language={detail.data.file.language}
                highlights={highlights}
                revealLine={activeLine}
                onSelectionChange={setSelection}
              />
            </div>
          </>
        ) : (
          <EmptyState
            title="Select a file"
            description="Pick a file from the tree, or jump straight to one from a finding, a search result or a chat citation."
            icon={<FileCode2 className="h-8 w-8" />}
          />
        )}
      </div>

      {/* AI / structure panel */}
      <div className="flex w-96 shrink-0 flex-col border-l border-line">
        <Tabs
          value={panel}
          onChange={setPanel}
          className="px-2"
          items={[
            { value: 'explain', label: 'AI' },
            { value: 'symbols', label: 'Symbols', count: detail.data?.symbols.length },
            {
              value: 'relations',
              label: 'Relations',
              count: (detail.data?.imports.length ?? 0) + (detail.data?.importedBy.length ?? 0),
            },
          ]}
        />

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!activeFile ? (
            <p className="px-1 text-xs text-ink-faint">Open a file to see its explanation, symbols and relations.</p>
          ) : panel === 'explain' ? (
            explain.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : explanation ? (
              <>
                {explanation.degraded ? (
                  <div className="mb-2 rounded border border-warn/30 bg-warn/5 px-2 py-1.5 text-2xs text-ink-muted">
                    No generative provider configured — showing retrieval results only.
                  </div>
                ) : null}
                <Markdown content={explanation.answer} onOpenReference={(path, line) => openFile(path, line)} />
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-ink-muted">
                  Ask about this file, or select code in the editor and explain just that range. Answers are built from
                  the indexed repository and cite real files and lines.
                </p>
                <div className="space-y-1.5">
                  {[
                    'What does this file do?',
                    'What calls into this file?',
                    'What are the risks or edge cases here?',
                    'What should I test in this file?',
                  ].map((question) => (
                    <button
                      key={question}
                      onClick={() => explain.mutate({ filePath: activeFile.path, question })}
                      className="w-full rounded border border-line bg-surface-raised px-2.5 py-1.5 text-left text-xs text-ink-muted hover:border-accent/40 hover:text-ink"
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : panel === 'symbols' ? (
            <ul className="space-y-0.5">
              {detail.data?.symbols.map((symbol) => (
                <li key={symbol.id}>
                  <button
                    onClick={() => openFile(activeFile.path, symbol.startLine)}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised"
                  >
                    <span className="w-16 shrink-0 truncate text-2xs text-ink-faint">{symbol.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{symbol.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-ink-faint">{symbol.startLine}</span>
                  </button>
                </li>
              ))}
              {detail.data?.symbols.length === 0 ? (
                <p className="px-1 text-xs text-ink-faint">No symbols were extracted from this file.</p>
              ) : null}
            </ul>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-faint">
                  Imports ({detail.data?.imports.length ?? 0})
                </p>
                <ul className="space-y-0.5">
                  {detail.data?.imports.map((dependency, index) => (
                    <li key={`${dependency.specifier}-${index}`}>
                      {dependency.target ? (
                        <button
                          onClick={() => openFile(dependency.target!.path)}
                          className="block w-full truncate rounded px-2 py-1 text-left font-mono text-2xs text-accent hover:bg-surface-raised"
                        >
                          {dependency.target.path}
                        </button>
                      ) : (
                        <span className="block truncate px-2 py-1 font-mono text-2xs text-ink-faint">
                          {dependency.specifier} <span className="text-ink-faint/70">(external)</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-faint">
                  Imported by ({detail.data?.importedBy.length ?? 0})
                </p>
                <ul className="space-y-0.5">
                  {detail.data?.importedBy.map((dependent) => (
                    <li key={dependent.id}>
                      <button
                        onClick={() => openFile(dependent.path)}
                        className="block w-full truncate rounded px-2 py-1 text-left font-mono text-2xs text-accent hover:bg-surface-raised"
                      >
                        {dependent.path}
                      </button>
                    </li>
                  ))}
                  {detail.data?.importedBy.length === 0 ? (
                    <p className="px-2 text-2xs text-ink-faint">Nothing in the index imports this file.</p>
                  ) : null}
                </ul>
              </div>

              {detail.data?.findings.length ? (
                <div>
                  <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-faint">
                    Findings in this file ({detail.data.findings.length})
                  </p>
                  <ul className="space-y-1">
                    {detail.data.findings.map((finding) => (
                      <li key={finding.id}>
                        <button
                          onClick={() => openFile(activeFile.path, finding.startLine ?? 1)}
                          className="w-full rounded border border-line bg-surface-raised px-2 py-1.5 text-left hover:border-accent/40"
                        >
                          <span className="flex items-center gap-1.5">
                            <SeverityBadge severity={finding.severity} />
                            <span className="truncate text-2xs text-ink">{finding.title}</span>
                          </span>
                          <span className="mt-0.5 block font-mono text-2xs text-ink-faint">line {finding.startLine}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Breadcrumbs({ path }: { path: string }) {
  const segments = path.split('/');
  return (
    <nav className="flex items-center gap-1 overflow-hidden font-mono text-xs">
      {segments.map((segment, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 ? <span className="text-ink-faint">/</span> : null}
          <span className={index === segments.length - 1 ? 'text-ink' : 'text-ink-faint'}>{segment}</span>
        </span>
      ))}
    </nav>
  );
}

function buildTree(files: RepositoryFileSummary[], filter: string): TreeNode {
  const needle = filter.trim().toLowerCase();
  const root: TreeNode = { name: '', path: '', children: new Map() };

  for (const file of files) {
    if (needle && !file.path.toLowerCase().includes(needle)) continue;
    const segments = file.path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join('/');
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, path, children: new Map() };
        node.children.set(segment, child);
      }
      if (isLeaf) child.file = file;
      node = child;
    });
  }
  return root;
}

function TreeView({
  node,
  depth,
  expanded,
  onToggle,
  activePath,
  onOpen,
  forceOpen,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  activePath: string | null;
  onOpen: (path: string) => void;
  forceOpen: boolean;
}) {
  const entries = [...node.children.values()].sort((a, b) => {
    const aIsDir = a.children.size > 0;
    const bIsDir = b.children.size > 0;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <ul>
      {entries.map((child) => {
        const isDirectory = child.children.size > 0;
        const isOpen = forceOpen || expanded.has(child.path);

        if (isDirectory) {
          return (
            <li key={child.path}>
              <button
                onClick={() => onToggle(child.path)}
                className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-ink-muted hover:bg-surface-raised"
                style={{ paddingLeft: `${depth * 10 + 8}px` }}
              >
                {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                {isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                )}
                <span className="truncate">{child.name}</span>
              </button>
              {isOpen ? (
                <TreeView
                  node={child}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  activePath={activePath}
                  onOpen={onOpen}
                  forceOpen={forceOpen}
                />
              ) : null}
            </li>
          );
        }

        return (
          <li key={child.path}>
            <button
              onClick={() => onOpen(child.path)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs hover:bg-surface-raised',
                activePath === child.path ? 'bg-accent-subtle text-accent' : 'text-ink-muted',
              )}
              style={{ paddingLeft: `${depth * 10 + 22}px` }}
              title={child.path}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="truncate">{child.name}</span>
              {child.file?.hasSecrets ? <TriangleAlert className="h-3 w-3 shrink-0 text-danger" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
