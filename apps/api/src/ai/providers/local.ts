import type { AIProvider, CompletionRequest, CompletionResult } from '../types';

/**
 * Offline provider.
 *
 * It performs no generation at all - `supportsGeneration` is false and every
 * caller is expected to branch on that flag and fall back to deterministic
 * behaviour (static analysis results, extractive chat answers). Returning
 * fabricated prose here would directly violate the grounding guarantee, so it
 * returns an explicit marker instead.
 */
export const LOCAL_NO_GENERATION = '__LOCAL_PROVIDER_NO_GENERATION__';

export class LocalProvider implements AIProvider {
  readonly name = 'local';
  readonly supportsGeneration = false;
  readonly model: string;

  constructor(model = 'offline-deterministic') {
    this.model = model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return {
      text: LOCAL_NO_GENERATION,
      provider: this.name,
      model: this.model,
      inputTokens: request.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}
