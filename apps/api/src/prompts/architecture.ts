import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

/**
 * The report shape is written out rather than inferred from the schema below.
 * `z.infer` on a schema this deeply nested sits right at TypeScript's inference
 * limit: past it the compiler silently degrades the result, marking required
 * array properties optional, and every `Pick<ArchitectureReport, ...>` in the
 * analyser breaks with an error that points at the consumer rather than the
 * cause. Declaring the type fixes it in place, and the annotation on the schema
 * makes the compiler prove the two still agree.
 */
export interface ArchitectureLayer {
  name: string;
  purpose: string;
  directories: string[];
  keyFiles: string[];
}

export interface ArchitectureDirectoryPurpose {
  path: string;
  purpose: string;
  responsibilities: string[];
  importantFiles: string[];
}

export interface ArchitectureFlowStep {
  label: string;
  filePath?: string | null;
  startLine?: number | null;
}

export interface ArchitectureFlow {
  name: string;
  steps: ArchitectureFlowStep[];
}

export interface ArchitectureRisk {
  title: string;
  detail: string;
  filePath?: string | null;
  severity: 'high' | 'medium' | 'low';
}

export interface ArchitectureReport {
  summary: string;
  layers: ArchitectureLayer[];
  directoryPurposes: ArchitectureDirectoryPurpose[];
  flows: ArchitectureFlow[];
  mermaid: string;
  risks: ArchitectureRisk[];
}
// The input is `unknown` on purpose: this only ever parses a JSON document
// from a model, and the `.default([])` on the nested arrays means a valid
// input may legitimately omit keys the output always has.
export const architectureSchema: z.ZodType<ArchitectureReport, z.ZodTypeDef, unknown> = z.object({
  summary: z.string().min(20).max(4000),
  layers: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        purpose: z.string().min(5).max(600),
        directories: z.array(z.string().max(200)).max(12).default([]),
        keyFiles: z.array(z.string().max(200)).max(12).default([]),
      }),
    )
    .max(12)
    .default([]),
  directoryPurposes: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        purpose: z.string().min(5).max(600),
        responsibilities: z.array(z.string().max(200)).max(8).default([]),
        importantFiles: z.array(z.string().max(200)).max(8).default([]),
      }),
    )
    .max(40)
    .default([]),
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
    .max(8)
    .default([]),
  mermaid: z.string().max(6000).describe('A mermaid `flowchart TD` diagram of the real modules'),
  risks: z
    .array(
      z.object({
        title: z.string().max(160),
        detail: z.string().max(800),
        filePath: z.string().max(240).nullable().optional(),
        severity: z.enum(['high', 'medium', 'low']).default('medium'),
      }),
    )
    .max(15)
    .default([]),
});


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
