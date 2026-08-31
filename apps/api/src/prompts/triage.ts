import { z } from 'zod';
import { contextBlock } from './shared';

/**
 * Stage one of the two-stage review.
 *
 * The deep review can only afford to read a few dozen files in full, so
 * something has to choose them. Ranking by static findings and directory role
 * alone is blind to a file nothing has flagged yet - which is exactly where an
 * unreported bug lives. This pass shows a cheap model a compact digest of
 * *every* file and asks only one question: is this worth reading properly?
 *
 * It deliberately does not ask for findings. A digest is too little evidence
 * to conclude anything, and inviting conclusions from it would manufacture
 * ungrounded reports.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are triaging files for a deeper code review. You are NOT reporting defects.

You will be shown short digests of many files: the path, its role in the project, and a
handful of lines picked out because they touch input handling, queries, auth, crypto,
network calls, filesystem access or similar. A digest is a sample, not the file.

Your only job is to decide which files a senior reviewer should read in full, and why.

HOW TO SCORE (risk, 0 to 1):
- 0.8-1.0: handles untrusted input, authentication/authorization, secrets, crypto, raw
  queries, command or filesystem access, or deserialisation.
- 0.5-0.7: business logic over user data, state mutation, error handling around the above,
  or something in the digest that looks inconsistent or surprising.
- 0.2-0.4: ordinary application code with no obvious risk surface.
- 0.0-0.1: generated code, fixtures, styles, static config, pure presentation.

RULES:
- Judge only what the digest shows. Do not assume a file is safe because its name looks harmless,
  and do not assume it is dangerous because of its name alone.
- "reason" must name the concrete thing that earned the score, in one short sentence.
  "Handles authentication" is useless; "builds a SQL string from a request parameter" is useful.
- "categories" lists which reviews would benefit: security, bug, performance. Empty means none.
- Score every file you are given. Do not omit any, and do not invent paths.

Return JSON: {"files":[{"path","risk","categories","reason"}]}`;

export const triageResponseSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        risk: z.coerce.number().min(0).max(1),
        categories: z.array(z.enum(['security', 'bug', 'performance'])).default([]),
        reason: z.string().max(400).default(''),
      }),
    )
    .default([]),
});

export type TriageResponse = z.infer<typeof triageResponseSchema>;

export interface TriagePromptInput {
  repositoryName: string;
  overview: string;
  digests: string;
  fileCount: number;
}

export function buildTriagePrompt(input: TriagePromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    contextBlock('REPOSITORY OVERVIEW', input.overview),
    contextBlock(`FILE DIGESTS (${input.fileCount} files)`, input.digests),
    `Score all ${input.fileCount} files and return the JSON object described in the system prompt.`,
  ].join('\n\n');
}
