import type { z } from 'zod';
import { invalidAiResponse } from '../errors';
import { getAIProvider } from './provider';
import { LOCAL_NO_GENERATION } from './providers/local';
import type { AIMessage, AIProvider, CompletionResult } from './types';

export class AIGenerationUnavailable extends Error {
  constructor() {
    super(
      'The configured AI provider does not generate text (AI_PROVIDER=local). ' +
        'Deterministic results are returned instead.',
    );
    this.name = 'AIGenerationUnavailable';
  }
}

export interface StructuredOptions<T> {
  system: string;
  user: string;
  /** Parses raw model output, so the input side is unknown by definition. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  task: string;
  maxTokens?: number;
  temperature?: number;
  /** Number of repair attempts after the first failure. */
  repairAttempts?: number;
  /** Override the provider, e.g. the cheap model used by the triage pass. */
  provider?: AIProvider;
}

export interface StructuredResult<T> {
  data: T;
  usage: Pick<CompletionResult, 'provider' | 'model' | 'inputTokens' | 'outputTokens' | 'latencyMs'>;
  attempts: number;
}

/**
 * Ask the model for JSON, then parse -> validate -> (repair -> revalidate).
 * Raw model output is never trusted: callers only ever see schema-valid data.
 */
export async function generateStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const provider = options.provider ?? getAIProvider();
  if (!provider.supportsGeneration) throw new AIGenerationUnavailable();

  const messages: AIMessage[] = [{ role: 'user', content: options.user }];
  const maxRepairs = options.repairAttempts ?? 2;

  let usage = { provider: provider.name, model: provider.model, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  let lastError = '';

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const result = await provider.complete({
      system: options.system,
      messages,
      json: true,
      task: options.task,
      maxTokens: options.maxTokens,
      temperature: options.temperature ?? 0,
    });

    usage = {
      provider: result.provider,
      model: result.model,
      inputTokens: usage.inputTokens + result.inputTokens,
      outputTokens: usage.outputTokens + result.outputTokens,
      latencyMs: usage.latencyMs + result.latencyMs,
    };

    if (result.text === LOCAL_NO_GENERATION) throw new AIGenerationUnavailable();

    // A response cut off at the token ceiling is never valid JSON, and a repair
    // attempt is sent the same ceiling with a longer conversation, so it is cut
    // off again in the same place. Retrying only burns tokens; say what happened
    // instead, because "could not be validated" points at the schema when the
    // real problem is the budget.
    const hitCeiling = options.maxTokens !== undefined && result.outputTokens >= options.maxTokens;

    const extracted = extractJson(result.text);
    if (extracted.ok) {
      const parsed = options.schema.safeParse(extracted.value);
      if (parsed.success) return { data: parsed.data, usage, attempts: attempt + 1 };
      lastError = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
    } else {
      lastError = hitCeiling
        ? `the response was cut off after ${result.outputTokens} tokens, the entire budget for this request. ` +
          `Raise AI_MAX_OUTPUT_TOKENS (currently ${options.maxTokens}) or ask for a smaller report.`
        : extracted.error;
      if (hitCeiling) break;
    }

    messages.push({ role: 'assistant', content: result.text.slice(0, 4000) });
    messages.push({
      role: 'user',
      content:
        `Your previous response was not valid for the required schema.\n` +
        `Problem: ${lastError}\n\n` +
        `Reply again with ONLY the corrected JSON document. No prose, no markdown fences.`,
    });
  }

  throw invalidAiResponse(
    `The AI provider returned output that could not be validated for task "${options.task}": ` +
      `${lastError.slice(0, 400) || 'no further detail'}.`,
    { lastError },
  );
}

/** Plain-text generation (used for prose sections such as documentation). */
export async function generateText(options: {
  system: string;
  user: string;
  task: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<CompletionResult> {
  const provider = getAIProvider();
  if (!provider.supportsGeneration) throw new AIGenerationUnavailable();
  const result = await provider.complete({
    system: options.system,
    messages: [{ role: 'user', content: options.user }],
    task: options.task,
    maxTokens: options.maxTokens,
    temperature: options.temperature ?? 0,
  });
  if (result.text === LOCAL_NO_GENERATION) throw new AIGenerationUnavailable();
  return result;
}

type Extracted = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Pull a JSON document out of a model response that may be wrapped in prose or
 * markdown fences. Tries, in order: whole string, fenced block, balanced-brace
 * scan from the first `{` or `[`.
 */
export function extractJson(text: string): Extracted {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty response' };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) return fenced;
  }

  const start = firstJsonIndex(trimmed);
  if (start >= 0) {
    const candidate = balancedSlice(trimmed, start);
    if (candidate) {
      const scanned = tryParse(candidate);
      if (scanned.ok) return scanned;
    }
  }

  return { ok: false, error: 'response did not contain a parseable JSON document' };
}

function tryParse(input: string): Extracted {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function firstJsonIndex(text: string): number {
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
}

function balancedSlice(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
