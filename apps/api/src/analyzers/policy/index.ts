/**
 * Discovers and runs the repository's own policy file.
 *
 * The file is read from the indexed tree rather than fetched separately, so it
 * is always the version belonging to the commit under analysis.
 */

import { confidenceLabel, findingStatus } from '../../prompts/shared';
import type { AnalysisFindingDraft, AnalyzableFile } from '../types';
import { evaluatePolicies } from './evaluate';
import { parsePolicy, POLICY_PATHS } from './schema';

export interface PolicyResult {
  drafts: AnalysisFindingDraft[];
  /** Path of the policy file that was used, if any. */
  policyPath: string | null;
  rulesEvaluated: number;
  violations: number;
  /** Rules whose globs matched nothing - usually a typo worth surfacing. */
  unmatchedRules: string[];
}

const EMPTY: PolicyResult = {
  drafts: [],
  policyPath: null,
  rulesEvaluated: 0,
  violations: 0,
  unmatchedRules: [],
};

export function runPolicies(files: readonly AnalyzableFile[]): PolicyResult {
  const byPath = new Map(files.map((file) => [file.path, file]));

  const policyFile = POLICY_PATHS.map((path) => byPath.get(path)).find(Boolean);
  if (!policyFile) return EMPTY;

  const { file, errors } = parsePolicy(policyFile.path, policyFile.content);

  // A policy file that does not parse is itself a finding. Ignoring it would
  // let a project believe it has guardrails that are not actually running.
  const drafts: AnalysisFindingDraft[] = errors.map((message, index) =>
    configurationFinding(policyFile.path, message, index),
  );

  if (!file || !file.policies.length) {
    return { ...EMPTY, drafts, policyPath: policyFile.path };
  }

  const evaluation = evaluatePolicies(file.policies, files, policyFile.path);
  drafts.push(...evaluation.drafts);

  // A rule whose glob matches nothing is silently inert - the project believes
  // it is protected and is not. That is the most common way to get a policy
  // wrong, so it is reported rather than left to be discovered later.
  for (const ruleId of evaluation.unmatchedRules) {
    drafts.push(
      configurationFinding(
        policyFile.path,
        `policy "${ruleId}" matched no files - check its \`files\` pattern`,
        file.policies.findIndex((rule) => rule.id === ruleId),
      ),
    );
  }

  return {
    drafts,
    policyPath: policyFile.path,
    rulesEvaluated: file.policies.length,
    violations: evaluation.drafts.length,
    unmatchedRules: evaluation.unmatchedRules,
  };
}

function configurationFinding(path: string, message: string, index: number): AnalysisFindingDraft {
  return {
    category: 'quality',
    ruleId: 'policy.invalid-configuration',
    type: 'policy-configuration',
    severity: 'medium',
    title: 'Repository policy file could not be applied',
    description:
      `${message}\n\nThe affected rule was skipped, so any guardrail it was meant to provide is not running.`,
    filePath: path,
    startLine: 1,
    endLine: 1,
    confidence: 1,
    confidenceLabel: confidenceLabel(1),
    status: findingStatus('static', 1),
    source: 'static',
    recommendation: 'Correct the policy file so the rule is evaluated.',
    metadata: { detector: 'policy', issue: 'invalid-configuration', ordinal: index },
  };
}

export { POLICY_PATHS } from './schema';
export type { PolicyRule } from './schema';
