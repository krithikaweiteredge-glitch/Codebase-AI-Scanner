import { FileCode2, AlertTriangle } from 'lucide-react';
import type { Citation, ContextSource } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Sources shown under every answer. Only citations that were validated against
 * the index are listed; invalid ones are shown separately as removed.
 */
export function CitationList({
  citations,
  invalid,
  sources,
  onOpen,
  className,
}: {
  citations: Citation[];
  invalid?: Citation[];
  sources?: ContextSource[];
  onOpen?: (filePath: string, line?: number) => void;
  className?: string;
}) {
  if (!citations.length && !sources?.length) return null;

  return (
    <div className={cn('mt-3 border-t border-line pt-3', className)}>
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
        Sources · verified against the index
      </p>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation, index) => (
          <button
            key={`${citation.filePath}-${citation.startLine}-${index}`}
            onClick={() => onOpen?.(citation.filePath, citation.startLine ?? undefined)}
            title={citation.note ?? citation.filePath}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-surface-raised px-2 py-1
              font-mono text-2xs text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
          >
            <FileCode2 className="h-3 w-3" />
            <span className="max-w-[22rem] truncate">
              {citation.filePath}
              {citation.startLine ? `:${citation.startLine}` : ''}
              {citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ''}
            </span>
          </button>
        ))}
      </div>

      {invalid && invalid.length > 0 ? (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-warn/30 bg-warn/5 px-2 py-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
          <p className="text-2xs leading-relaxed text-ink-muted">
            {invalid.length} reference{invalid.length === 1 ? '' : 's'} in the answer did not resolve to indexed files and
            {invalid.length === 1 ? ' was' : ' were'} discarded:{' '}
            <span className="font-mono">{invalid.map((c) => c.filePath).join(', ')}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Retrieval trace - which retriever surfaced what, and how much context was used. */
export function RetrievalTrace({
  retrieval,
  usage,
}: {
  retrieval: {
    intent: string;
    retrievers: { name: string; hits: number; error?: string }[];
    chunksConsidered: number;
    chunksIncluded: number;
    contextTokens: number;
    redactions: number;
  };
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number } | null;
}) {
  return (
    <details className="mt-2 text-2xs text-ink-faint">
      <summary className="cursor-pointer select-none hover:text-ink-muted">Retrieval trace</summary>
      <div className="mt-1.5 space-y-1 rounded border border-line bg-canvas p-2 font-mono">
        <div>intent: {retrieval.intent}</div>
        <div>
          retrievers:{' '}
          {retrieval.retrievers.map((r) => `${r.name}=${r.error ? `error(${r.error})` : r.hits}`).join('  ')}
        </div>
        <div>
          chunks: {retrieval.chunksIncluded} used / {retrieval.chunksConsidered} ranked · {retrieval.contextTokens} ctx
          tokens
          {retrieval.redactions > 0 ? ` · ${retrieval.redactions} secret(s) redacted` : ''}
        </div>
        {usage ? (
          <div>
            model: {usage.provider}/{usage.model} · in {usage.inputTokens} / out {usage.outputTokens} · {usage.latencyMs}
            ms
          </div>
        ) : null}
      </div>
    </details>
  );
}
