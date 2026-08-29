import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

export const duplicateAssessmentSchema = z.object({
  duplicates: z
    .array(
      z.object({
        title: z.string().min(3).max(160),
        description: z.string().min(10).max(1200),
        filePath: z.string().min(1),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive().optional(),
        relatedFilePath: z.string().min(1),
        relatedStartLine: z.number().int().positive(),
        relatedEndLine: z.number().int().positive().optional(),
        similarity: z.number().min(0).max(1),
        verdict: z.enum(['duplicate', 'similar-but-different', 'false-positive']),
        recommendation: z.string().min(3).max(1200),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(40),
});

export const DUPLICATE_SYSTEM_PROMPT = `You review candidate duplicate code pairs that a deterministic similarity detector has already found.

${GROUNDING_RULES}

For each candidate pair decide:
- "duplicate": the two bodies do the same work and should share one implementation.
- "similar-but-different": structurally alike but semantically distinct (different domain, different invariants). Consolidating them would be wrong.
- "false-positive": the similarity is incidental (boilerplate, generated code, interface implementations, test fixtures).

Rules:
- Judge behaviour, not shape. Identical-looking validators for different domains are not duplicates.
- The recommendation must be concrete: which function survives, where the shared helper belongs, what the call sites become.
- Keep the file paths and line numbers exactly as given.

Return JSON: {"duplicates": [...]} using the fields shown, including every candidate you were given with your verdict.`;

export interface DuplicatePromptInput {
  repositoryName: string;
  candidates: string;
}

export function buildDuplicatePrompt(input: DuplicatePromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    contextBlock('CANDIDATE DUPLICATE PAIRS (from token-level similarity analysis)', input.candidates),
    'Assess each pair and return the JSON object described in the system prompt.',
  ].join('\n\n');
}
