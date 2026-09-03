/**
 * Letting a repository say "I know about this one".
 *
 * Without it the only ways to quiet a finding were to stop indexing the file
 * entirely - which also costs search, chat and the architecture view - or to
 * mark each finding a false positive by hand, again, after every run.
 *
 * This project demonstrates the need on itself: scanning its own source
 * produces around a dozen security findings, and almost all of them are the
 * scanner reading its own benchmark corpus, which is deliberately vulnerable
 * code kept deliberately vulnerable. A tool that cannot be told that cries
 * wolf on exactly the repositories that care most about security.
 *
 * Two forms, because they answer different questions. An inline comment says
 * "this line, on purpose", next to the code and reviewed with it. A policy
 * entry says "this whole directory is fixtures", which no amount of per-line
 * annotation expresses well.
 */

import ignore from 'ignore';
import type { AnalysisFindingDraft, AnalyzableFile } from './types';

/**
 * The marker. Deliberately not `nosemgrep` or `eslint-disable`: those belong to
 * other tools, and honouring them would suppress findings their owners never
 * meant to silence here.
 */
const MARKER = 'codebase-ai-ignore';

/** `codebase-ai-ignore`, optionally followed by the rules it applies to. */
// The rule list may contain `*` for a prefix match, so it cannot simply be
// excluded - but it must still stop at the `*/` that closes a block comment.
const INLINE = new RegExp(`${MARKER}(?:-next-line)?\\s*(?::\\s*((?:[^*\\n]|\\*(?!/))+))?`, 'i');

export interface SuppressionRule {
  /** gitignore-syntax globs. Omitted means every file. */
  files?: string[];
  /** Rule ids this applies to. Omitted means every rule. */
  rules?: string[];
  /** Why, for the audit trail. */
  reason?: string;
}

export interface SuppressionSummary {
  /** How many findings were withheld. */
  suppressed: number;
  /** Rule ids withheld, with counts, for reporting. */
  byRule: Record<string, number>;
}

/** Rule ids listed after the marker, or null when it applies to everything. */
function rulesFromComment(text: string): string[] | null {
  const match = INLINE.exec(text);
  if (!match) return null;
  const list = (match[1] ?? '').trim();
  if (!list) return null;
  const ids = list
    .split(/[,\s]+/)
    .map((id) => id.replace(/[^\w.*-]/g, ''))
    .filter(Boolean);
  return ids.length ? ids : null;
}

function ruleMatches(ruleId: string | undefined, wanted: readonly string[] | null | undefined): boolean {
  if (!wanted || !wanted.length) return true;
  if (!ruleId) return false;
  return wanted.some((pattern) =>
    pattern.endsWith('*') ? ruleId.startsWith(pattern.slice(0, -1)) : ruleId === pattern,
  );
}

/**
 * True when the file marks this finding's line as intentional.
 *
 * The marker is honoured on the finding's own line and on the line above it,
 * which is the convention every comparable tool uses - putting it above is the
 * only option when the offending line is already long.
 */
function suppressedInline(file: AnalyzableFile | undefined, draft: AnalysisFindingDraft): boolean {
  if (!file || !draft.startLine) return false;
  const lines = file.content.split('\n');
  for (const lineNumber of [draft.startLine, draft.startLine - 1]) {
    const text = lines[lineNumber - 1];
    if (!text || !text.toLowerCase().includes(MARKER)) continue;
    // A bare marker suppresses everything on the line; a list narrows it.
    if (ruleMatches(draft.ruleId, rulesFromComment(text))) return true;
  }
  return false;
}

/**
 * Removes findings a repository has declared intentional, and reports what it
 * removed.
 *
 * Suppression is never silent: the counts come back so the run can say how many
 * findings were withheld and under which rules. A quiet report and a clean
 * repository must not look the same.
 */
export function applySuppressions(
  drafts: readonly AnalysisFindingDraft[],
  files: readonly AnalyzableFile[],
  rules: readonly SuppressionRule[] = [],
): { kept: AnalysisFindingDraft[]; summary: SuppressionSummary } {
  const byPath = new Map(files.map((file) => [file.path, file]));

  const matchers = rules.map((rule) => ({
    rules: rule.rules ?? null,
    matcher: rule.files?.length ? ignore().add(rule.files) : null,
  }));

  const kept: AnalysisFindingDraft[] = [];
  const byRule: Record<string, number> = {};
  let suppressed = 0;

  for (const draft of drafts) {
    const path = draft.filePath;
    const byPolicy = matchers.some(
      (entry) =>
        // A rule with no files at all would suppress the entire report, which
        // is never what someone means; require one of the two to be narrowed.
        (entry.matcher || entry.rules) &&
        (!entry.matcher || (path ? entry.matcher.ignores(path) : false)) &&
        ruleMatches(draft.ruleId, entry.rules),
    );

    if (byPolicy || suppressedInline(path ? byPath.get(path) : undefined, draft)) {
      suppressed++;
      const id = draft.ruleId ?? 'unknown';
      byRule[id] = (byRule[id] ?? 0) + 1;
      continue;
    }
    kept.push(draft);
  }

  return { kept, summary: { suppressed, byRule } };
}
