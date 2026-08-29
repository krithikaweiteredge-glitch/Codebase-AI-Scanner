import { sha256 } from '../lib/crypto';
import { estimateTokens } from '../lib/text';
import type { ParsedSymbol } from './parsers/types';

export interface CodeChunkDraft {
  symbolName: string | null;
  symbolType: string | null;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  contentHash: string;
}

const MAX_CHUNK_LINES = 220;
const WINDOW_LINES = 160;
const WINDOW_OVERLAP = 20;
const MIN_GAP_LINES = 3;
/** A class longer than this is represented by its methods rather than as a whole. */
const CLASS_SPLIT_THRESHOLD = 120;

export interface ChunkInput {
  filePath: string;
  content: string;
  symbols: readonly ParsedSymbol[];
}

/**
 * Semantic chunking: one chunk per class / function / method / interface, with
 * uncovered module-level regions captured separately and oversized bodies split
 * into overlapping windows. Line ranges are preserved exactly so every chunk can
 * be cited as `path:start-end`.
 */
export function chunkFile(input: ChunkInput): CodeChunkDraft[] {
  const lines = input.content.split('\n');
  const totalLines = lines.length;
  if (totalLines === 0 || input.content.trim() === '') return [];

  const selected = selectSymbols(input.symbols);
  const drafts: CodeChunkDraft[] = [];

  for (const symbol of selected) {
    const start = clamp(symbol.startLine, 1, totalLines);
    const end = clamp(symbol.endLine, start, totalLines);
    const span = end - start + 1;

    if (span <= MAX_CHUNK_LINES) {
      drafts.push(makeChunk(lines, start, end, symbol.name, symbol.kind));
      continue;
    }
    for (let windowStart = start; windowStart <= end; windowStart += WINDOW_LINES - WINDOW_OVERLAP) {
      const windowEnd = Math.min(end, windowStart + WINDOW_LINES - 1);
      drafts.push(makeChunk(lines, windowStart, windowEnd, symbol.name, symbol.kind));
      if (windowEnd >= end) break;
    }
  }

  // Regions no symbol covers (imports, module-level wiring, config bodies).
  for (const gap of findGaps(drafts, totalLines)) {
    const span = gap.end - gap.start + 1;
    if (span < MIN_GAP_LINES) continue;
    const text = lines.slice(gap.start - 1, gap.end).join('\n');
    if (!text.trim()) continue;

    if (span <= MAX_CHUNK_LINES) {
      drafts.push(makeChunk(lines, gap.start, gap.end, null, 'module'));
      continue;
    }
    for (let windowStart = gap.start; windowStart <= gap.end; windowStart += WINDOW_LINES - WINDOW_OVERLAP) {
      const windowEnd = Math.min(gap.end, windowStart + WINDOW_LINES - 1);
      drafts.push(makeChunk(lines, windowStart, windowEnd, null, 'module'));
      if (windowEnd >= gap.end) break;
    }
  }

  const nonEmpty = drafts.filter((d) => d.content.trim().length > 0);
  nonEmpty.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return dedupe(nonEmpty);
}

function selectSymbols(symbols: readonly ParsedSymbol[]): ParsedSymbol[] {
  const classes = symbols.filter((s) => s.kind === 'class' || s.kind === 'struct');
  const bigClasses = new Set(
    classes.filter((c) => c.endLine - c.startLine + 1 > CLASS_SPLIT_THRESHOLD).map((c) => c.name),
  );

  const chosen: ParsedSymbol[] = [];
  for (const symbol of symbols) {
    // Methods of a small class are already covered by the class chunk.
    if (symbol.kind === 'method' && symbol.parentName && !bigClasses.has(symbol.parentName)) continue;
    // A large class is represented by its members instead of as one blob.
    if ((symbol.kind === 'class' || symbol.kind === 'struct') && bigClasses.has(symbol.name)) continue;
    chosen.push(symbol);
  }

  // Drop symbols fully contained in another chosen symbol (nested functions).
  return chosen.filter(
    (symbol, index) =>
      !chosen.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.startLine <= symbol.startLine &&
          other.endLine >= symbol.endLine &&
          other.endLine - other.startLine <= MAX_CHUNK_LINES &&
          !(other.startLine === symbol.startLine && other.endLine === symbol.endLine && otherIndex > index),
      ),
  );
}

function findGaps(drafts: readonly CodeChunkDraft[], totalLines: number): { start: number; end: number }[] {
  if (drafts.length === 0) return [{ start: 1, end: totalLines }];
  const covered = [...drafts].sort((a, b) => a.startLine - b.startLine);
  const gaps: { start: number; end: number }[] = [];
  let cursor = 1;
  for (const chunk of covered) {
    if (chunk.startLine > cursor) gaps.push({ start: cursor, end: chunk.startLine - 1 });
    cursor = Math.max(cursor, chunk.endLine + 1);
  }
  if (cursor <= totalLines) gaps.push({ start: cursor, end: totalLines });
  return gaps;
}

function makeChunk(
  lines: string[],
  startLine: number,
  endLine: number,
  symbolName: string | null,
  symbolType: string | null,
): CodeChunkDraft {
  const content = lines.slice(startLine - 1, endLine).join('\n');
  return {
    symbolName,
    symbolType,
    startLine,
    endLine,
    content,
    tokenCount: estimateTokens(content),
    contentHash: sha256(`${startLine}:${endLine}:${content}`),
  };
}

function dedupe(drafts: CodeChunkDraft[]): CodeChunkDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    if (seen.has(d.contentHash)) return false;
    seen.add(d.contentHash);
    return true;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
