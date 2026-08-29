import { EMBEDDING_DIMENSIONS, env } from '../env';
import { embeddingFailed } from '../errors';
import { chunkArray } from '../lib/pool';
import { tokenizeForLexical } from '../lib/text';
import type { EmbeddingProvider } from './types';

/**
 * Deterministic lexical embedding used when no embedding API is configured.
 *
 * It is a hashed bag-of-terms (unigrams + adjacent bigrams) projected into the
 * same 1536-dimensional space the remote providers use, then L2-normalised so
 * cosine distance behaves. This is *not* a semantic model - it approximates
 * lexical/identifier overlap - but it keeps the whole retrieval pipeline
 * runnable (and testable) with zero external dependencies.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model = 'hashed-lexical-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Float64Array(this.dimensions);
    const tokens = tokenizeForLexical(text);
    const counts = new Map<string, number>();

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string;
      counts.set(token, (counts.get(token) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const bigram = `${token}~${tokens[i + 1]}`;
        counts.set(bigram, (counts.get(bigram) ?? 0) + 0.5);
      }
    }

    for (const [term, tf] of counts) {
      const h = fnv1a(term);
      const index = h % this.dimensions;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vector[index] = (vector[index] as number) + sign * (1 + Math.log(tf));
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;

    const out = new Array<number>(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) out[i] = (vector[i] as number) / norm;
    return out;
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com',
  ) {
    if (!apiKey) throw embeddingFailed('EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY (or AI_API_KEY)');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    // The API caps request size; batch conservatively.
    for (const batch of chunkArray(texts, 64)) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            input: batch.map((t) => t.slice(0, 20_000)),
            dimensions: EMBEDDING_DIMENSIONS,
          }),
        });
      } catch {
        throw embeddingFailed('Could not reach the embedding API');
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw embeddingFailed(`Embedding API error (${response.status}): ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as { data: { embedding: number[]; index: number }[] };
      const ordered = [...payload.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) out.push(normaliseDimensions(item.embedding));
    }
    return out;
  }
}

/** Zero-pads or truncates to the fixed column width so any model can be swapped in. */
export function normaliseDimensions(vector: number[]): number[] {
  if (vector.length === EMBEDDING_DIMENSIONS) return vector;
  const out = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (let i = 0; i < Math.min(vector.length, EMBEDDING_DIMENSIONS); i++) out[i] = vector[i] as number;
  return out;
}

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  if (env.EMBEDDING_PROVIDER === 'openai') {
    cached = new OpenAIEmbeddingProvider(env.EMBEDDING_MODEL, env.EMBEDDING_API_KEY || env.AI_API_KEY);
  } else {
    cached = new LocalEmbeddingProvider();
  }
  return cached;
}

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  cached = provider;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
