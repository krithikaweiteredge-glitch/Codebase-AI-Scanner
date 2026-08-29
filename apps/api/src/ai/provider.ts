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

/** Test seam. */
export function setAIProvider(provider: AIProvider | null): void {
  cached = provider;
}

export function aiEnabled(): boolean {
  return getAIProvider().supportsGeneration;
}
