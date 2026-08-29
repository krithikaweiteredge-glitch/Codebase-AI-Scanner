import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

export const testSuggestionSchema = z.object({
  framework: z.string().min(1).max(60),
  target: z.string().min(1).max(200),
  rationale: z.string().max(1500).optional(),
  cases: z
    .array(
      z.object({
        name: z.string().min(3).max(200),
        kind: z.enum(['happy-path', 'edge-case', 'error-path', 'security', 'regression']),
        given: z.string().max(600),
        expected: z.string().max(600),
        priority: z.enum(['high', 'medium', 'low']),
      }),
    )
    .min(1)
    .max(30),
  code: z.string().max(12_000).optional(),
  uncoveredBehaviour: z.array(z.string().max(300)).max(15).optional(),
});

export type TestSuggestionPayload = z.infer<typeof testSuggestionSchema>;

export const TEST_SYSTEM_PROMPT = `You design unit tests for code you can actually see.

${GROUNDING_RULES}

Rules:
- Use the repository's existing test framework, import style, assertion style and mocking approach. They are shown to you; do not assume Jest.
- Every case must correspond to a real branch, guard, throw, or return path in the excerpt. Name the behaviour, not the implementation.
- Cover: the happy path, each error/guard branch, boundary inputs, and any dependency failure the code visibly handles.
- Do not invent exported functions, parameter names, error classes or fixture helpers that are not visible.
- If the target has no observable behaviour worth testing, say so in "rationale" and return the single most valuable case.
- "code" must be a complete, runnable test file for the detected framework, importing the target from its real path.

Return JSON: {"framework","target","rationale","cases":[{"name","kind","given","expected","priority"}],"code","uncoveredBehaviour":[...]}.`;

export interface TestPromptInput {
  repositoryName: string;
  target: string;
  filePath: string;
  framework: string;
  frameworkEvidence: string;
  targetCode: string;
  existingTestExample?: string;
  dependencies?: string;
}

export function buildTestPrompt(input: TestPromptInput): string {
  const parts = [
    `Repository: ${input.repositoryName}`,
    `Target: ${input.target} in ${input.filePath}`,
    `Detected test framework: ${input.framework} (${input.frameworkEvidence})`,
    contextBlock('TARGET CODE (exact line numbers)', input.targetCode),
  ];
  if (input.dependencies) parts.push(contextBlock('COLLABORATORS THE TARGET USES', input.dependencies));
  if (input.existingTestExample) {
    parts.push(contextBlock('EXISTING TEST FROM THIS REPOSITORY (match this style, imports and mocking)', input.existingTestExample));
  }
  parts.push('Produce the test plan and test file as the JSON object described in the system prompt.');
  return parts.join('\n\n');
}
