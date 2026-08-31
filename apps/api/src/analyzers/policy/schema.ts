/**
 * Repository policy: rules a project asserts about its own code.
 *
 * Every other detector encodes what *we* think is wrong. This one encodes what
 * the project says must be true - "admin routes go through the auth guard",
 * "raw SQL stays in the data layer", "a signature verifier never returns true
 * on a missing secret". That distinction matters, because the largest class of
 * defect this scanner cannot otherwise reach is the one that requires knowing
 * intent, and here the user supplies it.
 *
 * A finding from a policy has no false-positive question: the rule is the
 * project's own, and a violation is a violation by definition.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Where the policy file is looked for, in order. */
export const POLICY_PATHS = [
  '.codebase-ai/policy.yml',
  '.codebase-ai/policy.yaml',
  '.codebase-ai/policy.json',
  'codebase-ai.policy.yml',
  'codebase-ai.policy.yaml',
  'codebase-ai.policy.json',
];

/**
 * Bounds. The policy file comes from the scanned repository, so a hostile or
 * merely careless one must not be able to stall the shared analysis worker.
 * Patterns are additionally matched per line (see evaluate.ts), which is what
 * actually caps backtracking cost.
 */
export const MAX_POLICIES = 100;
export const MAX_PATTERN_LENGTH = 300;

const severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);

/** Accepts a bare string or a list, because both read naturally in YAML. */
const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === 'string' ? [value] : value));

const boundedPatternList = stringList.refine(
  (patterns) => patterns.every((p) => p.length <= MAX_PATTERN_LENGTH),
  { message: `each pattern must be at most ${MAX_PATTERN_LENGTH} characters` },
);

export const policyRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/, 'id may contain letters, numbers, dot, dash and underscore only'),
    description: z.string().min(1).max(400),
    severity: severity.default('high'),
    /** gitignore-syntax globs. Omitted means every indexed file. */
    files: stringList.optional(),
    exclude: stringList.optional(),

    /** Literal substrings that must all be present in a matching file. */
    require: stringList.optional(),
    /** Regular expressions that must all match somewhere in a matching file. */
    requirePattern: boundedPatternList.optional(),
    /** Literal substrings that must not appear. */
    forbid: stringList.optional(),
    /** Regular expressions that must not match. */
    forbidPattern: boundedPatternList.optional(),

    /** Shown instead of the generic explanation. */
    message: z.string().max(600).optional(),
    /** What the author should do about it. */
    remediation: z.string().max(600).optional(),
    cwe: z.string().max(20).optional(),
  })
  .refine(
    (rule) => Boolean(rule.require || rule.requirePattern || rule.forbid || rule.forbidPattern),
    { message: 'a rule must assert at least one of: require, requirePattern, forbid, forbidPattern' },
  );

export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyFileSchema = z.object({
  version: z.literal(1).default(1),
  policies: z.array(policyRuleSchema).max(MAX_POLICIES),
});

export type PolicyFile = z.infer<typeof policyFileSchema>;

export interface PolicyParseResult {
  file: PolicyFile | null;
  /** Human-readable problems. A malformed policy is reported, never silently ignored. */
  errors: string[];
}

/**
 * Parses a policy document. A broken policy file is itself worth reporting -
 * silently ignoring it would let a project believe it has guardrails it does
 * not have, which is worse than having none.
 */
export function parsePolicy(path: string, content: string): PolicyParseResult {
  let raw: unknown;

  try {
    raw = path.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
  } catch (error) {
    return { file: null, errors: [`${path}: could not be parsed - ${(error as Error).message}`] };
  }

  if (raw === null || raw === undefined) {
    return { file: null, errors: [`${path}: file is empty`] };
  }

  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      file: null,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${path}: ${issue.path.join('.') || '(root)'} - ${issue.message}`),
    };
  }

  // Reject regexes that will not compile, rather than throwing mid-scan.
  const errors: string[] = [];
  const usable = parsed.data.policies.filter((rule) => {
    const bad = [...(rule.requirePattern ?? []), ...(rule.forbidPattern ?? [])].filter((pattern) => {
      try {
        new RegExp(pattern);
        return false;
      } catch (error) {
        errors.push(`${path}: policy "${rule.id}" has an invalid pattern - ${(error as Error).message}`);
        return true;
      }
    });
    return bad.length === 0;
  });

  const seen = new Set<string>();
  for (const rule of usable) {
    if (seen.has(rule.id)) errors.push(`${path}: duplicate policy id "${rule.id}"`);
    seen.add(rule.id);
  }

  return { file: { version: parsed.data.version, policies: usable }, errors };
}
