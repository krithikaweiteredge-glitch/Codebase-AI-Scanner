/**
 * Evaluates repository policies against indexed files.
 *
 * Matching is done line by line rather than over whole files, for two reasons.
 * It yields an exact line number for the finding, and - more importantly - it
 * caps the input any single regex sees. Catastrophic backtracking scales with
 * input length, and the patterns here come from the scanned repository, so
 * bounding them is what stops a hostile or careless policy file stalling the
 * shared analysis worker.
 */

import ignore from 'ignore';
import { confidenceLabel, findingStatus } from '../../prompts/shared';
import type { AnalysisFindingDraft, AnalyzableFile } from '../types';
import type { PolicyRule } from './schema';

/** Lines longer than this are truncated before matching. */
const MAX_LINE_LENGTH = 2000;
/** Findings reported per rule, so one bad policy cannot flood a run. */
const MAX_VIOLATIONS_PER_RULE = 50;

export interface PolicyEvaluation {
  drafts: AnalysisFindingDraft[];
  /** Rules that matched no files at all - usually a glob typo. */
  unmatchedRules: string[];
}

interface Matcher {
  matches: (path: string) => boolean;
}

/** gitignore syntax, which the indexer already uses, so globs behave consistently. */
function buildMatcher(rule: PolicyRule): Matcher {
  const include = rule.files?.length ? ignore().add(rule.files) : null;
  const exclude = rule.exclude?.length ? ignore().add(rule.exclude) : null;

  return {
    matches(path: string) {
      if (exclude?.ignores(path)) return false;
      // No `files` means the rule applies everywhere.
      return include ? include.ignores(path) : true;
    },
  };
}

function truncate(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
}

/** Compiled once per rule rather than per line. */
function compile(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) return [];
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern));
    } catch {
      // parsePolicy already filtered these; ignore defensively.
    }
  }
  return out;
}

export function evaluatePolicies(
  rules: readonly PolicyRule[],
  files: readonly AnalyzableFile[],
  policyPath: string,
): PolicyEvaluation {
  const drafts: AnalysisFindingDraft[] = [];
  const unmatchedRules: string[] = [];

  for (const rule of rules) {
    const matcher = buildMatcher(rule);
    const scoped = files.filter((file) => !file.isGenerated && matcher.matches(file.path));

    if (!scoped.length) {
      unmatchedRules.push(rule.id);
      continue;
    }

    const forbidPatterns = compile(rule.forbidPattern);
    const requirePatterns = compile(rule.requirePattern);
    let reported = 0;

    for (const file of scoped) {
      if (reported >= MAX_VIOLATIONS_PER_RULE) break;
      const lines = file.content.split('\n');

      // ---- forbid: report the offending line ----------------------------
      for (let i = 0; i < lines.length && reported < MAX_VIOLATIONS_PER_RULE; i++) {
        const line = truncate(lines[i] ?? '');
        if (!line.trim()) continue;

        const literal = (rule.forbid ?? []).find((needle) => line.includes(needle));
        const pattern = literal ? null : forbidPatterns.find((re) => re.test(line));
        if (!literal && !pattern) continue;

        drafts.push(
          toDraft(rule, policyPath, file.path, i + 1, line.trim(), {
            kind: 'forbidden',
            matched: literal ?? pattern?.source ?? '',
          }),
        );
        reported++;
      }

      // ---- require: absence is the violation, so it belongs to the file --
      if (rule.require?.length || requirePatterns.length) {
        const missingLiterals = (rule.require ?? []).filter((needle) => !file.content.includes(needle));
        const missingPatterns = requirePatterns
          .filter((re) => !lines.some((line) => re.test(truncate(line))))
          .map((re) => re.source);
        const missing = [...missingLiterals, ...missingPatterns];

        if (missing.length && reported < MAX_VIOLATIONS_PER_RULE) {
          drafts.push(
            toDraft(rule, policyPath, file.path, 1, '', { kind: 'missing', matched: missing.join(', ') }),
          );
          reported++;
        }
      }
    }
  }

  return { drafts, unmatchedRules };
}

function toDraft(
  rule: PolicyRule,
  policyPath: string,
  filePath: string,
  line: number,
  snippet: string,
  detail: { kind: 'forbidden' | 'missing'; matched: string },
): AnalysisFindingDraft {
  const explanation =
    detail.kind === 'forbidden'
      ? `This file matches policy \`${rule.id}\`, which forbids \`${detail.matched}\`.`
      : `This file matches policy \`${rule.id}\`, which requires \`${detail.matched}\` — and it is absent.`;

  return {
    category: 'security',
    ruleId: `policy.${rule.id}`,
    type: 'policy-violation',
    severity: rule.severity,
    title: rule.description,
    description: [rule.message ?? explanation, '', `Declared in \`${policyPath}\`.`].join('\n'),
    evidence:
      detail.kind === 'forbidden'
        ? `${filePath}:${line} matched the forbidden ${snippet ? `expression in: ${snippet.slice(0, 200)}` : 'expression'}`
        : `${filePath} does not contain the required ${detail.matched}`,
    recommendation:
      rule.remediation ??
      'Either change the code to satisfy the policy, or amend the policy if the rule no longer reflects intent.',
    filePath,
    startLine: line,
    endLine: line,
    ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
    // The project asserted this rule itself, so a match is not a guess.
    confidence: 0.95,
    confidenceLabel: confidenceLabel(0.95),
    status: findingStatus('static', 0.95),
    source: 'static',
    ...(rule.cwe ? { cwe: rule.cwe } : {}),
    metadata: {
      detector: 'policy',
      policyId: rule.id,
      policyFile: policyPath,
      violation: detail.kind,
      matched: detail.matched,
    },
  };
}
