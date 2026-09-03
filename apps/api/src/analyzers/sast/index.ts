/**
 * Static application security testing via Semgrep.
 *
 * The deterministic rules in `static/rules.ts` match one line at a time, which
 * is why they catch an injection written inline and miss the identical bug when
 * the tainted value is passed through two helpers first. Semgrep's taint mode
 * follows the value across functions and files, so this analyzer covers the
 * class of finding the rest of the engine structurally cannot reach.
 *
 * It is optional by construction. Semgrep is a Python program and the Render
 * deployment runs the bare `node` runtime, so the scan reports itself as
 * unavailable there and the run continues with everything else intact.
 */

import * as path from 'node:path';
import type { AnalysisFindingDraft, AnalyzableFile } from '../types';
import { materialize, type WorkspaceLimits } from './workspace';
import {
  resultsToFindings,
  runSemgrep,
  probeSemgrep,
  type SemgrepProbe,
  SemgrepUnavailable,
  type SemgrepOptions,
} from './semgrep';

export interface SastOptions extends SemgrepOptions, WorkspaceLimits {}

export interface SastResult {
  drafts: AnalysisFindingDraft[];
  version: string;
  filesScanned: number;
  filesSkipped: number;
  rulesErrored: number;
  /** How many findings came with a tracked source-to-sink path. */
  dataflowFindings: number;
}

/**
 * Resolved once per process. Probing the binary costs a subprocess spawn, and
 * whether semgrep is installed does not change while the server is running.
 */
let cachedProbe: SemgrepProbe | null = null;

export async function detectSemgrep(options: Pick<SemgrepOptions, 'binary'>): Promise<string | null> {
  return (await probeSemgrepCached(options)).version;
}

/** The full probe result, so callers can report why it failed. */
export async function probeSemgrepCached(options: Pick<SemgrepOptions, 'binary'>): Promise<SemgrepProbe> {
  if (!cachedProbe) cachedProbe = await probeSemgrep(options);
  return cachedProbe;
}

/**
 * Non-blocking view of the same probe, for callers that must not wait - the
 * health endpoint is the platform's health check, and spawning a process while
 * it is held open risks failing a deploy over a diagnostic. Returns whatever is
 * cached and starts the probe if it has not run, so the answer is there on the
 * next call.
 */
export function semgrepStatus(options: Pick<SemgrepOptions, 'binary'>): SemgrepProbe & { probed: boolean } {
  if (!cachedProbe) {
    void probeSemgrepCached(options);
    return { version: null, probed: false };
  }
  return { ...cachedProbe, probed: true };
}
/** Test seam: forget the probe result so a later call re-checks. */
export function resetSemgrepDetection(): void {
  cachedProbe = null;
}

/**
 * Runs a scan. Throws `SemgrepUnavailable` when semgrep cannot run at all,
 * which callers are expected to treat as a skipped step rather than a failure.
 */
export async function runSastScan(
  files: readonly AnalyzableFile[],
  options: SastOptions,
): Promise<SastResult> {
  const probe = await probeSemgrepCached(options);
  if (!probe.version) {
    // Say what actually happened. Reporting every failure as "not on PATH"
    // sent a reader looking for a missing file when the binary was present and
    // the instance had simply run out of memory to start it.
    throw new SemgrepUnavailable(
      `semgrep could not be run ("${options.binary}"): ${probe.error ?? 'unknown reason'}.`,
    );
  }
  const version = probe.version;

  // Generated code is machine-written and its findings are not actionable.
  const scannable = files.filter((file) => !file.isGenerated);
  if (!scannable.length) {
    return { drafts: [], version, filesScanned: 0, filesSkipped: 0, rulesErrored: 0, dataflowFindings: 0 };
  }

  const workspace = await materialize(scannable, {
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    maxFileBytes: options.maxFileBytes,
  });

  try {
    const output = await runSemgrep(workspace.root, options);

    const known = new Set(workspace.files);
    const drafts = resultsToFindings(
      output,
      (reported) => relativise(reported, workspace.root, known),
      options.config,
    );

    return {
      drafts,
      version,
      filesScanned: workspace.files.length,
      filesSkipped: workspace.skipped.length,
      rulesErrored: output.errors?.length ?? 0,
      dataflowFindings: drafts.filter((d) => Boolean((d.metadata as { dataflow?: unknown })?.dataflow)).length,
    };
  } finally {
    // The scratch directory holds a copy of the user's source; remove it even
    // when the scan throws.
    await workspace.cleanup();
  }
}

/**
 * Maps a path semgrep reported back to its repository-relative form.
 *
 * Semgrep may report the target either absolutely or relative to the directory
 * it was given, so both are normalised and then checked against the files that
 * were actually written - anything else is discarded rather than guessed at.
 */
export function relativise(reported: string, root: string, known: ReadonlySet<string>): string | null {
  const normalisedRoot = path.resolve(root);
  const candidate = path.isAbsolute(reported) ? path.resolve(reported) : path.resolve(normalisedRoot, reported);

  if (candidate !== normalisedRoot && !candidate.startsWith(normalisedRoot + path.sep)) return null;

  const relative = path.relative(normalisedRoot, candidate).split(path.sep).join('/');
  return known.has(relative) ? relative : null;
}

export { SemgrepUnavailable };
