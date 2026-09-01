import { redactSecrets } from '../indexer/secrets';
import { estimateTokens } from '../lib/text';
import type { StackProfile } from '../indexer/projectMap';
import type { RetrievedChunk } from './hybrid';

export interface ContextSource {
  ref: string;
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolType: string | null;
  language: string | null;
  role: string | null;
  score: number;
  matchedBy: string[];
}

export interface BuiltContext {
  text: string;
  sources: ContextSource[];
  tokensUsed: number;
  chunksIncluded: number;
  chunksDropped: number;
  redactions: number;
}

interface MergedChunk {
  chunk: RetrievedChunk;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Builds the code context sent to the model.
 *
 * Guarantees:
 *  - every excerpt is real repository content, rendered with its true line numbers
 *  - overlapping excerpts from one file are merged so line numbers stay coherent
 *  - detected secrets are replaced with [REDACTED_SECRET] before the text leaves
 *    this process
 *  - the total stays inside the configured token budget
 */
export function buildCodeContext(chunks: readonly RetrievedChunk[], budgetTokens: number): BuiltContext {
  const merged = mergeOverlaps(chunks);
  const sources: ContextSource[] = [];
  const blocks: string[] = [];

  let tokensUsed = 0;
  let redactions = 0;
  let dropped = 0;

  for (const item of merged) {
    const { content: safeContent, redactions: count } = redactSecrets(item.content);
    const ref = `S${sources.length + 1}`;
    const header =
      `[${ref}] ${item.chunk.filePath}:${item.startLine}-${item.endLine}` +
      `${item.chunk.symbolName ? ` | ${item.chunk.symbolType ?? 'symbol'} ${item.chunk.symbolName}` : ''}` +
      `${item.chunk.role ? ` | role: ${item.chunk.role}` : ''}`;

    const body = numberLines(safeContent, item.startLine);
    const block = `${header}\n\`\`\`${item.chunk.language ?? ''}\n${body}\n\`\`\``;
    const cost = estimateTokens(block);

    if (tokensUsed + cost > budgetTokens) {
      dropped++;
      continue;
    }

    tokensUsed += cost;
    redactions += count;
    blocks.push(block);
    sources.push({
      ref,
      chunkId: item.chunk.id,
      filePath: item.chunk.filePath,
      startLine: item.startLine,
      endLine: item.endLine,
      symbolName: item.chunk.symbolName,
      symbolType: item.chunk.symbolType,
      language: item.chunk.language,
      role: item.chunk.role,
      score: Number(item.chunk.fusedScore.toFixed(6)),
      matchedBy: [...new Set(item.chunk.matchedBy)],
    });
  }

  return {
    text: blocks.join('\n\n'),
    sources,
    tokensUsed,
    chunksIncluded: blocks.length,
    chunksDropped: dropped,
    redactions,
  };
}

/** Merge chunks from the same file whose line ranges touch or overlap. */
function mergeOverlaps(chunks: readonly RetrievedChunk[]): MergedChunk[] {
  const byFile = new Map<string, RetrievedChunk[]>();
  for (const chunk of chunks) {
    const list = byFile.get(chunk.filePath) ?? [];
    list.push(chunk);
    byFile.set(chunk.filePath, list);
  }

  const merged: MergedChunk[] = [];
  for (const list of byFile.values()) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    let current: MergedChunk | null = null;

    for (const chunk of sorted) {
      if (
        current &&
        chunk.startLine <= current.endLine + 1 &&
        chunk.startLine >= current.startLine
      ) {
        if (chunk.endLine > current.endLine) {
          const overlap = current.endLine - chunk.startLine + 1;
          const extraLines = chunk.content.split('\n').slice(Math.max(0, overlap));
          current.content = `${current.content}\n${extraLines.join('\n')}`;
          current.endLine = chunk.endLine;
        }
        if (chunk.fusedScore > current.chunk.fusedScore) current.chunk = chunk;
        continue;
      }
      if (current) merged.push(current);
      current = { chunk, startLine: chunk.startLine, endLine: chunk.endLine, content: chunk.content };
    }
    if (current) merged.push(current);
  }

  return merged.sort((a, b) => b.chunk.fusedScore - a.chunk.fusedScore);
}

function numberLines(content: string, startLine: number): string {
  return content
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(5, ' ')} | ${line}`)
    .join('\n');
}

/** Compact, factual repository summary derived entirely from the index. */
export function buildRepositoryOverview(
  stack: StackProfile,
  options: { includeRoutes?: boolean; maxDirectories?: number; maxRoutes?: number } = {},
): string {
  const lines: string[] = [];
  const maxDirs = options.maxDirectories ?? 25;
  const maxRoutes = options.maxRoutes ?? 40;

  lines.push(`Project type: ${stack.projectTypes.join(', ')}`);
  lines.push(
    `Languages: ${stack.languages
      .slice(0, 8)
      .map((l) => `${l.language} ${l.percent}% (${l.files} files, ${l.lines} lines)`)
      .join(', ')}`,
  );
  if (stack.frameworks.length) {
    lines.push(
      `Frameworks: ${stack.frameworks.map((f) => `${f.name} [${f.evidence[0]?.file ?? 'evidence'}]`).join(', ')}`,
    );
  }
  if (stack.packageManagers.length) lines.push(`Package managers: ${stack.packageManagers.map((p) => p.name).join(', ')}`);
  if (stack.databases.length) {
    lines.push(`Data layer: ${stack.databases.map((d) => `${d.name} [${d.evidence[0]?.file ?? ''}]`).join(', ')}`);
  }
  if (stack.authMechanisms.length) {
    lines.push(
      `Auth mechanisms: ${stack.authMechanisms.map((a) => `${a.name} [${a.evidence[0]?.file ?? ''}${a.evidence[0]?.line ? `:${a.evidence[0].line}` : ''}]`).join(', ')}`,
    );
  }
  if (stack.externalServices.length) {
    lines.push(`External services: ${stack.externalServices.map((s) => s.name).join(', ')}`);
  }
  if (stack.testFrameworks.length) lines.push(`Test frameworks: ${stack.testFrameworks.map((t) => t.name).join(', ')}`);

  if (stack.entryPoints.length) {
    lines.push('Entry points:');
    for (const entry of stack.entryPoints.slice(0, 8)) {
      lines.push(`  - ${entry.file}${entry.line ? `:${entry.line}` : ''} (${entry.detail ?? ''})`);
    }
  }

  // Build facts. Without these an "installation" or "deployment" answer has no
  // choice but to invent commands.
  if (stack.manifestFiles.length) lines.push(`Dependency manifests: ${stack.manifestFiles.slice(0, 12).join(', ')}`);
  if (stack.runtimes.length) {
    lines.push(`Pinned runtimes: ${stack.runtimes.map((r) => `${r.name} ${r.version} [${r.file}]`).join(', ')}`);
  }
  if (stack.scripts.length) {
    lines.push(`Declared commands (${stack.scripts.length} total, showing up to 30):`);
    for (const script of stack.scripts.slice(0, 30)) {
      lines.push(`  - ${script.runner} ${script.name}${script.command ? ` -> ${script.command.slice(0, 140)}` : ''} [${script.file}]`);
    }
  }
  if (stack.dockerFiles.length) lines.push(`Docker files: ${stack.dockerFiles.join(', ')}`);
  if (stack.ciFiles.length) lines.push(`CI pipelines: ${stack.ciFiles.join(', ')}`);

  lines.push('Directory map (path | files | dominant role):');
  for (const dir of stack.directories.slice(0, maxDirs)) {
    lines.push(`  - ${dir.path} | ${dir.fileCount} files | ${dir.dominantRole}`);
  }

  if (options.includeRoutes !== false && stack.routes.length) {
    lines.push(`HTTP endpoints detected (${stack.routes.length} total, showing ${Math.min(maxRoutes, stack.routes.length)}):`);
    for (const route of stack.routes.slice(0, maxRoutes)) {
      lines.push(
        `  - ${route.method} ${route.path} -> ${route.file}:${route.line}${route.handler ? ` (${route.handler})` : ''}${
          route.protectedHint ? ' [auth guard nearby]' : ' [no auth guard detected nearby]'
        }`,
      );
    }
  }

  if (stack.envVars.length) {
    lines.push(`Environment variables referenced: ${stack.envVars.slice(0, 40).map((e) => e.name).join(', ')}`);
  }

  return lines.join('\n');
}
