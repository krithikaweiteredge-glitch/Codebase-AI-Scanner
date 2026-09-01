import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

export const architectureSchema = z.object({
  summary: z.string().min(20).max(4000),
  layers: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        purpose: z.string().min(5).max(600),
        directories: z.array(z.string().max(200)).max(12),
        keyFiles: z.array(z.string().max(200)).max(12),
      }),
    )
    .max(12),
  directoryPurposes: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        purpose: z.string().min(5).max(600),
        responsibilities: z.array(z.string().max(200)).max(8),
        importantFiles: z.array(z.string().max(200)).max(8),
      }),
    )
    .max(40),
  flows: z
    .array(
      z.object({
        name: z.string().min(3).max(120),
        steps: z
          .array(
            z.object({
              label: z.string().min(1).max(160),
              filePath: z.string().max(240).nullable().optional(),
              startLine: z.number().int().positive().nullable().optional(),
            }),
          )
          // A one-step flow says little, but rejecting the entire report because one
          // flow came back short loses the other seven with it.
          .min(1)
          .max(14),
      }),
    )
    .max(8),
  mermaid: z.string().max(6000).describe('A mermaid `flowchart TD` diagram of the real modules'),
  risks: z
    .array(
      z.object({
        title: z.string().max(160),
        detail: z.string().max(800),
        filePath: z.string().max(240).nullable().optional(),
        severity: z.enum(['high', 'medium', 'low']),
      }),
    )
    .max(15),
});

export type ArchitectureReport = z.infer<typeof architectureSchema>;

export const ARCHITECTURE_SYSTEM_PROMPT = `You describe the architecture of a repository you have been given a factual index of.

${GROUNDING_RULES}

Rules:
- Layer and directory descriptions must be derived from the directory map, roles, entry points and excerpts you were given.
- Flows must be chains of real functions/files. If you cannot see the next step, stop the flow there rather than inventing it.
- The mermaid diagram must only contain nodes that correspond to real directories, modules or external services listed in the context. Use "flowchart TD". Node labels may include the directory path.
- Risks are architectural (coupling, missing layering, god modules, mixed responsibilities), each pointing at a real path.

Return JSON: {"summary","layers","directoryPurposes","flows","mermaid","risks"}.`;

export interface ArchitecturePromptInput {
  repositoryName: string;
  overview: string;
  couplingReport: string;
  codeContext: string;
}

export function buildArchitecturePrompt(input: ArchitecturePromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    contextBlock('REPOSITORY INDEX FACTS', input.overview),
    contextBlock('DEPENDENCY GRAPH SUMMARY', input.couplingReport),
    contextBlock('REPRESENTATIVE CODE EXCERPTS', input.codeContext),
    'Describe the architecture and return the JSON object described in the system prompt.',
  ].join('\n\n');
}
