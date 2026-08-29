import type { AnalysisFindingDraft } from './types';

export interface DuplicateCandidateUnit {
  filePath: string;
  symbolName: string;
  symbolType: string | null;
  startLine: number;
  endLine: number;
  content: string;
  isTest: boolean;
}

export interface DuplicatePair {
  a: DuplicateCandidateUnit;
  b: DuplicateCandidateUnit;
  similarity: number;
  sharedShingles: number;
}

const SHINGLE_SIZE = 5;
const MIN_LINES = 8;
const MIN_TOKENS = 25;
const MIN_SIMILARITY = 0.72;
const MAX_SHINGLES_PER_UNIT = 600;
/** A shingle shared by more units than this is boilerplate, not duplication. */
const BOILERPLATE_DF = 40;

/**
 * Token-shingle near-duplicate detection.
 *
 * Bodies are normalised (comments and string contents removed, whitespace
 * collapsed), tokenised, and compared with Jaccard similarity over 5-token
 * shingles. An inverted index limits comparisons to units that actually share
 * shingles, so this stays close to linear on real repositories.
 */
export function findDuplicatePairs(units: readonly DuplicateCandidateUnit[]): DuplicatePair[] {
  const prepared: { unit: DuplicateCandidateUnit; shingles: Set<number> }[] = [];

  for (const unit of units) {
    if (unit.endLine - unit.startLine + 1 < MIN_LINES) continue;
    const tokens = tokenize(normalise(unit.content));
    if (tokens.length < MIN_TOKENS) continue;
    const shingles = shingleSet(tokens);
    if (shingles.size < 5) continue;
    prepared.push({ unit, shingles });
  }

  const inverted = new Map<number, number[]>();
  prepared.forEach((entry, index) => {
    for (const shingle of entry.shingles) {
      const list = inverted.get(shingle);
      if (list) list.push(index);
      else inverted.set(shingle, [index]);
    }
  });

  const sharedCounts = new Map<string, number>();
  for (const [, indices] of inverted) {
    if (indices.length < 2 || indices.length > BOILERPLATE_DF) continue;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const key = `${indices[i]}:${indices[j]}`;
        sharedCounts.set(key, (sharedCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: DuplicatePair[] = [];
  for (const [key, shared] of sharedCounts) {
    if (shared < 6) continue;
    const [aIndex, bIndex] = key.split(':').map(Number) as [number, number];
    const a = prepared[aIndex];
    const b = prepared[bIndex];
    if (!a || !b) continue;
    if (a.unit.filePath === b.unit.filePath && a.unit.startLine === b.unit.startLine) continue;

    const union = a.shingles.size + b.shingles.size - shared;
    const similarity = union > 0 ? shared / union : 0;
    if (similarity < MIN_SIMILARITY) continue;

    pairs.push({ a: a.unit, b: b.unit, similarity, sharedShingles: shared });
  }

  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, 60);
}

export function duplicatePairToFinding(pair: DuplicatePair): AnalysisFindingDraft {
  const percent = Math.round(pair.similarity * 100);
  const crossFile = pair.a.filePath !== pair.b.filePath;

  return {
    category: 'duplicate',
    ruleId: 'dup.token-shingle',
    type: crossFile ? 'duplicate-across-files' : 'duplicate-within-file',
    severity: percent >= 90 ? 'medium' : 'low',
    title: `${percent}% similar: ${pair.a.symbolName} and ${pair.b.symbolName}`,
    description:
      `\`${pair.a.symbolName}\` (${pair.a.filePath}:${pair.a.startLine}-${pair.a.endLine}) and ` +
      `\`${pair.b.symbolName}\` (${pair.b.filePath}:${pair.b.startLine}-${pair.b.endLine}) share ` +
      `${percent}% of their normalised token shingles. Changes to one will need to be mirrored in the other.`,
    evidence: `${pair.sharedShingles} shared 5-token shingles; Jaccard similarity ${pair.similarity.toFixed(3)} after removing comments and string contents.`,
    recommendation: crossFile
      ? 'Extract the shared behaviour into one module and have both call sites use it, if the two really do serve the same purpose.'
      : 'Fold the two implementations into a single function with a parameter for the part that differs.',
    filePath: pair.a.filePath,
    startLine: pair.a.startLine,
    endLine: pair.a.endLine,
    relatedFilePath: pair.b.filePath,
    relatedStartLine: pair.b.startLine,
    relatedEndLine: pair.b.endLine,
    similarity: pair.similarity,
    confidence: Math.min(0.95, 0.5 + pair.similarity / 2),
    confidenceLabel: pair.similarity >= 0.85 ? 'high' : 'medium',
    status: pair.similarity >= 0.9 ? 'likely' : 'potential',
    source: 'static',
    metadata: {
      detector: 'token-shingle',
      sharedShingles: pair.sharedShingles,
      unitA: `${pair.a.filePath}:${pair.a.startLine}`,
      unitB: `${pair.b.filePath}:${pair.b.startLine}`,
    },
  };
}

function normalise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^\s*#[^\n]*/gm, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
    .replace(/`(?:[^`\\]|\\.)*`/g, '`S`')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N');
}

function tokenize(source: string): string[] {
  return source.match(/[A-Za-z_$][\w$]*|[^\s\w]/g) ?? [];
}

function shingleSet(tokens: readonly string[]): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    set.add(hashShingle(tokens.slice(i, i + SHINGLE_SIZE)));
    if (set.size >= MAX_SHINGLES_PER_UNIT) break;
  }
  return set;
}

function hashShingle(tokens: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const token of tokens) {
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
