import { z } from 'zod';

/**
 * The grounding contract. Every prompt in this directory includes it verbatim.
 * It is the single most important instruction in the product: answers must come
 * from the supplied excerpts, and citations are validated afterwards anyway.
 */
export const GROUNDING_RULES = `GROUNDING RULES (mandatory):
- Use ONLY the repository excerpts provided in the context. They are real file contents with real line numbers.
- Never invent file paths, function names, line numbers, frameworks or behaviour. If it is not in the context, you do not know it.
- Cite every claim with the exact file path and line range from the context, e.g. src/auth/AuthService.ts:31-72.
- Line numbers you cite must fall inside the ranges shown in the context. Citations are automatically validated against the index; invented ones are discarded and count against you.
- If the context is insufficient, say so explicitly rather than guessing. The correct answer to an unanswerable question is: "I couldn't determine this confidently from the indexed repository."
- Distinguish what the code does (observable in the excerpts) from what you infer. Label inferences as inferences.
- Secrets in the source have been replaced with [REDACTED_SECRET]; never speculate about their values.`;

export const SEVERITY = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const CONFIDENCE_LABEL = z.enum(['high', 'medium', 'low']);

/** Shape every analyzer prompt must return for an individual finding. */
export const aiFindingSchema = z.object({
  type: z.string().min(1).max(80),
  title: z.string().min(3).max(160),
  description: z.string().min(10).max(2000),
  filePath: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  severity: SEVERITY,
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(3).max(1200),
  recommendation: z.string().min(3).max(1500),
  cwe: z.string().max(20).optional().nullable(),
});

export type AIFinding = z.infer<typeof aiFindingSchema>;

export const findingsResponseSchema = z.object({
  findings: z.array(aiFindingSchema).max(60),
  notes: z.string().max(1500).optional(),
});

export function confidenceLabel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
}

/**
 * Confirmed  - deterministic detector proved it (static analysis, parser, compiler).
 * Likely     - static signal corroborated by AI reasoning, or a very high-confidence AI finding.
 * Potential  - AI-only reasoning; requires human review.
 */
export function findingStatus(
  source: 'static' | 'ai' | 'hybrid' | 'sca' | 'sast',
  confidence: number,
): 'confirmed' | 'likely' | 'potential' {
  // A resolved version either falls in an advisory's affected range or it does
  // not - there is no inference step to be wrong about.
  if (source === 'sca') return confidence >= 0.9 ? 'confirmed' : 'likely';
  // Deterministic pattern and dataflow matching, but rule precision varies, so
  // the rule author's own confidence rating decides.
  if (source === 'sast') return confidence >= 0.9 ? 'confirmed' : 'likely';
  if (source === 'static') return confidence >= 0.9 ? 'confirmed' : 'likely';
  if (source === 'hybrid') return confidence >= 0.75 ? 'likely' : 'potential';
  return confidence >= 0.85 ? 'likely' : 'potential';
}

export const AI_DISCLAIMER =
  'AI-generated findings are recommendations, not guarantees. Verify each one against the code before acting on it; ' +
  'security-relevant findings should be reviewed by a security professional.';

export function contextBlock(label: string, body: string): string {
  return `--- ${label} ---\n${body}\n--- end ${label} ---`;
}
