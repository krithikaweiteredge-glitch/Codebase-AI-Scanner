import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import type { StackProfile } from '../indexer/projectMap';
import {
  ARCHITECTURE_SYSTEM_PROMPT,
  architectureSchema,
  buildArchitecturePrompt,
  type ArchitectureReport,
} from '../prompts/architecture';
import { buildCodeContext, buildRepositoryOverview } from '../search/context';
import type { RetrievedChunk } from '../search/hybrid';

export interface CouplingEntry {
  path: string;
  fanIn: number;
  fanOut: number;
  externalDeps: number;
}

export interface DependencyGraph {
  nodes: { id: string; path: string; role: string | null; language: string | null; loc: number; fanIn: number; fanOut: number }[];
  edges: { from: string; to: string; specifier: string }[];
  externals: { specifier: string; importers: number }[];
  cycles: string[][];
  hotspots: CouplingEntry[];
}

/** Deterministic dependency graph, used by the UI and as AI input. */
export async function buildDependencyGraphView(repositoryId: string, branchId: string): Promise<DependencyGraph> {
  const files = await prisma.repositoryFile.findMany({
    where: { branchId },
    select: { id: true, path: true, role: true, language: true, lineCount: true },
  });
  const deps = await prisma.dependency.findMany({
    where: { repositoryId, fromFile: { branchId } },
    select: { fromFileId: true, toFileId: true, specifier: true, isExternal: true },
  });

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const externalCounts = new Map<string, number>();
  const edges: DependencyGraph['edges'] = [];

  for (const dep of deps) {
    if (dep.isExternal || !dep.toFileId) {
      const root = dep.specifier.startsWith('@')
        ? dep.specifier.split('/').slice(0, 2).join('/')
        : (dep.specifier.split('/')[0] ?? dep.specifier);
      externalCounts.set(root, (externalCounts.get(root) ?? 0) + 1);
      fanOut.set(dep.fromFileId, (fanOut.get(dep.fromFileId) ?? 0) + 1);
      continue;
    }
    edges.push({ from: dep.fromFileId, to: dep.toFileId, specifier: dep.specifier });
    fanOut.set(dep.fromFileId, (fanOut.get(dep.fromFileId) ?? 0) + 1);
    fanIn.set(dep.toFileId, (fanIn.get(dep.toFileId) ?? 0) + 1);
  }

  const nodes = files.map((file) => ({
    id: file.id,
    path: file.path,
    role: file.role,
    language: file.language,
    loc: file.lineCount,
    fanIn: fanIn.get(file.id) ?? 0,
    fanOut: fanOut.get(file.id) ?? 0,
  }));

  const pathById = new Map(files.map((f) => [f.id, f.path]));
  const hotspots: CouplingEntry[] = nodes
    .map((node) => ({
      path: node.path,
      fanIn: node.fanIn,
      fanOut: node.fanOut,
      externalDeps: 0,
    }))
    .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))
    .slice(0, 25);

  return {
    nodes,
    edges,
    externals: [...externalCounts.entries()]
      .map(([specifier, importers]) => ({ specifier, importers }))
      .sort((a, b) => b.importers - a.importers)
      .slice(0, 60),
    cycles: findCycles(edges, pathById),
    hotspots,
  };
}

/** Iterative DFS cycle detection over the file import graph. */
function findCycles(edges: { from: string; to: string }[], pathById: Map<string, string>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const cycles: string[][] = [];

  const visit = (start: string): void => {
    const stack: { node: string; iterator: number }[] = [{ node: start, iterator: 0 }];
    const path: string[] = [start];
    colour.set(start, GREY);

    while (stack.length) {
      const frame = stack[stack.length - 1] as { node: string; iterator: number };
      const neighbours = adjacency.get(frame.node) ?? [];

      if (frame.iterator >= neighbours.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = neighbours[frame.iterator++] as string;
      const state = colour.get(next) ?? WHITE;

      if (state === GREY) {
        const index = path.indexOf(next);
        if (index >= 0 && cycles.length < 20) {
          cycles.push([...path.slice(index), next].map((id) => pathById.get(id) ?? id));
        }
      } else if (state === WHITE) {
        colour.set(next, GREY);
        stack.push({ node: next, iterator: 0 });
        path.push(next);
      }
    }
  };

  for (const node of adjacency.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }

  return cycles;
}

/** Mermaid diagram derived purely from directory roles and real import edges. */
export function deterministicMermaid(stack: StackProfile, graph: DependencyGraph): string {
  const byDirectory = new Map<string, { role: string; files: number }>();
  for (const node of graph.nodes) {
    const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '/';
    const entry = byDirectory.get(dir) ?? { role: node.role ?? 'unknown', files: 0 };
    entry.files++;
    byDirectory.set(dir, entry);
  }

  const significant = [...byDirectory.entries()]
    .filter(([, value]) => value.files >= 2)
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 18);

  const idFor = new Map<string, string>();
  significant.forEach(([dir], index) => idFor.set(dir, `D${index}`));

  const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');
  const edgeCounts = new Map<string, number>();
  const pathById = new Map(graph.nodes.map((n) => [n.id, n.path]));

  for (const edge of graph.edges) {
    const from = dirOf(pathById.get(edge.from) ?? '');
    const to = dirOf(pathById.get(edge.to) ?? '');
    if (from === to) continue;
    if (!idFor.has(from) || !idFor.has(to)) continue;
    const key = `${idFor.get(from)}->${idFor.get(to)}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }

  const lines = ['flowchart TD'];
  for (const [dir, value] of significant) {
    lines.push(`  ${idFor.get(dir)}["${escapeMermaid(dir)}<br/>${value.files} files · ${value.role}"]`);
  }
  for (const [key, count] of [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const [from, to] = key.split('->');
    lines.push(`  ${from} -->|${count}| ${to}`);
  }
  for (const service of stack.externalServices.slice(0, 6)) {
    const id = `EXT${service.name.replace(/\W/g, '')}`;
    lines.push(`  ${id}(["${escapeMermaid(service.name)}"])`);
  }
  for (const db of stack.databases.slice(0, 4)) {
    const id = `DB${db.name.replace(/\W/g, '')}`;
    lines.push(`  ${id}[("${escapeMermaid(db.name)}")]`);
  }

  return lines.join('\n');
}

function escapeMermaid(text: string): string {
  return text.replace(/["`]/g, "'").slice(0, 60);
}

export interface ArchitectureInsight extends Partial<ArchitectureReport> {
  mermaid: string;
  generatedBy: 'ai' | 'deterministic';
  graphSummary: {
    files: number;
    edges: number;
    externalPackages: number;
    cycles: number;
    hotspots: CouplingEntry[];
  };
}

export async function generateArchitecture(params: {
  repositoryId: string;
  branchId: string;
  repositoryName: string;
  stack: StackProfile;
}): Promise<ArchitectureInsight> {
  const graph = await buildDependencyGraphView(params.repositoryId, params.branchId);
  const fallbackMermaid = deterministicMermaid(params.stack, graph);

  const graphSummary = {
    files: graph.nodes.length,
    edges: graph.edges.length,
    externalPackages: graph.externals.length,
    cycles: graph.cycles.length,
    hotspots: graph.hotspots.slice(0, 12),
  };

  const base: ArchitectureInsight = {
    mermaid: fallbackMermaid,
    generatedBy: 'deterministic',
    graphSummary,
  };

  if (!aiEnabled()) {
    await saveArchitecture(params.repositoryId, base);
    return base;
  }

  const couplingReport = [
    `Files: ${graph.nodes.length}, internal import edges: ${graph.edges.length}, external packages: ${graph.externals.length}.`,
    `Most connected files: ${graph.hotspots
      .slice(0, 12)
      .map((h) => `${h.path} (in ${h.fanIn}/out ${h.fanOut})`)
      .join(', ')}`,
    graph.cycles.length
      ? `Import cycles detected: ${graph.cycles.slice(0, 5).map((c) => c.join(' -> ')).join(' ; ')}`
      : 'No import cycles detected.',
    `Top external packages: ${graph.externals.slice(0, 15).map((e) => `${e.specifier} (${e.importers})`).join(', ')}`,
  ].join('\n');

  // Representative code: entry points and the most connected modules.
  const representativePaths = [
    ...params.stack.entryPoints.map((e) => e.file),
    ...graph.hotspots.slice(0, 10).map((h) => h.path),
  ].slice(0, 14);

  const files = await prisma.repositoryFile.findMany({
    where: { branchId: params.branchId, path: { in: representativePaths } },
    select: { id: true, path: true, content: true, language: true, role: true, lineCount: true },
  });

  const chunks: RetrievedChunk[] = files.map((file) => {
    const lines = (file.content ?? '').split('\n').slice(0, 160);
    return {
      id: `file:${file.id}`,
      fileId: file.id,
      filePath: file.path,
      language: file.language,
      role: file.role,
      symbolName: null,
      symbolType: 'file',
      startLine: 1,
      endLine: lines.length,
      content: lines.join('\n'),
      score: 1,
      fusedScore: 1,
      matchedBy: ['architecture-selection'],
      ranks: {},
    };
  });

  const context = buildCodeContext(chunks, Math.floor(env.CONTEXT_TOKEN_BUDGET * 0.8));

  try {
    const { data } = await generateStructured({
      system: ARCHITECTURE_SYSTEM_PROMPT,
      user: buildArchitecturePrompt({
        repositoryName: params.repositoryName,
        overview: buildRepositoryOverview(params.stack, { maxRoutes: 30 }),
        couplingReport,
        codeContext: context.text,
      }),
      schema: architectureSchema,
      task: 'architecture-analysis',
      maxTokens: env.AI_MAX_OUTPUT_TOKENS,
    });

    const insight: ArchitectureInsight = {
      ...data,
      mermaid: sanitiseMermaid(data.mermaid) || fallbackMermaid,
      generatedBy: 'ai',
      graphSummary,
    };
    await saveArchitecture(params.repositoryId, insight);
    return insight;
  } catch (error) {
    if (!(error instanceof AIGenerationUnavailable)) {
      base.summary = `Architecture narrative unavailable: ${(error as Error).message}. The diagram below is derived directly from the dependency graph.`;
    }
    await saveArchitecture(params.repositoryId, base);
    return base;
  }
}

function sanitiseMermaid(diagram: string): string {
  const trimmed = diagram.trim().replace(/^```(?:mermaid)?\s*/i, '').replace(/```$/, '').trim();
  if (!/^(flowchart|graph|sequenceDiagram|classDiagram)/.test(trimmed)) return '';
  return trimmed;
}

async function saveArchitecture(repositoryId: string, insight: ArchitectureInsight): Promise<void> {
  await prisma.repositoryInsight.upsert({
    where: { repositoryId_kind: { repositoryId, kind: 'architecture' } },
    create: { repositoryId, kind: 'architecture', data: insight as unknown as Prisma.InputJsonValue },
    update: { data: insight as unknown as Prisma.InputJsonValue },
  });
}
