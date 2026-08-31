import { describe, expect, it, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { LocalEmbeddingProvider, cosineSimilarity, normaliseDimensions } from '../ai/embeddings';
import { setAIProvider } from '../ai/provider';
import { AIGenerationUnavailable, extractJson, generateStructured } from '../ai/structured';
import type { AIProvider, CompletionRequest, CompletionResult } from '../ai/types';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../lib/crypto';
import { extractCitationsFromText } from '../search/citations';
import { buildCodeContext } from '../search/context';
import type { RetrievedChunk } from '../search/hybrid';
import { understandQuery } from '../search/queryUnderstanding';
import { toVectorLiteral } from '../search/chunkStore';

function chunk(overrides: Partial<RetrievedChunk> & { filePath: string; startLine: number; endLine: number; content: string }): RetrievedChunk {
  return {
    id: `${overrides.filePath}:${overrides.startLine}`,
    fileId: 'file-1',
    language: 'typescript',
    role: 'service',
    symbolName: null,
    symbolType: null,
    score: 1,
    fusedScore: 1,
    matchedBy: ['semantic'],
    ranks: {},
    ...overrides,
  } as RetrievedChunk;
}

describe('query understanding', () => {
  it('expands domain terms without inventing identifiers', () => {
    const understood = understandQuery('Where is authentication handled?');
    expect(understood.intent).toBe('locate');
    expect(understood.terms).toEqual(expect.arrayContaining(['authentication', 'jwt', 'login', 'session']));
    expect(understood.preferredRoles).toEqual(expect.arrayContaining(['auth', 'middleware']));
  });

  it('classifies security and performance questions', () => {
    expect(understandQuery('Find potential security vulnerabilities').intent).toBe('security');
    expect(understandQuery('Why is the orders page slow?').intent).toBe('performance');
    expect(understandQuery('What should I test in the UserService?').intent).toBe('test');
  });

  it('keeps quoted identifiers as literals', () => {
    const understood = understandQuery('Where is `createOrder` called?');
    expect(understood.literals).toContain('createOrder');
  });
});

describe('local embeddings', () => {
  const provider = new LocalEmbeddingProvider();

  it('is deterministic and correctly sized', async () => {
    const [a, b] = await provider.embed(['function login(user)', 'function login(user)']);
    expect(a).toHaveLength(1536);
    expect(a).toEqual(b);
  });

  it('scores related code above unrelated code', async () => {
    const [query, related, unrelated] = await provider.embed([
      'where is authentication handled login jwt token',
      'export function login(email, password) { return signJwtToken(user); }',
      'export function renderChartAxis(scale, ticks) { return scale.ticks(ticks); }',
    ]);

    expect(cosineSimilarity(query!, related!)).toBeGreaterThan(cosineSimilarity(query!, unrelated!));
  });

  it('fits any vector to the column width and returns it unit length', () => {
    const padded = normaliseDimensions([1, 2, 3]);

    expect(padded).toHaveLength(1536);
    // Direction is preserved; only the scale changes.
    expect(padded[1]! / padded[0]!).toBeCloseTo(2, 10);
    expect(padded[2]! / padded[0]!).toBeCloseTo(3, 10);
    expect(padded.slice(3).every((v) => v === 0)).toBe(true);

    // Every stored vector must be on the same scale. Providers disagree:
    // gemini-embedding-001 returns a unit vector at its native 3072 dimensions
    // but an unnormalised one at any smaller output_dimensionality, and
    // truncation destroys the norm regardless. Mixed magnitudes in one column
    // skew every comparison made against it.
    const magnitude = Math.sqrt(padded.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('truncates an over-long vector and re-normalises it', () => {
    const long = new Array(3072).fill(0).map((_, i) => (i < 1536 ? 0.02 : 0.9));

    const fitted = normaliseDimensions(long);

    expect(fitted).toHaveLength(1536);
    expect(Math.sqrt(fitted.reduce((sum, v) => sum + v * v, 0))).toBeCloseTo(1, 10);
  });

  it('leaves an all-zero vector alone rather than dividing by zero', () => {
    const zeros = normaliseDimensions(new Array(10).fill(0));

    expect(zeros).toHaveLength(1536);
    expect(zeros.every((v) => v === 0)).toBe(true);
  });

  it('formats pgvector literals and rejects wrong dimensions', () => {
    const literal = toVectorLiteral(new Array(1536).fill(0.5));
    expect(literal.startsWith('[0.500000,')).toBe(true);
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/1536 dimensions/);
  });
});

describe('context builder', () => {
  it('renders true line numbers and merges overlapping ranges', () => {
    const context = buildCodeContext(
      [
        chunk({ filePath: 'src/a.ts', startLine: 10, endLine: 12, content: 'const a = 1;\nconst b = 2;\nconst c = 3;' }),
        chunk({ filePath: 'src/a.ts', startLine: 12, endLine: 14, content: 'const c = 3;\nconst d = 4;\nconst e = 5;' }),
      ],
      5000,
    );

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]).toMatchObject({ filePath: 'src/a.ts', startLine: 10, endLine: 14 });
    expect(context.text).toContain('   10 | const a = 1;');
    expect(context.text).toContain('   14 | const e = 5;');
  });

  it('redacts secrets before they can reach a provider', () => {
    const context = buildCodeContext(
      [chunk({ filePath: 'src/config.ts', startLine: 1, endLine: 1, content: 'const k = "AKIAIOSFODNN7EXAMPLE";' })],
      5000,
    );
    expect(context.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(context.text).toContain('[REDACTED_SECRET]');
    expect(context.redactions).toBeGreaterThan(0);
  });

  it('respects the token budget and reports what it dropped', () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const context = buildCodeContext(
      [
        chunk({ filePath: 'src/a.ts', startLine: 1, endLine: 200, content: big }),
        chunk({ filePath: 'src/b.ts', startLine: 1, endLine: 200, content: big }),
        chunk({ filePath: 'src/c.ts', startLine: 1, endLine: 200, content: big }),
      ],
      600,
    );

    expect(context.chunksIncluded).toBeLessThan(3);
    expect(context.chunksDropped).toBeGreaterThan(0);
    expect(context.tokensUsed).toBeLessThanOrEqual(600);
  });
});

describe('citation extraction', () => {
  it('pulls file references with single lines and ranges out of prose', () => {
    const citations = extractCitationsFromText(
      'Authentication starts in src/auth/AuthService.ts:42 and the guard is src/middleware/auth.ts:10-45.',
    );
    expect(citations).toEqual([
      { filePath: 'src/auth/AuthService.ts', startLine: 42, endLine: 42 },
      { filePath: 'src/middleware/auth.ts', startLine: 10, endLine: 45 },
    ]);
  });

  it('ignores version numbers and prose abbreviations', () => {
    const citations = extractCitationsFromText('We use express 4.18.2, e.g. for routing.');
    expect(citations.map((c) => c.filePath)).not.toContain('4.18.2');
  });
});

describe('structured AI output handling', () => {
  afterEach(() => setAIProvider(null));

  class ScriptedProvider implements AIProvider {
    readonly name = 'scripted';
    readonly model = 'test';
    readonly supportsGeneration = true;
    calls = 0;
    constructor(private readonly responses: string[]) {}
    async complete(_request: CompletionRequest): Promise<CompletionResult> {
      const text = this.responses[Math.min(this.calls, this.responses.length - 1)] ?? '';
      this.calls++;
      return { text, provider: this.name, model: this.model, inputTokens: 10, outputTokens: 5, latencyMs: 1 };
    }
  }

  const schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });

  it('extracts JSON from fenced and prose-wrapped responses', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Here you go: {"a": 1} - hope that helps')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('no json here').ok).toBe(false);
  });

  it('repairs an invalid first response and validates the retry', async () => {
    const provider = new ScriptedProvider([
      '{"answer": "hi", "score": 5}',
      '{"answer": "hi", "score": 0.5}',
    ]);
    setAIProvider(provider);

    const result = await generateStructured({ system: 's', user: 'u', schema, task: 'test' });
    expect(result.data).toEqual({ answer: 'hi', score: 0.5 });
    expect(result.attempts).toBe(2);
    expect(provider.calls).toBe(2);
  });

  it('throws a typed error rather than returning unvalidated output', async () => {
    setAIProvider(new ScriptedProvider(['not json at all']));
    await expect(generateStructured({ system: 's', user: 'u', schema, task: 'test', repairAttempts: 1 })).rejects.toThrow(
      /could not be validated/,
    );
  });

  it('signals unavailability for the offline provider instead of fabricating', async () => {
    setAIProvider(null); // falls back to env AI_PROVIDER=local
    await expect(generateStructured({ system: 's', user: 'u', schema, task: 'test' })).rejects.toBeInstanceOf(
      AIGenerationUnavailable,
    );
  });
});

describe('credential handling', () => {
  it('round-trips encrypted tokens and produces different ciphertexts', () => {
    const token = 'ghp_exampletoken1234567890';
    const a = encryptSecret(token);
    const b = encryptSecret(token);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(token);
    expect(a.startsWith('v1.')).toBe(true);
  });

  it('rejects tampered ciphertext', () => {
    const payload = encryptSecret('secret-value');
    const parts = payload.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from('nonsense').toString('base64')}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('hashes and verifies passwords', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('wrong password', hash)).toBe(false);
  });
});

describe('chunk insert SQL', () => {
  it('binds a chunk with no vector without breaking the batch', async () => {
    // Regression: placeholders were numbered from a fixed 12-slot stride, so a
    // null embedding emitted a literal NULL, skipped its placeholder, and still
    // pushed the value - leaving a parameter the query never referenced.
    // Postgres rejects that (42P18) and the whole batch of 40 chunks was lost.
    const captured: { sql: string; params: unknown[] } = { sql: '', params: [] };

    const { insertChunks } = await import('../search/chunkStore');
    const { prisma } = await import('../db');
    const spy = vi.spyOn(prisma, '$executeRawUnsafe').mockImplementation(
      (async (sql: string, ...params: unknown[]) => {
        captured.sql = sql;
        captured.params = params;
        return 2;
      }) as never,
    );

    const base = {
      repositoryId: '11111111-1111-4111-8111-111111111111',
      fileId: '22222222-2222-4222-8222-222222222222',
      symbolName: 's',
      symbolType: 'function',
      startLine: 1,
      endLine: 2,
      content: 'x',
      tokenCount: 1,
      contentHash: 'h',
    };

    await insertChunks([
      { ...base, embedding: new Array(1536).fill(0.1), embeddingModel: 'm' },
      { ...base, embedding: null, embeddingModel: null },
    ]);

    // Every placeholder the SQL references must exist in the params array,
    // and every param must be referenced.
    const referenced = new Set([...captured.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(Math.max(...referenced)).toBe(captured.params.length);
    for (let i = 1; i <= captured.params.length; i++) {
      expect(referenced.has(i)).toBe(true);
    }
    expect(captured.sql).toContain('NULL');

    spy.mockRestore();
  });
});
