/**
 * Stage one of the two-stage AI review: sweep every file cheaply, so stage two
 * reads the right ones.
 *
 * The deep review is bounded by cost - it can afford a few dozen files, not a
 * few hundred. Previously those were chosen by static findings plus a
 * directory-role weighting, which has an obvious blind spot: a file that no
 * deterministic rule flagged and whose role carries no weight is never
 * examined, however dangerous its contents. That is precisely where an
 * unreported bug survives.
 *
 * So this pass sends a compact digest of *every* file to a cheap model and
 * asks only "is this worth reading properly?". Digests are a fraction of the
 * token cost of the files themselves, which is what makes full coverage
 * affordable.
 */

import { getTriageProvider } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { chunkArray } from '../lib/pool';
import { buildTriagePrompt, triageResponseSchema, TRIAGE_SYSTEM_PROMPT } from '../prompts/triage';
import type { AnalyzableFile } from './types';

export interface TriageVerdict {
  risk: number;
  categories: ('security' | 'bug' | 'performance')[];
  reason: string;
}

export interface TriageResult {
  /** Keyed by repository-relative path. */
  verdicts: Map<string, TriageVerdict>;
  filesTriaged: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TriageOptions {
  repositoryName: string;
  overview: string;
  /** Files per request. Digests are small, so this can be generous. */
  batchSize: number;
  /** Hard ceiling on files swept, to bound cost on very large repositories. */
  maxFiles: number;
  maxTokens: number;
}

/**
 * Lines worth showing the model. Deliberately broad - this is a sampler, not a
 * detector, and its job is to surface what a file *touches* so the model can
 * judge whether the file deserves a real read.
 */
const INTERESTING = new RegExp(
  [
    // input and transport
    'req\\.|request\\.|params|query|body|headers|cookie|searchParams|formData',
    // persistence and interpreters
    'query|execute|exec|eval|spawn|raw|prepare|findMany|aggregate|\\$queryRaw',
    // auth, crypto, secrets
    'auth|token|session|password|secret|credential|jwt|hash|cipher|crypto|sign|verify',
    // network and filesystem
    'fetch\\(|axios|http[s]?\\.|url|redirect|readFile|writeFile|createReadStream|path\\.join',
    // browser sinks
    // codebase-ai-ignore: sec.xss.dangerously-set-html - names the sink, never calls it
    'innerHTML|dangerouslySetInnerHTML|document\\.write|localStorage|postMessage',
    // python / go / java shapes
    'subprocess|pickle|os\\.system|cursor\\.|http\\.HandleFunc|Statement|Runtime\\.getRuntime',
  ].join('|'),
  'i',
);

/** Import lines say what a file uses; they are cheap context and rarely risky on their own. */
const IMPORT_LINE = /^\s*(import\s|from\s+\S+\s+import\s|const\s+\{?[\w\s,}]*\}?\s*=\s*require\(|package\s|using\s)/;

const MAX_DIGEST_LINES = 10;
const MAX_LINE_CHARS = 160;

/**
 * Condenses a file into a few hundred characters: what it is, and the lines
 * that touch something worth a second look.
 */
export function buildDigest(file: AnalyzableFile): string {
  const lines = file.content.split('\n');
  const picked: string[] = [];

  for (let i = 0; i < lines.length && picked.length < MAX_DIGEST_LINES; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 4) continue;
    if (IMPORT_LINE.test(line)) continue;
    if (!INTERESTING.test(trimmed)) continue;
    picked.push(`  ${i + 1}: ${trimmed.slice(0, MAX_LINE_CHARS)}`);
  }

  // Nothing matched: show the first few substantive lines so the model still
  // has something to judge, rather than scoring an empty digest.
  if (!picked.length) {
    for (let i = 0; i < lines.length && picked.length < 3; i++) {
      const line = lines[i];
      const trimmed = line?.trim();
      if (!trimmed || trimmed.length < 8 || IMPORT_LINE.test(line as string)) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
      picked.push(`  ${i + 1}: ${trimmed.slice(0, MAX_LINE_CHARS)}`);
    }
  }

  const header = `${file.path} [${file.language}, ${file.role}, ${file.lineCount} lines${file.isTest ? ', test' : ''}]`;
  return picked.length ? `${header}\n${picked.join('\n')}` : header;
}

/**
 * Runs the sweep. Never throws for a partial failure: a batch that fails leaves
 * those files unscored, and stage two falls back to its own heuristics for them.
 * A provider that cannot generate at all propagates, so the caller can skip the
 * whole AI stage.
 */
export async function triageFiles(
  files: readonly AnalyzableFile[],
  options: TriageOptions,
): Promise<TriageResult> {
  const provider = getTriageProvider();

  // Generated code is machine-written; reviewing it produces nothing anyone acts on.
  const candidates = files.filter((file) => !file.isGenerated).slice(0, options.maxFiles);

  const result: TriageResult = {
    verdicts: new Map(),
    filesTriaged: 0,
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  if (!candidates.length) return result;

  const known = new Set(candidates.map((file) => file.path));

  for (const batch of chunkArray(candidates, options.batchSize)) {
    const digests = batch.map(buildDigest).join('\n\n');

    try {
      const { data, usage } = await generateStructured({
        provider,
        system: TRIAGE_SYSTEM_PROMPT,
        user: buildTriagePrompt({
          repositoryName: options.repositoryName,
          overview: options.overview,
          digests,
          fileCount: batch.length,
        }),
        schema: triageResponseSchema,
        task: 'ai-triage',
        maxTokens: options.maxTokens,
        // One repair only: a failed triage batch is cheap to lose.
        repairAttempts: 1,
      });

      result.batches++;
      result.inputTokens += usage.inputTokens;
      result.outputTokens += usage.outputTokens;

      for (const entry of data.files ?? []) {
        // Models occasionally answer for a path that was not in the batch.
        if (!known.has(entry.path)) continue;
        result.verdicts.set(entry.path, {
          risk: entry.risk,
          categories: entry.categories ?? [],
          reason: entry.reason ?? '',
        });
      }
    } catch (error) {
      if (error instanceof AIGenerationUnavailable) throw error;
      // Rate limit, timeout, malformed output: leave this batch unscored.
    }
  }

  result.filesTriaged = result.verdicts.size;
  return result;
}
