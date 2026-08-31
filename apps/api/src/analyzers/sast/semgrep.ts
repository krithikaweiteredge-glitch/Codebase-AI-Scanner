/**
 * Semgrep integration: binary discovery, execution, and result mapping.
 *
 * What this buys over the regex rules in `static/rules.ts` is interprocedural
 * taint tracking. A regex sees one line, so it catches `db.query(\`... ${x}\`)`
 * and misses the same injection when the tainted value crosses a function
 * boundary on its way to the sink. Semgrep follows the value, and reports the
 * path it took - which is preserved here as the finding's evidence.
 *
 * Semgrep is a Python program, so it cannot be assumed present: the Render
 * deployment runs the plain `node` runtime with no way to install it. Every
 * entry point here is therefore written to degrade to "not available" rather
 * than to fail.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confidenceLabel, findingStatus } from '../../prompts/shared';
import type { AnalysisFindingDraft, FindingCategory, Severity } from '../types';

const run = promisify(execFile);

/** Semgrep can emit a lot of JSON on a large repository. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

export interface SemgrepOptions {
  /** Binary name or absolute path. */
  binary: string;
  /**
   * One or more rulesets, comma separated: registry packs (`p/default`),
   * local files, or directories. Each becomes its own `--config` flag, which
   * is how semgrep unions rulesets.
   */
  config: string;
  timeoutMs: number;
  /** Per-rule, per-file budget in seconds, passed through to semgrep. */
  ruleTimeoutSeconds: number;
  /** Parallelism. Keep at 1 on memory-constrained hosts. */
  jobs: number;
}

// ---------------------------------------------------------------------------
// Semgrep JSON output. Only the fields consumed here are modelled.
// ---------------------------------------------------------------------------

interface SemgrepPosition {
  line?: number;
  col?: number;
}

interface SemgrepLocation {
  path?: string;
  start?: SemgrepPosition;
  end?: SemgrepPosition;
}

interface SemgrepTaintStep {
  location?: SemgrepLocation;
  content?: string;
}

interface SemgrepDataflowTrace {
  /** Tuple-encoded by semgrep: ["CliLoc", [location, matched_text]]. */
  taint_source?: unknown;
  taint_sink?: unknown;
  intermediate_vars?: SemgrepTaintStep[];
}

export interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: SemgrepPosition;
  end?: SemgrepPosition;
  extra?: {
    message?: string;
    severity?: string;
    lines?: string;
    fix?: string;
    fingerprint?: string;
    is_ignored?: boolean;
    /** "OSS" or "PRO" - the Pro engine emits dataflow traces, OSS does not. */
    engine_kind?: string;
    dataflow_trace?: SemgrepDataflowTrace;
    metadata?: {
      cwe?: string[] | string;
      owasp?: string[] | string;
      category?: string;
      confidence?: string;
      impact?: string;
      likelihood?: string;
      references?: string[];
      technology?: string[];
      /** Set by the registry on rules whose matches are dataflow-derived. */
      subcategory?: string[] | string;
    };
  };
}

export interface SemgrepOutput {
  version?: string;
  results?: SemgrepResult[];
  errors?: { message?: string; level?: string }[];
  paths?: { scanned?: string[] };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export class SemgrepUnavailable extends Error {}

/**
 * How a failed execFile rejects: `code` is the process exit status, or a
 * string like `ENOENT` when the binary could not be spawned at all.
 */
interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Returns the installed version, or null when semgrep cannot be run at all.
 * Never throws - "not installed" is an expected deployment state, not a fault.
 */
export async function semgrepVersion(options: Pick<SemgrepOptions, 'binary'>): Promise<string | null> {
  try {
    const { stdout } = await run(options.binary, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = stdout.trim().split('\n')[0]?.trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Scans `directory` and returns parsed output.
 *
 * Arguments are passed as an array through execFile, never through a shell, so
 * the directory path cannot be interpreted as anything but a path.
 */
export async function runSemgrep(directory: string, options: SemgrepOptions): Promise<SemgrepOutput> {
  const args = [
    'scan',
    '--json',
    '--quiet',
    ...configArgs(options.config),
    // Telemetry is opt-out; the scanned code is the user's, so keep it local.
    '--metrics=off',
    '--disable-version-check',
    // Asks for the source-to-sink path on taint findings. The OSS engine
    // accepts the flag but only the Pro engine populates the trace, so this
    // enriches Pro scans and costs nothing on OSS.
    '--dataflow-traces',
    '--timeout',
    String(options.ruleTimeoutSeconds),
    '--jobs',
    String(options.jobs),
    directory,
  ];

  let stdout: string;
  try {
    const result = await run(options.binary, args, {
      timeout: options.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      // Semgrep writes rule-loading chatter to stderr even under --quiet.
      env: { ...process.env, SEMGREP_SEND_METRICS: 'off' },
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as ExecFailure;

    // Exit code 1 means "findings were reported", which is a successful scan.
    if (failure.code === 1 && failure.stdout) {
      stdout = failure.stdout;
    } else if (failure.code === 'ENOENT') {
      throw new SemgrepUnavailable(`semgrep binary not found: ${options.binary}`);
    } else if (failure.killed) {
      throw new SemgrepUnavailable(`semgrep timed out after ${options.timeoutMs}ms`);
    } else {
      throw new SemgrepUnavailable(`semgrep failed: ${failure.message?.slice(0, 300) ?? 'unknown error'}`);
    }
  }

  return parseSemgrepOutput(stdout);
}

/** `p/default,p/dockerfile` -> ['--config', 'p/default', '--config', 'p/dockerfile']. */
export function configArgs(config: string): string[] {
  const rulesets = splitConfig(config);
  return rulesets.flatMap((ruleset) => ['--config', ruleset]);
}

export function splitConfig(config: string): string[] {
  const rulesets = config
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Never invoke semgrep with no ruleset - it would scan with nothing loaded.
  return rulesets.length ? rulesets : ['p/default'];
}

export function parseSemgrepOutput(stdout: string): SemgrepOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { results: [] };
  try {
    return JSON.parse(trimmed) as SemgrepOutput;
  } catch {
    throw new SemgrepUnavailable('semgrep produced output that was not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Mapping into findings
// ---------------------------------------------------------------------------

/**
 * Converts semgrep results into finding drafts.
 *
 * `relativise` turns the scratch-directory path semgrep reports back into the
 * repository-relative path the rest of the platform uses, and drops any result
 * that cannot be mapped back to a known file.
 */
export function resultsToFindings(
  output: SemgrepOutput,
  relativise: (absolutePath: string) => string | null,
  config?: string,
): AnalysisFindingDraft[] {
  const drafts: AnalysisFindingDraft[] = [];

  for (const result of output.results ?? []) {
    if (result.extra?.is_ignored) continue;

    const rawPath = result.path;
    const filePath = rawPath ? relativise(rawPath) : null;
    if (!filePath) continue;

    const startLine = result.start?.line ?? 1;
    const category = categoryOf(result);
    const severity = severityOf(result);
    const confidence = confidenceOf(result);
    const trace = describeDataflow(result);
    const rule = normalizeCheckId(result.check_id, config);

    drafts.push({
      category,
      ruleId: `semgrep.${rule}`,
      type: typeOf(result),
      severity,
      title: titleOf(result),
      description: descriptionOf(result, trace),
      evidence: evidenceOf(result, filePath, startLine, trace, rule),
      ...(result.extra?.fix ? { recommendation: `Suggested fix from the rule:\n\n${result.extra.fix.slice(0, 1000)}` } : {}),
      filePath,
      startLine,
      endLine: result.end?.line ?? startLine,
      ...(gated(result.extra?.lines) ? {} : { snippet: result.extra!.lines!.slice(0, 2000) }),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      status: findingStatus('sast', confidence),
      source: 'sast',
      ...(cweOf(result) ? { cwe: cweOf(result) } : {}),
      metadata: {
        detector: 'semgrep',
        checkId: result.check_id ?? null,
        semgrepSeverity: result.extra?.severity ?? null,
        confidenceRating: result.extra?.metadata?.confidence ?? null,
        impact: result.extra?.metadata?.impact ?? null,
        likelihood: result.extra?.metadata?.likelihood ?? null,
        owasp: toArray(result.extra?.metadata?.owasp),
        cwes: toArray(result.extra?.metadata?.cwe),
        references: result.extra?.metadata?.references ?? [],
        technology: result.extra?.metadata?.technology ?? [],
        engine: result.extra?.engine_kind ?? null,
        fingerprint: gated(result.extra?.fingerprint) ? null : (result.extra?.fingerprint ?? null),
        ...(trace ? { dataflow: trace } : {}),
      },
    });
  }

  return drafts;
}

/** Semgrep rule categories map onto the platform's finding categories. */
function categoryOf(result: SemgrepResult): FindingCategory {
  const category = result.extra?.metadata?.category?.toLowerCase();
  if (category === 'security') return 'security';
  if (category === 'performance') return 'performance';
  if (category === 'correctness') return 'bug';
  if (category === 'best-practice' || category === 'maintainability') return 'quality';

  // Registry ids are namespaced, so the id itself is a reliable fallback.
  const id = result.check_id?.toLowerCase() ?? '';
  if (id.includes('security')) return 'security';
  if (id.includes('performance')) return 'performance';
  return 'bug';
}

/**
 * Semgrep reports rule severity (ERROR/WARNING/INFO) separately from the
 * estimated impact of a match. A high-impact ERROR is what a critical actually
 * means here; an ERROR on its own is high.
 */
function severityOf(result: SemgrepResult): Severity {
  const level = result.extra?.severity?.toUpperCase();
  const impact = result.extra?.metadata?.impact?.toUpperCase();

  if (level === 'ERROR') return impact === 'HIGH' ? 'critical' : 'high';
  if (level === 'WARNING') return impact === 'HIGH' ? 'high' : 'medium';
  if (level === 'INFO') return 'low';
  return 'medium';
}

/**
 * Rule authors rate their own precision, and it is the best signal available.
 * A dataflow-derived match is worth more than a syntactic one: the engine has
 * shown the value actually reaches the sink rather than merely matching a shape.
 */
function confidenceOf(result: SemgrepResult): number {
  const rating = result.extra?.metadata?.confidence?.toUpperCase();
  const base = rating === 'HIGH' ? 0.9 : rating === 'LOW' ? 0.55 : 0.75;
  const hasTaintPath = Boolean(result.extra?.dataflow_trace?.taint_source);
  return Math.min(0.95, hasTaintPath ? base + 0.05 : base);
}

function typeOf(result: SemgrepResult): string {
  // `javascript.express.security.audit.express-open-redirect` -> `express-open-redirect`.
  const id = result.check_id ?? 'semgrep-finding';
  return (id.split('.').pop() || id).slice(0, 80);
}

/**
 * Registry rules have tidy namespaced ids like
 * `javascript.express.security.audit.express-sqli`. A rule loaded from a local
 * file instead gets named after that file's directory, so `--config
 * /srv/rules/sqli.yaml` yields `srv.rules.sqli-rule`.
 *
 * Reconstructing the prefix from the config path removes exactly the noise and
 * nothing else - guessing by segment count either leaves junk behind on deep
 * paths or eats meaningful namespace on shallow ones.
 */
export function normalizeCheckId(checkId: string | undefined, config?: string): string {
  if (!checkId) return 'unknown';
  if (!config) return checkId;

  // Any of the configured rulesets could be the local file this id came from.
  for (const ruleset of splitConfig(config)) {
    const prefix = configPrefix(ruleset);
    if (prefix && checkId.startsWith(`${prefix}.`)) {
      return checkId.slice(prefix.length + 1) || checkId;
    }
  }
  return checkId;
}

/** Turns a config path into the dotted prefix semgrep derives from it. */
function configPrefix(config: string): string {
  // Registry shorthands (`p/default`) never become an id prefix.
  if (!config.includes('/') && !config.includes('\\')) return '';
  if (/^[pr]\//.test(config)) return '';

  const directory = config.replace(/[\\/][^\\/]*$/, '');
  return directory
    .replace(/[\\/:]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}

/**
 * Recent semgrep versions replace the matched source line and the fingerprint
 * with the literal string "requires login" unless the CLI is authenticated.
 * Storing that placeholder as a code snippet would be worse than storing
 * nothing.
 */
function gated(value: string | undefined): boolean {
  return !value || value.trim().toLowerCase() === 'requires login';
}

function titleOf(result: SemgrepResult): string {
  const message = result.extra?.message?.trim().split('\n')[0]?.trim();
  if (message) return message.slice(0, 200);
  return `Semgrep rule ${typeOf(result)} matched`;
}

function descriptionOf(result: SemgrepResult, trace: DataflowSummary | null): string {
  const parts: string[] = [];
  if (result.extra?.message) parts.push(result.extra.message.trim());

  if (trace) {
    parts.push(
      '',
      'Semgrep tracked this value from its source to the sink, so the match is a real ' +
        'data path rather than a shape that merely looks similar:',
      '',
      ...trace.steps.map((step, index) => `${index + 1}. \`${step.content}\` (${step.location})`),
    );
  }

  const cwes = toArray(result.extra?.metadata?.cwe);
  const owasp = toArray(result.extra?.metadata?.owasp);
  if (cwes.length || owasp.length) {
    parts.push('', [...cwes, ...owasp].join(' · '));
  }

  const references = result.extra?.metadata?.references ?? [];
  if (references.length) {
    parts.push('', ...references.slice(0, 3).map((url) => `- ${url}`));
  }

  return parts.join('\n').slice(0, 4000) || 'Semgrep reported a match with no message.';
}

function evidenceOf(
  result: SemgrepResult,
  filePath: string,
  startLine: number,
  trace: DataflowSummary | null,
  rule: string,
): string {
  if (trace) {
    return `Tainted value flows ${trace.steps[0]?.location ?? 'source'} -> ${
      trace.steps[trace.steps.length - 1]?.location ?? 'sink'
    } (rule ${rule}).`;
  }

  const line = gated(result.extra?.lines) ? null : result.extra!.lines!.trim().slice(0, 300);
  return `${filePath}:${startLine} matched rule ${rule}${line ? `: ${line}` : '.'}`;
}

/** CWE metadata arrives as `"CWE-89: Improper Neutralization of ..."`. */
function cweOf(result: SemgrepResult): string | undefined {
  for (const entry of toArray(result.extra?.metadata?.cwe)) {
    const match = /CWE-\d+/.exec(entry);
    if (match) return match[0];
  }
  return undefined;
}

export interface DataflowSummary {
  steps: { content: string; location: string }[];
}

/**
 * Flattens semgrep's taint trace into an ordered source -> ... -> sink list.
 * The source and sink are tuple-encoded (`["CliLoc", [location, text]]`), so
 * every field is read defensively.
 *
 * Only the Pro engine emits these traces. Under the OSS engine taint findings
 * are still reported - the value is still tracked across functions - but the
 * path it took is not included, and this returns null.
 */
export function describeDataflow(result: SemgrepResult): DataflowSummary | null {
  const trace = result.extra?.dataflow_trace;
  if (!trace?.taint_source) return null;

  const steps: { content: string; location: string }[] = [];

  const source = decodeTaintEndpoint(trace.taint_source);
  if (source) steps.push(source);

  for (const intermediate of trace.intermediate_vars ?? []) {
    const content = intermediate.content?.trim();
    if (!content) continue;
    steps.push({ content: content.slice(0, 200), location: formatLocation(intermediate.location) });
  }

  const sink = decodeTaintEndpoint(trace.taint_sink);
  if (sink) steps.push(sink);

  return steps.length ? { steps } : null;
}

function decodeTaintEndpoint(value: unknown): { content: string; location: string } | null {
  if (!Array.isArray(value)) return null;
  // ["CliLoc", [location, "matched text"]]
  const payload = value[1];
  if (!Array.isArray(payload)) return null;

  const location = payload[0] as SemgrepLocation | undefined;
  const content = typeof payload[1] === 'string' ? payload[1].trim() : '';
  if (!content) return null;

  return { content: content.slice(0, 200), location: formatLocation(location) };
}

function formatLocation(location: SemgrepLocation | undefined): string {
  if (!location?.path) return 'unknown location';
  const line = location.start?.line;
  return line ? `${location.path}:${line}` : location.path;
}

function toArray(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
