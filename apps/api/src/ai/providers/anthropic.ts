import { aiUnavailable } from '../../errors';
import { defaultRetryPolicy, fetchWithRetry, type RetryPolicy } from '../retry';
import type { AIProvider, CompletionRequest, CompletionResult } from '../types';

const DEFAULT_BASE = 'https://api.anthropic.com';

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly supportsGeneration = true;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE,
    private readonly defaultMaxTokens = 4096,
    private readonly retry: RetryPolicy = defaultRetryPolicy(),
  ) {
    if (!apiKey) throw aiUnavailable('AI_PROVIDER=anthropic requires AI_API_KEY to be set');
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const body = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      temperature: request.temperature ?? 0,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const { response, networkError, attempts } = await fetchWithRetry(
      `${this.baseUrl.replace(/\/$/, '')}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      this.retry,
    );

    const tries = attempts > 1 ? ` after ${attempts} attempts` : '';

    if (!response) {
      throw aiUnavailable(`Could not reach the Anthropic API${tries}: ${networkError?.message ?? 'unknown error'}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw aiUnavailable(`Anthropic API error (${response.status})${tries}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = payload.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim();

    return {
      text,
      provider: this.name,
      model: this.model,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
