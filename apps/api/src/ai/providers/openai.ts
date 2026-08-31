import { aiUnavailable } from '../../errors';
import { defaultRetryPolicy, fetchWithRetry, type RetryPolicy } from '../retry';
import type { AIProvider, CompletionRequest, CompletionResult } from '../types';

const DEFAULT_BASE = 'https://api.openai.com';

export class OpenAIProvider implements AIProvider {
  readonly name: string;
  readonly supportsGeneration = true;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE,
    private readonly defaultMaxTokens = 4096,
    providerName = 'openai',
    private readonly retry: RetryPolicy = defaultRetryPolicy(),
  ) {
    this.name = providerName;
    if (!apiKey) throw aiUnavailable(`AI_PROVIDER=${this.name} requires AI_API_KEY to be set`);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const messages = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const { response, networkError, attempts } = await fetchWithRetry(
      `${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens ?? this.defaultMaxTokens,
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      },
      this.retry,
    );

    const tries = attempts > 1 ? ` after ${attempts} attempts` : '';

    if (!response) {
      throw aiUnavailable(`Could not reach the ${this.name} API${tries}: ${networkError?.message ?? 'unknown error'}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw aiUnavailable(`${this.name} API error (${response.status})${tries}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: payload.choices[0]?.message?.content?.trim() ?? '',
      provider: this.name,
      model: this.model,
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
