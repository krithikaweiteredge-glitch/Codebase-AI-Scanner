import * as path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { repositoryTooLarge } from '../errors';
import { sha256 } from '../lib/crypto';
import { chunkArray, mapPool } from '../lib/pool';
import { countLines, looksBinary } from '../lib/text';
import { getEmbeddingProvider } from '../ai/embeddings';
import { githubClientForRepository } from '../github/service';
import type { GitHubClient, GitHubTreeEntry } from '../github/client';
import { insertChunks, type ChunkInsert } from '../search/chunkStore';
import { chunkFile } from './chunker';
import { buildIgnoreMatcher } from './ignore';
import { detectLanguage, detectRole, isConfigFile, isTestFile, looksGenerated, type Language } from './languages';
import { parseFile } from './parsers';
import type { ParsedSymbol } from './parsers/types';
import { detectHttpCalls, matchCallToRoute } from './httpCalls';
import { initTreeSitter } from './parsers';
import { buildStackProfile, type IndexedFileSummary, type StackProfile } from './projectMap';
import type { RunProgress } from './progress';
import { detectSecrets } from './secrets';

export interface IndexOptions {
  repositoryId: string;
  userId: string;
  branchName: string;
  incremental: boolean;
}

export interface IndexResult {
  commitSha: string;
  branchId: string;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  filesSkipped: number;
  skippedReasons: Record<string, number>;
  symbols: number;
  chunks: number;
  embeddedChunks: number;
  dependencies: number;
  totalLines: number;
  stack: StackProfile;
  treeTruncated: boolean;
}

interface FetchedFile {
  path: string;
  blobSha: string;
  content: string;
  sizeBytes: number;
  language: Language;
}

const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.java',
  '.cs',
  '.rb',
  '.php',
  '.rs',
  '.vue',
  '.svelte',
];

/**
 * Full indexing pipeline:
 *   discover -> filter -> fetch -> parse (AST) -> chunk -> embed -> persist -> graph
 *
 * The repository is never cloned or executed; contents come from the GitHub
 * Git Data API and are only ever read as text.
 */
export async function indexRepository(options: IndexOptions, progress: RunProgress): Promise<IndexResult> {
  const repository = await prisma.repository.findUniqueOrThrow({ where: { id: options.repositoryId } });
  const github = await githubClientForRepository(repository.id, options.userId);

  // ---- 1. connect --------------------------------------------------------
  await progress.start('connect', `${repository.fullName} @ ${options.branchName}`);
  const branchInfo = await github.getBranch(repository.owner, repository.name, options.branchName);
  const commitSha = branchInfo.commit.sha;

  const branch = await prisma.repositoryBranch.upsert({
    where: { repositoryId_name: { repositoryId: repository.id, name: options.branchName } },
    create: {
      repositoryId: repository.id,
      name: options.branchName,
      commitSha,
      isDefault: repository.defaultBranch === options.branchName,
    },
    update: { commitSha },
  });

  await recordCommits(github, repository.owner, repository.name, repository.id, options.branchName, commitSha);
  await progress.complete('connect', `HEAD ${commitSha.slice(0, 7)}`);

  // ---- 2. discover -------------------------------------------------------
  await progress.start('discover');
  const tree = await github.getTree(repository.owner, repository.name, commitSha);
  const matcher = buildIgnoreMatcher(repository.ignorePatterns);

  const skippedReasons: Record<string, number> = {};
  const skip = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };

  const candidates: GitHubTreeEntry[] = [];
  let totalBytes = 0;

  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (matcher.ignores(entry.path)) {
      skip('ignored by pattern');
      continue;
    }
    const size = entry.size ?? 0;
    if (size > env.MAX_FILE_BYTES) {
      skip('file larger than MAX_FILE_BYTES');
      continue;
    }
    if (detectLanguage(entry.path) === 'unknown' && size > 50_000) {
      skip('unrecognised large file');
      continue;
    }
    totalBytes += size;
    candidates.push(entry);
  }

  if (candidates.length > env.MAX_REPO_FILES) {
    throw repositoryTooLarge(
      `This repository has ${candidates.length} indexable files, above the MAX_REPO_FILES limit of ${env.MAX_REPO_FILES}. ` +
        'Raise the limit or add ignore patterns for directories you do not need.',
    );
  }
  if (totalBytes > env.MAX_TOTAL_BYTES) {
    throw repositoryTooLarge(
      `Indexable content is ${(totalBytes / 1e6).toFixed(1)} MB, above the MAX_TOTAL_BYTES limit.`,
    );
  }

  await progress.complete(
    'discover',
    `${candidates.length} files to index, ${Object.values(skippedReasons).reduce((a, b) => a + b, 0)} skipped${
      tree.truncated ? ' (GitHub truncated the tree listing)' : ''
    }`,
  );

  // ---- 3. incremental diff ----------------------------------------------
  const existing = await prisma.repositoryFile.findMany({
    where: { branchId: branch.id },
    select: { id: true, path: true, blobSha: true },
  });
  const existingByPath = new Map(existing.map((f) => [f.path, f]));
  const candidatePaths = new Set(candidates.map((c) => c.path));

  const removed = existing.filter((f) => !candidatePaths.has(f.path));

  // An incremental run keeps the vectors of unchanged files. That is only
  // sound while every stored vector came from the same model: embeddings from
  // different models occupy different spaces, and comparing across them
  // produces confident nonsense rather than an obvious failure. Switching
  // EMBEDDING_PROVIDER therefore forces a full re-index.
  const embeddingDrift = await hasEmbeddingModelDrift(branch.id, getEmbeddingProvider().model);
  const incremental = options.incremental && !embeddingDrift;
  if (embeddingDrift) {
    await progress.detail('discover', 'embedding model changed since the last index - re-embedding everything');
  }

  const changed = incremental
    ? candidates.filter((c) => existingByPath.get(c.path)?.blobSha !== c.sha)
    : candidates;
  const unchangedPaths = incremental
    ? candidates.filter((c) => existingByPath.get(c.path)?.blobSha === c.sha).map((c) => c.path)
    : [];

  // ---- 4. fetch ----------------------------------------------------------
  await progress.start('fetch', `${changed.length} file(s) to download`);
  let fetched = 0;
  const files = (
    await mapPool(changed, env.INDEX_CONCURRENCY, async (entry) => {
      try {
        const buffer = await github.getBlob(repository.owner, repository.name, entry.sha);
        fetched++;
        if (fetched % 50 === 0) await progress.detail('fetch', `${fetched}/${changed.length} downloaded`);
        if (looksBinary(buffer)) {
          skip('binary content');
          return null;
        }
        return {
          path: entry.path,
          blobSha: entry.sha,
          content: buffer.toString('utf8'),
          sizeBytes: buffer.byteLength,
          language: detectLanguage(entry.path),
        } satisfies FetchedFile;
      } catch {
        skip('download failed');
        return null;
      }
    })
  ).filter((f): f is FetchedFile => f !== null);

  await progress.complete('fetch', `${files.length} files downloaded`);

  if (removed.length) {
    await prisma.repositoryFile.deleteMany({ where: { id: { in: removed.map((f) => f.id) } } });
  }

  // ---- 5. persist files + symbols + chunks -------------------------------
  await progress.start('languages');
  await progress.complete('languages');
  await progress.start('ast');

  const embedder = getEmbeddingProvider();
  let symbolCount = 0;
  let chunkCount = 0;
  let embeddedCount = 0;
  let totalLines = 0;
  // Load the WebAssembly grammars before anything is parsed. Without this
  // Python, Go and Java silently keep their regular-expression analyzers,
  // which is the behaviour this replaces rather than an error.
  await initTreeSitter();

  const importsByPath = new Map<string, { specifier: string; kind: string }[]>();
  const summaries: IndexedFileSummary[] = [];

  let processed = 0;
  for (const batch of chunkArray(files, 25)) {
    const prepared = batch.map((file) => {
      const parsed = parseFile(file.path, file.content, file.language);
      const lineCount = countLines(file.content);
      const role = detectRole(file.path, file.content);
      const secrets = detectSecrets(file.content);
      const chunks = chunkFile({ filePath: file.path, content: file.content, symbols: parsed.symbols });
      return { file, parsed, lineCount, role, secrets, chunks };
    });

    // Embed the chunks worth embedding, in one provider round-trip. A vector is
    // 6,152 bytes and dominates storage - roughly twenty times the source it
    // describes once the index is counted - so spending one on a stylesheet or
    // a static asset buys nothing: nobody asks a codebase a question that a
    // rule block answers, and keyword and trigram search still reach them
    // because the chunk itself is stored either way.
    const embeddable = prepared.flatMap((p) => p.chunks.map(() => isEmbeddableFile(p.file.path, p.file.language)));
    const chunkTexts = prepared
      .flatMap((p) => p.chunks.map((c) => embeddingText(p.file.path, c.symbolName, c.symbolType, c.content)))
      .filter((_, index) => embeddable[index]);
    let vectors: number[][] = [];
    if (chunkTexts.length) {
      try {
        vectors = await embedder.embed(chunkTexts);
      } catch {
        vectors = [];
      }
    }

    let vectorCursor = 0;
    let embeddableCursor = 0;
    for (const item of prepared) {
      const { file, parsed, lineCount, role, secrets, chunks } = item;
      totalLines += lineCount;

      const record = await prisma.repositoryFile.upsert({
        where: { branchId_path: { branchId: branch.id, path: file.path } },
        create: {
          repositoryId: repository.id,
          branchId: branch.id,
          path: file.path,
          name: path.posix.basename(file.path),
          extension: path.posix.extname(file.path) || null,
          language: file.language,
          role: role.role,
          sizeBytes: file.sizeBytes,
          lineCount,
          blobSha: file.blobSha,
          contentHash: sha256(file.content),
          content: file.content,
          isTest: isTestFile(file.path),
          isConfig: isConfigFile(file.path),
          isGenerated: looksGenerated(file.content),
          hasSecrets: secrets.length > 0,
          complexity: parsed.complexity,
        },
        update: {
          language: file.language,
          role: role.role,
          sizeBytes: file.sizeBytes,
          lineCount,
          blobSha: file.blobSha,
          contentHash: sha256(file.content),
          content: file.content,
          isTest: isTestFile(file.path),
          isConfig: isConfigFile(file.path),
          isGenerated: looksGenerated(file.content),
          hasSecrets: secrets.length > 0,
          complexity: parsed.complexity,
        },
        select: { id: true },
      });

      await prisma.codeSymbol.deleteMany({ where: { fileId: record.id } });
      await prisma.codeChunk.deleteMany({ where: { fileId: record.id } });
      await prisma.dependency.deleteMany({ where: { fromFileId: record.id } });

      if (parsed.symbols.length) {
        await prisma.codeSymbol.createMany({
          data: parsed.symbols.slice(0, 1500).map((s: ParsedSymbol) => ({
            repositoryId: repository.id,
            fileId: record.id,
            name: s.name,
            kind: s.kind,
            signature: s.signature ?? null,
            parentName: s.parentName ?? null,
            startLine: s.startLine,
            endLine: s.endLine,
            exported: s.exported,
            isAsync: s.isAsync,
            complexity: s.complexity,
          })),
        });
        symbolCount += Math.min(parsed.symbols.length, 1500);
      }

      const inserts: ChunkInsert[] = chunks.map((chunk) => {
        // Only embeddable chunks consumed a slot in the vector array.
        const embedding = embeddable[embeddableCursor++] ? (vectors[vectorCursor++] ?? null) : null;
        if (embedding) embeddedCount++;
        return {
          repositoryId: repository.id,
          fileId: record.id,
          symbolName: chunk.symbolName,
          symbolType: chunk.symbolType,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          embedding,
          embeddingModel: embedding ? embedder.model : null,
        };
      });
      if (inserts.length) await insertChunks(inserts);
      chunkCount += inserts.length;

      importsByPath.set(
        file.path,
        parsed.imports.map((i) => ({ specifier: i.specifier, kind: i.kind })),
      );

      summaries.push({
        path: file.path,
        language: file.language,
        role: role.role,
        lineCount,
        sizeBytes: file.sizeBytes,
        isTest: isTestFile(file.path),
        isConfig: isConfigFile(file.path),
        content: file.content,
        imports: parsed.imports.map((i) => i.specifier),
      });

      processed++;
    }
    await progress.detail('ast', `${processed}/${files.length} files parsed`);
  }

  await progress.complete('ast', `${symbolCount} symbols extracted`);
  await progress.start('chunks');
  await progress.complete('chunks', `${chunkCount} semantic chunks`);
  await progress.start('embeddings');
  if (embeddedCount === 0 && chunkCount > 0) {
    await progress.fail('embeddings', 'Embedding provider failed; semantic search will fall back to lexical search');
  } else {
    await progress.complete('embeddings', `${embeddedCount} vectors (${embedder.name}/${embedder.model})`);
  }

  // Bring unchanged files into the project map without re-parsing them.
  if (unchangedPaths.length) {
    for (const batch of chunkArray(unchangedPaths, 200)) {
      const rows = await prisma.repositoryFile.findMany({
        where: { branchId: branch.id, path: { in: batch } },
        select: {
          path: true,
          language: true,
          role: true,
          lineCount: true,
          sizeBytes: true,
          isTest: true,
          isConfig: true,
          content: true,
        },
      });
      for (const row of rows) {
        totalLines += row.lineCount;
        summaries.push({
          path: row.path,
          language: (row.language ?? 'unknown') as Language,
          role: row.role ?? 'unknown',
          lineCount: row.lineCount,
          sizeBytes: row.sizeBytes,
          isTest: row.isTest,
          isConfig: row.isConfig,
          content: row.content ?? '',
          imports: [],
        });
      }
    }
  }

  // ---- 6. project structure ---------------------------------------------
  await progress.start('structure');
  const stack = buildStackProfile(summaries);
  await prisma.repositoryInsight.upsert({
    where: { repositoryId_kind: { repositoryId: repository.id, kind: 'stack' } },
    create: { repositoryId: repository.id, kind: 'stack', data: stack as unknown as Prisma.InputJsonValue },
    update: { data: stack as unknown as Prisma.InputJsonValue },
  });
  await progress.complete(
    'structure',
    `${stack.projectTypes.join(', ')} | ${stack.frameworks.map((f) => f.name).slice(0, 5).join(', ') || 'no framework detected'}`,
  );

  // ---- 7. dependency graph ----------------------------------------------
  await progress.start('dependencies');
  // A frontend calling its own backend over HTTP is not an import, so the graph
  // showed the two halves of a full-stack repository as disconnected islands.
  // Resolve each client call to the route that serves it and record the edge.
  const httpEdges = new Map<string, { specifier: string; kind: string }[]>();
  let matchedCalls = 0;
  for (const file of summaries) {
    if (file.isTest) continue;
    for (const call of detectHttpCalls(file.content, file.language)) {
      const route = matchCallToRoute(call, stack.routes);
      if (!route || route.file === file.path) continue;
      const list = httpEdges.get(file.path) ?? [];
      const specifier = `${call.method ?? 'ANY'} ${call.path}`;
      if (!list.some((e) => e.specifier === specifier)) list.push({ specifier, kind: `http:${route.file}` });
      httpEdges.set(file.path, list);
      matchedCalls++;
    }
  }

  const dependencyCount = await buildDependencyGraph(repository.id, branch.id, importsByPath, httpEdges);
  await progress.complete(
    'dependencies',
    `${dependencyCount} edges${matchedCalls ? `, ${matchedCalls} of them frontend-to-backend calls` : ''}`,
  );

  // ---- 8. finalise -------------------------------------------------------
  await prisma.repositoryBranch.update({
    where: { id: branch.id },
    data: { indexedSha: commitSha, indexedAt: new Date() },
  });
  await prisma.repository.update({
    where: { id: repository.id },
    data: {
      lastAnalyzedAt: new Date(),
      primaryLanguage: stack.languages[0]?.language ?? repository.primaryLanguage,
      languageStats: stack.languages as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    commitSha,
    branchId: branch.id,
    filesIndexed: files.length,
    filesUnchanged: unchangedPaths.length,
    filesRemoved: removed.length,
    filesSkipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
    skippedReasons,
    symbols: symbolCount,
    chunks: chunkCount,
    embeddedChunks: embeddedCount,
    dependencies: dependencyCount,
    totalLines,
    stack,
    treeTruncated: tree.truncated,
  };
}

/**
 * Whether a file's chunks are worth a vector.
 *
 * Stylesheets, markup, static assets and lockfiles are indexed and searchable,
 * but semantic similarity over them answers nothing - and each vector costs
 * 6,152 bytes plus its share of the HNSW index.
 */
export function isEmbeddableFile(filePath: string, language: string): boolean {
  if (/\.(css|scss|sass|less|styl|svg|html?|xml|lock|snap|map|csv|po)$/i.test(filePath)) return false;
  if (/(^|\/)(public|static|assets?|images?|img|fonts?|media)(\/|$)/i.test(filePath)) return false;
  return !['css', 'scss', 'html', 'xml', 'svg', 'markdown', 'text'].includes(language);
}

/** Prefix chunks with their location so the vector carries file/symbol signal. */
function embeddingText(
  filePath: string,
  symbolName: string | null,
  symbolType: string | null,
  content: string,
): string {
  const header = `File: ${filePath}\n${symbolType ? `${symbolType} ` : ''}${symbolName ?? ''}`.trim();
  return `${header}\n${content}`.slice(0, 12_000);
}

async function recordCommits(
  github: GitHubClient,
  owner: string,
  name: string,
  repositoryId: string,
  branchName: string,
  sha: string,
): Promise<void> {
  try {
    const commits = await github.listCommits(owner, name, sha, 20);
    for (const commit of commits) {
      await prisma.repositoryCommit.upsert({
        where: { repositoryId_sha: { repositoryId, sha: commit.sha } },
        create: {
          repositoryId,
          sha: commit.sha,
          branchName,
          message: commit.commit.message.slice(0, 2000),
          authorName: commit.commit.author?.name ?? null,
          authorEmail: commit.commit.author?.email ?? null,
          committedAt: commit.commit.author?.date ? new Date(commit.commit.author.date) : null,
        },
        update: { branchName },
      });
    }
  } catch {
    // Commit history is informational; never fail the run because of it.
  }
}

/**
 * Resolves import specifiers to files in the same branch. Relative specifiers
 * are resolved against the importing file's directory (with extension and
 * `/index` fallbacks); everything else is recorded as an external dependency.
 */
export async function buildDependencyGraph(
  repositoryId: string,
  branchId: string,
  importsByPath: Map<string, { specifier: string; kind: string }[]>,
  /** Client HTTP calls, keyed by caller path; kind carries the target file as `http:<path>`. */
  httpEdges: Map<string, { specifier: string; kind: string }[]> = new Map(),
): Promise<number> {
  if (importsByPath.size === 0 && httpEdges.size === 0) return prisma.dependency.count({ where: { repositoryId } });

  const allFiles = await prisma.repositoryFile.findMany({
    where: { branchId },
    select: { id: true, path: true },
  });
  const byPath = new Map(allFiles.map((f) => [f.path, f.id]));
  const byPathNoExt = new Map<string, string>();
  for (const file of allFiles) {
    const noExt = file.path.replace(/\.[^./]+$/, '');
    if (!byPathNoExt.has(noExt)) byPathNoExt.set(noExt, file.id);
  }

  const rows: { repositoryId: string; fromFileId: string; toFileId: string | null; specifier: string; isExternal: boolean; kind: string }[] = [];

  for (const [fromPath, imports] of importsByPath) {
    const fromId = byPath.get(fromPath);
    if (!fromId) continue;
    const dir = path.posix.dirname(fromPath);

    for (const imp of imports) {
      const relative = imp.specifier.startsWith('.');
      let toFileId: string | null = null;

      if (relative) {
        const base = path.posix.normalize(path.posix.join(dir, imp.specifier)).replace(/^\.\//, '');
        toFileId = resolveTarget(base, byPath, byPathNoExt);
      } else if (imp.specifier.startsWith('/') || imp.specifier.startsWith('src/') || imp.specifier.startsWith('@/')) {
        const base = imp.specifier.replace(/^[@/]+/, '');
        toFileId = resolveTarget(base, byPath, byPathNoExt) ?? resolveTarget(`src/${base}`, byPath, byPathNoExt);
      } else {
        // Some ecosystems (Go, Java) use dotted/slashed package paths that may map to files.
        const asPath = imp.specifier.replace(/\./g, '/');
        toFileId = resolveTarget(asPath, byPath, byPathNoExt);
      }

      rows.push({
        repositoryId,
        fromFileId: fromId,
        toFileId,
        specifier: imp.specifier,
        isExternal: toFileId === null,
        kind: imp.kind,
      });
    }
  }

  // The target is already known by path - these were resolved against the
  // route table, not against a module specifier.
  for (const [fromPath, calls] of httpEdges) {
    const fromId = byPath.get(fromPath);
    if (!fromId) continue;
    for (const call of calls) {
      const toFileId = byPath.get(call.kind.slice('http:'.length)) ?? null;
      if (!toFileId) continue;
      rows.push({ repositoryId, fromFileId: fromId, toFileId, specifier: call.specifier, isExternal: false, kind: 'http' });
    }
  }

  for (const batch of chunkArray(rows, 500)) {
    if (batch.length) await prisma.dependency.createMany({ data: batch });
  }

  // Previously unresolved edges may now resolve (new files added this run).
  const unresolved = await prisma.dependency.findMany({
    where: { repositoryId, toFileId: null },
    select: { id: true, specifier: true, fromFileId: true },
    take: 5000,
  });
  const fromPaths = new Map(allFiles.map((f) => [f.id, f.path]));
  for (const dep of unresolved) {
    if (!dep.specifier.startsWith('.')) continue;
    const fromPath = fromPaths.get(dep.fromFileId);
    if (!fromPath) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), dep.specifier)).replace(/^\.\//, '');
    const target = resolveTarget(base, byPath, byPathNoExt);
    if (target) {
      await prisma.dependency.update({ where: { id: dep.id }, data: { toFileId: target, isExternal: false } });
    }
  }

  return prisma.dependency.count({ where: { repositoryId } });
}

function resolveTarget(
  base: string,
  byPath: Map<string, string>,
  byPathNoExt: Map<string, string>,
): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    const hit = byPath.get(candidate);
    if (hit) return hit;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (!ext) continue;
    const hit = byPath.get(`${base}/index${ext}`);
    if (hit) return hit;
  }
  return byPathNoExt.get(base) ?? null;
}

/**
 * True when any stored vector for this branch came from a different embedding
 * model than the one now configured.
 *
 * `code_chunks.embedding_model` was recorded from the start but never read, so
 * changing provider silently mixed vector spaces - the stored lexical vectors
 * and the new semantic ones would be compared against each other as if
 * comparable. Nothing errors; retrieval just quietly returns rubbish.
 */
export async function hasEmbeddingModelDrift(branchId: string, currentModel: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ embedding_model: string | null }[]>`
    SELECT DISTINCT c.embedding_model
    FROM code_chunks c
    JOIN repository_files f ON f.id = c.file_id
    WHERE f.branch_id = ${branchId}::uuid
      AND c.embedding IS NOT NULL
    LIMIT 10
  `;
  return rows.some((row) => row.embedding_model !== currentModel);
}
