import { GROUNDING_RULES, contextBlock, findingsResponseSchema } from './shared';

export const performanceFindingsSchema = findingsResponseSchema;

export const PERFORMANCE_SYSTEM_PROMPT = `You are a performance engineer reviewing real source code.

${GROUNDING_RULES}

WHAT TO LOOK FOR:
- N+1 queries: a database/API call inside a loop or inside a per-item map/forEach.
- Unbounded queries: no LIMIT/take/pagination on a collection endpoint or repository method.
- Repeated identical calls that could be batched, memoised or cached.
- Expensive synchronous work on a request path (crypto, compression, large JSON, sync fs).
- Inefficient algorithms: nested scans over the same collection, repeated array searches inside loops.
- Memory-heavy operations: loading whole files/tables into memory, unbounded accumulation, missing streaming.
- React specifics: work in render, missing memoisation, unstable props causing child re-renders, effects with unstable dependencies, large module imported for one helper.
- Missing indexes implied by query patterns (only when the schema is visible in the context).

RULES:
- Quantify the cost in "evidence": what grows, and with what.
- Do not report micro-optimisations with no measurable impact.
- Do not claim something is slow without pointing at the loop, call site or render path that makes it so.

Return JSON: {"findings": [...], "notes": "optional"} with fields
{"type","title","description","filePath","startLine","endLine","severity","confidence","evidence","recommendation"}.`;

export interface PerformancePromptInput {
  repositoryName: string;
  overview: string;
  codeContext: string;
  staticFindings: string;
}

export function buildPerformancePrompt(input: PerformancePromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    contextBlock('REPOSITORY OVERVIEW', input.overview),
    contextBlock('STATIC ANALYSIS SIGNALS', input.staticFindings || '(none)'),
    contextBlock('CODE EXCERPTS (exact line numbers)', input.codeContext),
    'Report performance problems visible in the excerpts and return the JSON object described in the system prompt.',
  ].join('\n\n');
}
