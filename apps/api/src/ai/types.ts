export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system?: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for raw JSON output where the API supports it. */
  json?: boolean;
  /** Free-form label used for logging / cost attribution. */
  task?: string;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  /** False for the offline provider: callers must degrade to deterministic output. */
  readonly supportsGeneration: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
