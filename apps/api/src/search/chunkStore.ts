import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { EMBEDDING_DIMENSIONS } from '../env';
import { chunkArray } from '../lib/pool';

export interface ChunkInsert {
  repositoryId: string;
  fileId: string;
  symbolName: string | null;
  symbolType: string | null;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  contentHash: string;
  embedding: number[] | null;
  embeddingModel: string | null;
}

export interface ChunkHit {
  id: string;
  fileId: string;
  filePath: string;
  language: string | null;
  role: string | null;
  symbolName: string | null;
  symbolType: string | null;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/** pgvector literal: '[1,2,3]' */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}`);
  }
  return `[${vector.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}

/**
 * Bulk insert chunks including their vectors.
 * Prisma cannot bind `vector` columns, so this uses a parameterised raw INSERT
 * (still fully parameterised - no string interpolation of user content).
 */
export async function insertChunks(chunks: readonly ChunkInsert[]): Promise<number> {
  let inserted = 0;

  for (const batch of chunkArray(chunks, 40)) {
    const values: string[] = [];
    const params: unknown[] = [];

    for (const chunk of batch) {
      // Placeholders are numbered from the params array itself. Computing them
      // from a fixed 12-slot stride broke the moment a chunk had no vector:
      // the SQL emitted a literal NULL and skipped that placeholder, while the
      // value was still pushed - leaving a parameter the query never
      // referenced. Postgres cannot infer a type for that and rejects the
      // whole statement (42P18), so one unembedded chunk lost the 40 beside it.
      const slots: string[] = [];
      const bind = (value: unknown, cast = '') => {
        params.push(value);
        slots.push(`$${params.length}${cast}`);
      };

      bind(randomUUID(), '::uuid');
      bind(chunk.repositoryId, '::uuid');
      bind(chunk.fileId, '::uuid');
      bind(chunk.symbolName);
      bind(chunk.symbolType);
      bind(chunk.startLine, '::int');
      bind(chunk.endLine, '::int');
      bind(chunk.content);
      bind(chunk.tokenCount, '::int');
      bind(chunk.contentHash);

      // A chunk with no vector is still worth storing: lexical and symbol
      // search still reach it, and a later run can fill the vector in.
      if (chunk.embedding) bind(toVectorLiteral(chunk.embedding), '::vector');
      else slots.push('NULL');

      bind(chunk.embeddingModel);

      values.push(`(${slots.join(', ')})`);
    }

    const sql =
      `INSERT INTO code_chunks (id, repository_id, file_id, symbol_name, symbol_type, start_line, end_line, ` +
      `content, token_count, content_hash, embedding, embedding_model) VALUES ${values.join(', ')}`;

    inserted += await prisma.$executeRawUnsafe(sql, ...params);
  }

  return inserted;
}

/** Cosine-distance nearest neighbours, restricted to one repository + branch. */
export async function vectorSearch(
  repositoryId: string,
  branchId: string,
  embedding: readonly number[],
  limit: number,
): Promise<ChunkHit[]> {
  const rows = await prisma.$queryRawUnsafe<
    (Omit<ChunkHit, 'score'> & { distance: number })[]
  >(
    `SELECT c.id, c.file_id AS "fileId", f.path AS "filePath", f.language, f.role,
            c.symbol_name AS "symbolName", c.symbol_type AS "symbolType",
            c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            (c.embedding <=> $3::vector) AS distance
       FROM code_chunks c
       JOIN repository_files f ON f.id = c.file_id
      WHERE c.repository_id = $1::uuid
        AND f.branch_id = $2::uuid
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $3::vector
      LIMIT $4`,
    repositoryId,
    branchId,
    toVectorLiteral(embedding),
    limit,
  );

  return rows.map((row) => {
    const { distance, ...rest } = row;
    return { ...rest, score: 1 - Number(distance) };
  });
}

/** Lexical search: full-text over chunk bodies, boosted by identifier matches. */
export async function keywordSearch(
  repositoryId: string,
  branchId: string,
  query: string,
  limit: number,
): Promise<ChunkHit[]> {
  const tsquery = query
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length > 1)
    .slice(0, 12)
    .map((t) => t.replace(/'/g, ''))
    .join(' | ');

  if (!tsquery) return [];

  const rows = await prisma.$queryRawUnsafe<(Omit<ChunkHit, 'score'> & { rank: number })[]>(
    `SELECT c.id, c.file_id AS "fileId", f.path AS "filePath", f.language, f.role,
            c.symbol_name AS "symbolName", c.symbol_type AS "symbolType",
            c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            ts_rank(to_tsvector('english', c.content), to_tsquery('english', $3)) AS rank
       FROM code_chunks c
       JOIN repository_files f ON f.id = c.file_id
      WHERE c.repository_id = $1::uuid
        AND f.branch_id = $2::uuid
        AND to_tsvector('english', c.content) @@ to_tsquery('english', $3)
      ORDER BY rank DESC
      LIMIT $4`,
    repositoryId,
    branchId,
    tsquery,
    limit,
  );

  return rows.map((row) => {
    const { rank, ...rest } = row;
    return { ...rest, score: Number(rank) };
  });
}

/** Identifier search: exact and fuzzy matches on symbol names and file paths. */
export async function symbolSearch(
  repositoryId: string,
  branchId: string,
  terms: readonly string[],
  limit: number,
): Promise<ChunkHit[]> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 2).slice(0, 10);
  if (!cleaned.length) return [];

  const rows = await prisma.$queryRawUnsafe<(Omit<ChunkHit, 'score'> & { sim: number })[]>(
    `SELECT c.id, c.file_id AS "fileId", f.path AS "filePath", f.language, f.role,
            c.symbol_name AS "symbolName", c.symbol_type AS "symbolType",
            c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            GREATEST(
              COALESCE(MAX(similarity(lower(c.symbol_name), lower(t.term))), 0),
              COALESCE(MAX(similarity(lower(f.path), lower(t.term))), 0) * 0.7
            ) AS sim
       FROM code_chunks c
       JOIN repository_files f ON f.id = c.file_id
       CROSS JOIN unnest($3::text[]) AS t(term)
      WHERE c.repository_id = $1::uuid
        AND f.branch_id = $2::uuid
        AND (
          lower(c.symbol_name) LIKE '%' || lower(t.term) || '%'
          OR lower(f.path) LIKE '%' || lower(t.term) || '%'
        )
      GROUP BY c.id, f.path, f.language, f.role
      ORDER BY sim DESC
      LIMIT $4`,
    repositoryId,
    branchId,
    cleaned,
    limit,
  );

  return rows.map((row) => {
    const { sim, ...rest } = row;
    return { ...rest, score: Number(sim) };
  });
}

export async function deleteChunksForFiles(fileIds: readonly string[]): Promise<void> {
  if (!fileIds.length) return;
  await prisma.codeChunk.deleteMany({ where: { fileId: { in: [...fileIds] } } });
}

export async function countEmbeddedChunks(repositoryId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM code_chunks WHERE repository_id = $1::uuid AND embedding IS NOT NULL`,
    repositoryId,
  );
  return Number(rows[0]?.count ?? 0);
}
