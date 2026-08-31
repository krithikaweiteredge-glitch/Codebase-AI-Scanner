import { env } from '../env';
import type { AIProvider } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
import { LocalProvider } from './providers/local';

let cached: AIProvider | null = null;

/** Factory for the configured AI provider. Business logic depends only on the interface. */
export function getAIProvider(): AIProvider {
  if (cached) return cached;
  switch (env.AI_PROVIDER) {
    case 'anthropic':
      cached = new AnthropicProvider(
        env.AI_MODEL,
        env.AI_API_KEY,
        env.AI_BASE_URL || undefined,
        env.AI_MAX_OUTPUT_TOKENS,
      );
      break;
    case 'openai':
      cached = new OpenAIProvider(
        env.AI_MODEL,
        env.AI_API_KEY,
        env.AI_BASE_URL || undefined,
        env.AI_MAX_OUTPUT_TOKENS,
      );
      break;
    case 'groq':
      cached = new OpenAIProvider(
        env.AI_MODEL || 'groq/compound',
        env.AI_API_KEY,
        env.AI_BASE_URL || 'https://api.groq.com/openai',
        env.AI_MAX_OUTPUT_TOKENS,
        'groq',
      );
      break;
    case 'gemini':
      cached = new OpenAIProvider(
        env.AI_MODEL || 'gemini-3.6-flash',
        env.AI_API_KEY,
        env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
        env.AI_MAX_OUTPUT_TOKENS,
        'gemini',
      );
      break;
    default:
      cached = new LocalProvider();
  }
  return cached;
}

let cachedTriage: AIProvider | null = null;

/**
 * Provider for the triage pass, which sweeps every file rather than the top
 * slice. That only makes sense on a cheap, fast model, so it runs against
 * AI_TRIAGE_MODEL on the same account and endpoint. Falling back to AI_MODEL
 * keeps the pass working when no cheaper model is configured - it just costs
 * what the deep review costs.
 */
export function getTriageProvider(): AIProvider {
  if (cachedTriage) return cachedTriage;

  const triageModel = env.AI_TRIAGE_MODEL.trim();
  if (!triageModel || triageModel === env.AI_MODEL) {
    cachedTriage = getAIProvider();
    return cachedTriage;
  }

  switch (env.AI_PROVIDER) {
    case 'anthropic':
      cachedTriage = new AnthropicProvider(triageModel, env.AI_API_KEY, env.AI_BASE_URL || undefined, env.AI_MAX_OUTPUT_TOKENS);
      break;
    case 'openai':
      cachedTriage = new OpenAIProvider(triageModel, env.AI_API_KEY, env.AI_BASE_URL || undefined, env.AI_MAX_OUTPUT_TOKENS);
      break;
    case 'groq':
      cachedTriage = new OpenAIProvider(
        triageModel,
        env.AI_API_KEY,
        env.AI_BASE_URL || 'https://api.groq.com/openai',
        env.AI_MAX_OUTPUT_TOKENS,
        'groq',
      );
      break;
    case 'gemini':
      cachedTriage = new OpenAIProvider(
        triageModel,
        env.AI_API_KEY,
        env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
        env.AI_MAX_OUTPUT_TOKENS,
        'gemini',
      );
      break;
    default:
      cachedTriage = getAIProvider();
  }
  return cachedTriage;
}

/** Test seam. */
export function setAIProvider(provider: AIProvider | null): void {
  cached = provider;
  cachedTriage = provider;
}

export function aiEnabled(): boolean {
  return getAIProvider().supportsGeneration;
}
