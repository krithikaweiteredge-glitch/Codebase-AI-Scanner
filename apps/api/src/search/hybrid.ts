import { getEmbeddingProvider } from '../ai/embeddings';
import { prisma } from '../db';
import { keywordSearch, symbolSearch, vectorSearch, type ChunkHit } from './chunkStore';
import { understandQuery, type UnderstoodQuery } from './queryUnderstanding';

export interface RetrievedChunk extends ChunkHit {
  /** Which retrievers surfaced this chunk. */
  matchedBy: string[];
  /** Fused rank score (higher is better). */
  fusedScore: number;
  ranks: Record<string, number>;
}

export interface SearchOptions {
  repositoryId: string;
  branchId: string;
  query: string;
  limit?: number;
  /** Per-retriever candidate depth. */
  candidateDepth?: number;
  pathPrefix?: string;
  language?: string;
}

export interface SearchOutcome {
  understood: UnderstoodQuery;
  results: RetrievedChunk[];
  retrievers: { name: string; hits: number; error?: string }[];
}

/** Reciprocal-rank-fusion constant. */
const RRF_K = 60;

const ROLE_BOOST = 0.35;
const LITERAL_BOOST = 0.5;
const TEST_PENALTY = 0.25;

/**
 * Hybrid retrieval: dense (pgvector) + lexical (full-text) + symbol/path search,
 * fused with reciprocal rank fusion and then re-ranked with cheap structural
 * signals (role match, literal identifier match, test-file penalty).
 */
export async function hybridSearch(options: SearchOptions): Promise<SearchOutcome> {
  const understood = understandQuery(options.query);
  const limit = options.limit ?? 20;
  const depth = options.candidateDepth ?? Math.max(limit * 3, 40);

  const retrievers: { name: string; hits: number; error?: string }[] = [];

  const runRetriever = async (name: string, fn: () => Promise<ChunkHit[]>): Promise<ChunkHit[]> => {
    try {
      const hits = await fn();
      retrievers.push({ name, hits: hits.length });
      return hits;
    } catch (error) {
      retrievers.push({ name, hits: 0, error: (error as Error).message });
      return [];
    }
  };

  const [dense, lexical, symbolic] = await Promise.all([
    runRetriever('semantic', async () => {
      const embedder = getEmbeddingProvider();
      const [embedding] = await embedder.embed([options.query]);
      if (!embedding) return [];
      return vectorSearch(options.repositoryId, options.branchId, embedding, depth);
    }),
    runRetriever('keyword', () =>
      keywordSearch(options.repositoryId, options.branchId, [understood.raw, ...understood.terms].join(' '), depth),
    ),
    runRetriever('symbol', () =>
      symbolSearch(options.repositoryId, options.branchId, [...understood.literals, ...understood.terms], depth),
    ),
  ]);

  const fused = new Map<string, RetrievedChunk>();

  const fuse = (name: string, hits: ChunkHit[], weight = 1): void => {
    hits.forEach((hit, index) => {
      const existing = fused.get(hit.id);
      const contribution = (weight * 1) / (RRF_K + index + 1);
      if (existing) {
        existing.fusedScore += contribution;
        existing.matchedBy.push(name);
        existing.ranks[name] = index + 1;
      } else {
        fused.set(hit.id, {
          ...hit,
          matchedBy: [name],
          fusedScore: contribution,
          ranks: { [name]: index + 1 },
        });
      }
    });
  };

  fuse('semantic', dense, 1);
  fuse('keyword', lexical, 1);
  fuse('symbol', symbolic, 0.9);

  const literalsLower = understood.literals.map((l) => l.toLowerCase());
  const preferredRoles = new Set(understood.preferredRoles);

  const ranked = [...fused.values()]
    .filter((chunk) => {
      if (options.pathPrefix && !chunk.filePath.startsWith(options.pathPrefix)) return false;
      if (options.language && chunk.language !== options.language) return false;
      return true;
    })
    .map((chunk) => {
      let score = chunk.fusedScore;
      const haystack = `${chunk.filePath} ${chunk.symbolName ?? ''}`.toLowerCase();

      if (chunk.role && preferredRoles.has(chunk.role)) score *= 1 + ROLE_BOOST;
      if (literalsLower.some((literal) => haystack.includes(literal))) score *= 1 + LITERAL_BOOST;
      if (/(^|\/)(tests?|__tests__|spec)(\/|$)/.test(chunk.filePath) || /\.(test|spec)\./.test(chunk.filePath)) {
        // Tests are still useful context - just not the primary answer.
        score *= understood.intent === 'test' ? 1.2 : 1 - TEST_PENALTY;
      }
      if (chunk.matchedBy.length > 1) score *= 1.15;

      return { ...chunk, fusedScore: score };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, limit);

  return { understood, results: ranked, retrievers };
}

/**
 * Symbol-level lookup used by "find usages" / "jump to symbol" and by the chat
 * pipeline when a question names an identifier directly.
 */
export async function findSymbols(
  repositoryId: string,
  branchId: string,
  name: string,
  limit = 25,
): Promise<
  { id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; signature: string | null }[]
> {
  const rows = await prisma.codeSymbol.findMany({
    where: {
      repositoryId,
      file: { branchId },
      name: { contains: name, mode: 'insensitive' },
    },
    include: { file: { select: { path: true } } },
    take: limit,
    orderBy: [{ exported: 'desc' }, { name: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    filePath: row.file.path,
    startLine: row.startLine,
    endLine: row.endLine,
    signature: row.signature,
  }));
}

/** Literal text search across indexed files (used by the code explorer). */
export async function grepFiles(
  repositoryId: string,
  branchId: string,
  needle: string,
  limit = 100,
): Promise<{ filePath: string; line: number; text: string }[]> {
  if (needle.trim().length < 2) return [];
  const files = await prisma.repositoryFile.findMany({
    where: {
      repositoryId,
      branchId,
      content: { contains: needle, mode: 'insensitive' },
    },
    select: { path: true, content: true },
    take: 200,
  });

  const out: { filePath: string; line: number; text: string }[] = [];
  const lowered = needle.toLowerCase();
  for (const file of files) {
    const lines = (file.content ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.toLowerCase().includes(lowered)) {
        out.push({ filePath: file.path, line: i + 1, text: line.trim().slice(0, 300) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
