import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDigest, triageFiles, type TriageVerdict } from '../analyzers/triage';
import { selectReviewBatches } from '../analyzers/engine';
import { setAIProvider } from '../ai/provider';
import type { AIProvider, CompletionRequest, CompletionResult } from '../ai/types';
import type { AnalysisFindingDraft, AnalyzableFile } from '../analyzers/types';

function file(path: string, content: string, overrides: Partial<AnalyzableFile> = {}): AnalyzableFile {
  return {
    id: `id-${path}`,
    path,
    language: 'typescript',
    role: 'service',
    content,
    lineCount: content.split('\n').length,
    isTest: false,
    isConfig: false,
    isGenerated: false,
    ...overrides,
  };
}

/** Provider double that returns a canned JSON body and records what it was asked. */
function stubProvider(reply: (request: CompletionRequest) => unknown): { provider: AIProvider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const provider: AIProvider = {
    name: 'stub',
    model: 'stub-mini',
    supportsGeneration: true,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      calls.push(request);
      return {
        text: JSON.stringify(reply(request)),
        provider: 'stub',
        model: 'stub-mini',
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: 5,
      };
    },
  };
  return { provider, calls };
}

const OPTIONS = { repositoryName: 'acme/app', overview: 'overview', batchSize: 40, maxFiles: 1000, maxTokens: 1000 };

afterEach(() => {
  setAIProvider(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

describe('file digests', () => {
  it('picks out the lines that touch a risk surface, with line numbers', () => {
    const digest = buildDigest(
      file(
        'src/routes/user.ts',
        [
          "import express from 'express';",
          'const unrelated = 1 + 1;',
          'const name = req.body.name;',
          'return db.query(`SELECT * FROM users WHERE n = ${name}`);',
        ].join('\n'),
      ),
    );

    expect(digest).toContain('src/routes/user.ts');
    expect(digest).toContain('3: const name = req.body.name;');
    expect(digest).toContain('4: return db.query');
    // Imports and inert arithmetic are noise at this stage.
    expect(digest).not.toContain("import express");
    expect(digest).not.toContain('unrelated');
  });

  it('is far smaller than the file it describes', () => {
    const big = file('src/big.ts', Array.from({ length: 800 }, (_, i) => `const value${i} = compute(${i});`).join('\n'));

    // The whole point: full coverage is only affordable because digests are cheap.
    expect(buildDigest(big).length).toBeLessThan(big.content.length / 10);
  });

  it('still describes a file with no risky lines', () => {
    const digest = buildDigest(file('src/theme.ts', 'export const spacing = 4;\nexport const radius = 8;'));

    expect(digest).toContain('src/theme.ts');
    expect(digest).toContain('spacing');
  });

  it('records language, role and size so the model can judge context', () => {
    const digest = buildDigest(file('src/a.py', 'x = 1', { language: 'python', role: 'controller', isTest: true }));

    expect(digest).toContain('python');
    expect(digest).toContain('controller');
    expect(digest).toContain('test');
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('triageFiles', () => {
  const files = [
    file('src/routes/user.ts', 'const id = req.query.id;\ndb.query(`SELECT ${id}`);'),
    file('src/theme.ts', 'export const spacing = 4;'),
  ];

  it('scores every file it is given', async () => {
    const { provider } = stubProvider(() => ({
      files: [
        { path: 'src/routes/user.ts', risk: 0.9, categories: ['security'], reason: 'interpolates a request value into SQL' },
        { path: 'src/theme.ts', risk: 0.05, categories: [], reason: 'static styling constants' },
      ],
    }));
    setAIProvider(provider);

    const result = await triageFiles(files, OPTIONS);

    expect(result.filesTriaged).toBe(2);
    expect(result.verdicts.get('src/routes/user.ts')?.risk).toBe(0.9);
    expect(result.verdicts.get('src/theme.ts')?.risk).toBe(0.05);
  });

  it('batches large repositories rather than sending one huge request', async () => {
    const many = Array.from({ length: 95 }, (_, i) => file(`src/f${i}.ts`, `const q = req.query.a${i};`));
    const { provider, calls } = stubProvider((request) => {
      const paths = [...String(request.messages[0]?.content).matchAll(/^(src\/f\d+\.ts) \[/gm)].map((m) => m[1]);
      return { files: paths.map((p) => ({ path: p, risk: 0.6, categories: ['bug'], reason: 'r' })) };
    });
    setAIProvider(provider);

    const result = await triageFiles(many, { ...OPTIONS, batchSize: 40 });

    expect(calls).toHaveLength(3); // 40 + 40 + 15
    expect(result.filesTriaged).toBe(95);
  });

  it('ignores scores for paths that were not in the batch', async () => {
    const { provider } = stubProvider(() => ({
      files: [
        { path: 'src/theme.ts', risk: 0.1, categories: [], reason: 'r' },
        { path: 'src/hallucinated.ts', risk: 1, categories: ['security'], reason: 'does not exist' },
      ],
    }));
    setAIProvider(provider);

    const result = await triageFiles(files, OPTIONS);

    expect(result.verdicts.has('src/hallucinated.ts')).toBe(false);
  });

  it('skips generated files', async () => {
    const { provider, calls } = stubProvider(() => ({ files: [] }));
    setAIProvider(provider);

    await triageFiles([file('src/gen.ts', 'const q = req.query.a;', { isGenerated: true })], OPTIONS);

    expect(calls).toHaveLength(0);
  });

  it('loses only the failed batch when the model errors', async () => {
    let call = 0;
    const provider: AIProvider = {
      name: 'stub',
      model: 'stub-mini',
      supportsGeneration: true,
      async complete(): Promise<CompletionResult> {
        call++;
        // A throw from the provider propagates straight out of the repair
        // loop, so one throw loses exactly one batch.
        if (call === 1) throw new Error('429 rate limited');
        return {
          text: JSON.stringify({ files: [{ path: 'src/b.ts', risk: 0.7, categories: ['bug'], reason: 'r' }] }),
          provider: 'stub',
          model: 'stub-mini',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    };
    setAIProvider(provider);

    const result = await triageFiles([file('src/a.ts', 'a'), file('src/b.ts', 'b')], { ...OPTIONS, batchSize: 1 });

    // The second batch still lands - a flaky request must not lose the sweep.
    expect(result.verdicts.has('src/b.ts')).toBe(true);
    expect(result.verdicts.has('src/a.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What triage changes about file selection
// ---------------------------------------------------------------------------

describe('review selection with triage', () => {
  /** A file with no findings against it and a role that carries no weight. */
  const overlooked = file('src/lib/helpers.ts', 'export const helper = () => {};', { role: 'unknown' });
  const weighted = file('src/routes/a.ts', 'export const a = 1;', { role: 'route' });
  const files = [weighted, overlooked];

  it('never reaches an unflagged, unweighted file without triage', () => {
    const batches = selectReviewBatches('security', files, []);
    const paths = batches.flatMap((b) => [...b.paths]);

    // This is the blind spot: nothing flagged it and its role scores zero.
    expect(paths).toContain('src/routes/a.ts');
    expect(paths).not.toContain('src/lib/helpers.ts');
  });

  it('reaches it once triage says it is risky', () => {
    const triage = new Map<string, TriageVerdict>([
      ['src/lib/helpers.ts', { risk: 0.9, categories: ['security'], reason: 'builds a shell command' }],
    ]);

    const paths = selectReviewBatches('security', files, [], triage).flatMap((b) => [...b.paths]);

    expect(paths).toContain('src/lib/helpers.ts');
  });

  it('outranks role weighting when it is confident', () => {
    const triage = new Map<string, TriageVerdict>([
      ['src/lib/helpers.ts', { risk: 1, categories: ['security'], reason: 'raw sql' }],
    ]);

    const ordered = selectReviewBatches('security', files, [], triage).flatMap((b) => [...b.paths]);

    // risk 1 * 12 beats the route role's weight of 6.
    expect(ordered[0]).toBe('src/lib/helpers.ts');
  });

  it('does not promote a file for a category triage did not implicate', () => {
    const triage = new Map<string, TriageVerdict>([
      ['src/lib/helpers.ts', { risk: 0.95, categories: ['performance'], reason: 'tight loop' }],
    ]);

    const security = selectReviewBatches('security', files, [], triage).flatMap((b) => [...b.paths]);
    const performance = selectReviewBatches('performance', files, [], triage).flatMap((b) => [...b.paths]);

    expect(security).not.toContain('src/lib/helpers.ts');
    expect(performance).toContain('src/lib/helpers.ts');
  });

  it('still ranks by static findings when triage is absent', () => {
    const finding = {
      category: 'security',
      filePath: 'src/lib/helpers.ts',
      severity: 'critical',
    } as AnalysisFindingDraft;

    const ordered = selectReviewBatches('security', files, [finding]).flatMap((b) => [...b.paths]);

    expect(ordered[0]).toBe('src/lib/helpers.ts');
  });
});
