import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import { routeGroup } from '../indexer/apiRoutes';
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

const dirOf = (filePath: string) => (filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '/');

/** Mermaid diagram derived purely from directory roles and real import edges. */
export function deterministicMermaid(stack: StackProfile, graph: DependencyGraph): string {
  const roleByDirectory = new Map(stack.directories.map((d) => [d.path, d.dominantRole]));
  const byDirectory = new Map<string, { roles: Map<string, number>; files: number }>();
  for (const node of graph.nodes) {
    const dir = dirOf(node.path);
    const entry = byDirectory.get(dir) ?? { roles: new Map<string, number>(), files: 0 };
    entry.files++;
    const role = node.role ?? 'unknown';
    entry.roles.set(role, (entry.roles.get(role) ?? 0) + 1);
    byDirectory.set(dir, entry);
  }

  const ranked = [...byDirectory.entries()].sort((a, b) => b[1].files - a[1].files);
  // A flat or small repository has no directory with two files; keeping the
  // >= 2 filter there produced a diagram with no nodes at all, which mermaid
  // rejects outright and the UI renders as a parse error.
  const multiFile = ranked.filter(([, value]) => value.files >= 2);
  const significant = (multiFile.length >= 2 ? multiFile : ranked).slice(0, 18);

  if (!significant.length) {
    return ['flowchart TD', '  EMPTY["No files were indexed for this branch"]'].join('\n');
  }

  const idFor = new Map<string, string>();
  significant.forEach(([dir], index) => idFor.set(dir, `D${index}`));

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
    const role = roleByDirectory.get(dir) ?? [...value.roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    lines.push(`  ${idFor.get(dir)}["${escapeMermaid(dir)}<br/>${value.files} files · ${escapeMermaid(role)}"]`);
  }
  for (const [key, count] of [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const [from, to] = key.split('->');
    lines.push(`  ${from} -->|${count}| ${to}`);
  }

  // Externals are only worth drawing when they attach to a module that is on
  // the diagram; a floating box tells the reader nothing.
  const usedIds = new Set<string>();
  const attach = (name: string, prefix: string, shape: (label: string) => string, evidence: { file: string }[]) => {
    const callers = new Set<string>();
    for (const item of evidence) {
      const id = idFor.get(dirOf(item.file));
      if (id) callers.add(id);
    }
    if (!callers.size) return;
    let id = `${prefix}${name.replace(/\W/g, '') || 'X'}`;
    while (usedIds.has(id)) id += '_';
    usedIds.add(id);
    lines.push(`  ${id}${shape(escapeMermaid(name))}`);
    for (const caller of [...callers].slice(0, 4)) lines.push(`  ${caller} --> ${id}`);
  };

  for (const service of stack.externalServices.slice(0, 6)) {
    attach(service.name, 'EXT', (label) => `(["${label}"])`, service.evidence);
  }
  for (const db of stack.databases.slice(0, 4)) {
    attach(db.name, 'DB', (label) => `[("${label}")]`, db.evidence);
  }

  return lines.join('\n');
}

/**
 * Layers, directory purposes and request flows derived from the index alone, so
 * the Layers & flows view is populated even with no AI provider configured.
 */
export function deterministicNarrative(
  stack: StackProfile,
  graph: DependencyGraph,
): Pick<ArchitectureReport, 'summary' | 'layers' | 'directoryPurposes' | 'flows'> {
  const byRole = new Map<string, typeof stack.directories>();
  for (const dir of stack.directories) {
    // Directories no convention matches are their own module rather than being
    // swept into one "unknown" layer, which described nothing.
    const key = dir.dominantRole === 'unknown' ? `module: ${dir.path.split('/').pop() || dir.path}` : dir.dominantRole;
    const list = byRole.get(key) ?? [];
    list.push(dir);
    byRole.set(key, list);
  }

  const layers = [...byRole.entries()]
    .sort((a, b) => b[1].reduce((n, d) => n + d.fileCount, 0) - a[1].reduce((n, d) => n + d.fileCount, 0))
    .slice(0, 12)
    .map(([role, dirs]) => ({
      name: role,
      purpose: role.startsWith('module: ')
        ? `${dirs.reduce((n, d) => n + d.fileCount, 0)} files in ${dirs.map((d) => d.path).join(', ')}; no layering convention matched, so this is grouped by module name.`
        : `${dirs.reduce((n, d) => n + d.fileCount, 0)} files across ${dirs.length} ${
            dirs.length === 1 ? 'directory' : 'directories'
          } classified as "${role}" by path convention and file contents.`,
      directories: dirs.slice(0, 12).map((d) => d.path),
      keyFiles: dirs.flatMap((d) => d.importantFiles).slice(0, 12),
    }));

  const directoryPurposes = stack.directories.slice(0, 40).map((dir) => ({
    path: dir.path,
    purpose: `${dir.fileCount} files (${dir.totalLines} lines), mostly ${dir.dominantRole}${
      dir.languages.length ? `, written in ${dir.languages.slice(0, 3).join(', ')}` : ''
    }.`,
    responsibilities: Object.entries(dir.roles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([role, count]) => `${count} ${role} file${count === 1 ? '' : 's'}`),
    importantFiles: dir.importantFiles.slice(0, 8),
  }));

  // One flow per route group: entry point -> handler file -> what it imports.
  const pathById = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const importsOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = pathById.get(edge.from);
    const to = pathById.get(edge.to);
    if (!from || !to) continue;
    const list = importsOf.get(from) ?? [];
    if (list.length < 3) list.push(to);
    importsOf.set(from, list);
  }

  const grouped = new Map<string, (typeof stack.routes)[number][]>();
  for (const route of stack.routes) {
    const key = routeGroup(route.path);
    const list = grouped.get(key) ?? [];
    list.push(route);
    grouped.set(key, list);
  }

  const entry = stack.entryPoints[0];
  const flows = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([group, routes]) => {
      const route = routes[0]!;
      const steps: ArchitectureReport['flows'][number]['steps'] = [];
      if (entry) steps.push({ label: `Process starts at ${entry.file}`, filePath: entry.file, startLine: entry.line ?? null });
      steps.push({ label: `${route.method} ${route.path} is declared`, filePath: route.file, startLine: route.line });
      if (route.handler) steps.push({ label: `Handled by ${route.handler}()`, filePath: route.file, startLine: route.line });
      for (const target of importsOf.get(route.file) ?? []) {
        steps.push({ label: `Delegates to ${target}`, filePath: target, startLine: null });
      }
      return { name: `/${group} (${routes.length} endpoint${routes.length === 1 ? '' : 's'})`, steps };
    })
    // The schema requires at least two steps; a route with nothing around it is
    // not a flow worth drawing.
    .filter((flow) => flow.steps.length >= 2);

  const summary = [
    `${stack.projectTypes.join(', ') || 'Unclassified project'} with ${graph.nodes.length} indexed files and ${graph.edges.length} internal imports.`,
    layers.length ? `Code is organised into ${layers.length} role groups, the largest being "${layers[0]!.name}".` : '',
    stack.routes.length ? `${stack.routes.length} HTTP endpoints were detected across ${grouped.size} route groups.` : 'No HTTP endpoints were detected.',
    graph.cycles.length ? `${graph.cycles.length} import cycles are present.` : 'No import cycles were found.',
    'This description is derived from the index; configure an AI provider for a written narrative.',
  ]
    .filter(Boolean)
    .join(' ');

  return { summary, layers, directoryPurposes, flows };
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
    ...deterministicNarrative(params.stack, graph),
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

    // The schema permits empty arrays, so a thin model response must not wipe
    // out the narrative the index can supply on its own.
    const insight: ArchitectureInsight = {
      ...data,
      layers: data.layers.length ? data.layers : base.layers,
      directoryPurposes: data.directoryPurposes.length ? data.directoryPurposes : base.directoryPurposes,
      flows: data.flows.length ? data.flows : base.flows,
      mermaid: sanitiseMermaid(data.mermaid) || fallbackMermaid,
      generatedBy: 'ai',
      graphSummary,
    };
    await saveArchitecture(params.repositoryId, insight);
    return insight;
  } catch (error) {
    if (!(error instanceof AIGenerationUnavailable)) {
      base.summary = `${base.summary ?? ''}\n\nAI narrative unavailable: ${(error as Error).message}. Everything shown here is derived directly from the dependency graph.`.trim();
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
