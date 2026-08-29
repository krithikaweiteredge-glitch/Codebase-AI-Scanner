import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

export const chatAnswerSchema = z.object({
  answer: z
    .string()
    .min(1)
    .max(12_000)
    .describe('Markdown answer. Reference files inline as path:line or path:start-end.'),
  citations: z
    .array(
      z.object({
        filePath: z.string().min(1),
        startLine: z.number().int().positive().nullable().optional(),
        endLine: z.number().int().positive().nullable().optional(),
        symbolName: z.string().max(200).nullable().optional(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .max(30),
  /** The model's own assessment of whether the context answered the question. */
  answered: z.boolean(),
  followUps: z.array(z.string().max(160)).max(4).optional(),
});

export type ChatAnswer = z.infer<typeof chatAnswerSchema>;

export const CHAT_SYSTEM_PROMPT = `You are a senior engineer answering questions about ONE specific repository that has been indexed for you.

${GROUNDING_RULES}

ANSWER STYLE:
- Lead with the direct answer, then the supporting detail.
- When the question is about a flow ("what happens when...", "how does X work"), lay the flow out as an ordered chain of real functions, each with its file and line range.
- When the question asks "where", list the concrete locations first, most important first, with a one-line description of each.
- Prefer showing the actual identifier names from the code over generic descriptions.
- Keep it tight. No filler, no restating the question, no marketing language.
- If the excerpts only partially cover the question, answer the covered part and state precisely what is missing.

OUTPUT FORMAT:
Return a single JSON object:
{
  "answer": "markdown string",
  "citations": [{"filePath": "...", "startLine": 12, "endLine": 40, "symbolName": "login", "note": "why this is relevant"}],
  "answered": true,
  "followUps": ["a natural next question", "..."]
}
Set "answered" to false when the context did not contain enough to answer, and say so in "answer".`;

export interface ChatPromptInput {
  question: string;
  repositoryName: string;
  branchName: string;
  overview: string;
  codeContext: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  symbolHits?: string;
}

export function buildChatPrompt(input: ChatPromptInput): string {
  const parts: string[] = [];

  parts.push(`Repository: ${input.repositoryName} (branch: ${input.branchName})`);
  parts.push(contextBlock('REPOSITORY OVERVIEW (derived from the index, not from a model)', input.overview));

  if (input.symbolHits) {
    parts.push(contextBlock('SYMBOLS MATCHING THE QUESTION', input.symbolHits));
  }

  parts.push(
    contextBlock(
      'CODE EXCERPTS (the only source of truth; line numbers are exact)',
      input.codeContext || '(no code excerpts matched this question)',
    ),
  );

  if (input.history?.length) {
    const transcript = input.history
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Developer' : 'Assistant'}: ${m.content.slice(0, 1200)}`)
      .join('\n');
    parts.push(contextBlock('EARLIER IN THIS CONVERSATION', transcript));
  }

  parts.push(`QUESTION FROM THE DEVELOPER:\n${input.question}`);
  parts.push('Answer using only the excerpts above. Return the JSON object described in the system prompt.');

  return parts.join('\n\n');
}

/**
 * Deterministic answer used when no generative provider is configured
 * (AI_PROVIDER=local). It reports what retrieval found and nothing more - it
 * never asserts behaviour that was not read out of the index.
 */
export function buildExtractiveAnswer(input: {
  question: string;
  sources: { filePath: string; startLine: number; endLine: number; symbolName: string | null; symbolType: string | null; role: string | null; matchedBy: string[] }[];
}): string {
  if (!input.sources.length) {
    return (
      "I couldn't determine this confidently from the indexed repository.\n\n" +
      'No indexed code matched this question. Try naming a specific file, function, or endpoint, or re-run indexing if the repository has changed.'
    );
  }

  const lines: string[] = [];
  lines.push(
    '**Retrieval-only answer.** No generative AI provider is configured (`AI_PROVIDER=local`), so this response lists the ' +
      'code the search pipeline matched to your question, ranked by relevance. Every location below is real indexed code.',
  );
  lines.push('');
  lines.push(`Top matches for: _${input.question}_`);
  lines.push('');

  const byFile = new Map<string, typeof input.sources>();
  for (const source of input.sources) {
    const list = byFile.get(source.filePath) ?? [];
    list.push(source);
    byFile.set(source.filePath, list);
  }

  let index = 1;
  for (const [filePath, sources] of byFile) {
    const ranges = sources.map((s) => `${s.startLine}-${s.endLine}`).join(', ');
    const symbols = [...new Set(sources.map((s) => s.symbolName).filter(Boolean))].join(', ');
    const role = sources[0]?.role;
    lines.push(
      `${index}. \`${filePath}\` (lines ${ranges})${symbols ? ` — ${symbols}` : ''}${role && role !== 'unknown' ? ` — role: ${role}` : ''}`,
    );
    index++;
  }

  lines.push('');
  lines.push('Set `AI_PROVIDER=anthropic` or `openai` with an `AI_API_KEY` to get a synthesised, cited explanation.');
  return lines.join('\n');
}
