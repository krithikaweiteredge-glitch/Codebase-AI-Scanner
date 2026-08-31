import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { relativise } from '../analyzers/sast';
import { materialize, safeJoin } from '../analyzers/sast/workspace';
import {
  describeDataflow,
  normalizeCheckId,
  parseSemgrepOutput,
  resultsToFindings,
  type SemgrepOutput,
} from '../analyzers/sast/semgrep';
import type { AnalyzableFile } from '../analyzers/types';

function file(filePath: string, content = 'const x = 1;\n'): AnalyzableFile {
  return {
    id: `id-${filePath}`,
    path: filePath,
    language: 'typescript',
    role: 'service',
    content,
    lineCount: content.split('\n').length,
    isTest: false,
    isConfig: false,
    isGenerated: false,
  };
}

const LIMITS = { maxFiles: 100, maxTotalBytes: 1_000_000, maxFileBytes: 100_000 };

// ---------------------------------------------------------------------------
// Workspace materialisation
// ---------------------------------------------------------------------------

describe('safeJoin', () => {
  const root = path.resolve('/tmp/scan-root');

  it('resolves ordinary repository paths inside the root', () => {
    expect(safeJoin(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
    expect(safeJoin(root, 'a/b/c/d.py')).toBe(path.join(root, 'a', 'b', 'c', 'd.py'));
  });

  it('refuses any path that would escape the root', () => {
    // File paths come from the GitHub API, so they are not trusted input.
    expect(safeJoin(root, '../../../../etc/cron.d/payload')).toBeNull();
    expect(safeJoin(root, 'src/../../outside.ts')).toBeNull();
    expect(safeJoin(root, '/etc/passwd')).toBeNull();
    expect(safeJoin(root, 'C:/Windows/System32/x.dll')).toBeNull();
    expect(safeJoin(root, 'src\\..\\..\\outside.ts')).toBeNull();
    expect(safeJoin(root, 'src/\0evil.ts')).toBeNull();
    expect(safeJoin(root, '')).toBeNull();
  });

  it('does not accept a sibling directory that merely shares the prefix', () => {
    expect(safeJoin('/tmp/scan', '../scan-evil/x.ts')).toBeNull();
  });

  it('allows dots that are not traversal', () => {
    expect(safeJoin(root, 'src/..hidden/file.ts')).not.toBeNull();
    expect(safeJoin(root, 'src/file..ts')).not.toBeNull();
  });
});

describe('materialize', () => {
  it('writes files and cleans up after itself', async () => {
    const workspace = await materialize([file('src/a.ts', 'a'), file('lib/b/c.ts', 'c')], LIMITS);

    try {
      expect(workspace.files.sort()).toEqual(['lib/b/c.ts', 'src/a.ts']);
      expect(await fs.readFile(path.join(workspace.root, 'src', 'a.ts'), 'utf8')).toBe('a');
      expect(await fs.readFile(path.join(workspace.root, 'lib', 'b', 'c.ts'), 'utf8')).toBe('c');
    } finally {
      await workspace.cleanup();
    }

    await expect(fs.stat(workspace.root)).rejects.toThrow();
  });

  it('skips traversal paths instead of writing them', async () => {
    const workspace = await materialize([file('../escaped.ts'), file('src/ok.ts')], LIMITS);

    try {
      expect(workspace.files).toEqual(['src/ok.ts']);
      expect(workspace.skipped).toContainEqual({ path: '../escaped.ts', reason: 'unsafe path' });
    } finally {
      await workspace.cleanup();
    }
  });

  it('honours the file count and size budgets', async () => {
    const workspace = await materialize([file('a.ts'), file('b.ts'), file('c.ts')], { ...LIMITS, maxFiles: 2 });

    try {
      expect(workspace.files).toHaveLength(2);
      expect(workspace.skipped).toContainEqual({ path: 'c.ts', reason: 'file limit reached' });
    } finally {
      await workspace.cleanup();
    }

    const tooBig = await materialize([file('big.ts', 'x'.repeat(500))], { ...LIMITS, maxFileBytes: 100 });
    try {
      expect(tooBig.files).toEqual([]);
      expect(tooBig.skipped[0]?.reason).toBe('file too large');
    } finally {
      await tooBig.cleanup();
    }
  });

  it('is safe to clean up twice', async () => {
    const workspace = await materialize([file('a.ts')], LIMITS);
    await workspace.cleanup();
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });
});

describe('relativise', () => {
  const root = path.resolve('/tmp/scan-root');
  const known = new Set(['src/index.ts']);

  it('maps absolute and relative semgrep paths back to repository paths', () => {
    expect(relativise(path.join(root, 'src', 'index.ts'), root, known)).toBe('src/index.ts');
    expect(relativise('src/index.ts', root, known)).toBe('src/index.ts');
  });

  it('discards anything outside the workspace or not written by us', () => {
    expect(relativise('/etc/passwd', root, known)).toBeNull();
    expect(relativise(path.join(root, 'src', 'other.ts'), root, known)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

const ROOT = path.resolve('/tmp/scan-root');
const KNOWN = new Set(['src/routes/user.ts']);
const toRelative = (reported: string) => relativise(reported, ROOT, KNOWN);

function output(results: SemgrepOutput['results']): SemgrepOutput {
  return { version: '1.90.0', results };
}

describe('resultsToFindings', () => {
  it('maps a security result onto a finding draft', () => {
    const drafts = resultsToFindings(
      output([
        {
          check_id: 'javascript.express.security.audit.express-sqli',
          path: path.join(ROOT, 'src/routes/user.ts'),
          start: { line: 42 },
          end: { line: 44 },
          extra: {
            message: 'Detected SQL statement built from user input.',
            severity: 'ERROR',
            lines: '  db.query(sql)',
            metadata: {
              category: 'security',
              cwe: ["CWE-89: Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')"],
              owasp: ['A03:2021 - Injection'],
              confidence: 'HIGH',
              impact: 'HIGH',
              references: ['https://example.test/sqli'],
            },
          },
        },
      ]),
      toRelative,
    );

    expect(drafts).toHaveLength(1);
    const finding = drafts[0]!;
    expect(finding.category).toBe('security');
    expect(finding.severity).toBe('critical');
    expect(finding.source).toBe('sast');
    expect(finding.status).toBe('confirmed');
    expect(finding.cwe).toBe('CWE-89');
    expect(finding.filePath).toBe('src/routes/user.ts');
    expect(finding.startLine).toBe(42);
    expect(finding.endLine).toBe(44);
    expect(finding.type).toBe('express-sqli');
    expect(finding.ruleId).toContain('semgrep.');
    expect(finding.description).toContain('A03:2021');
  });

  it('separates rule severity from estimated impact', () => {
    const build = (severity: string, impact?: string) =>
      resultsToFindings(
        output([
          {
            check_id: 'r',
            path: 'src/routes/user.ts',
            start: { line: 1 },
            extra: { severity, message: 'm', metadata: { category: 'security', ...(impact ? { impact } : {}) } },
          },
        ]),
        toRelative,
      )[0]!.severity;

    expect(build('ERROR', 'HIGH')).toBe('critical');
    expect(build('ERROR')).toBe('high');
    expect(build('WARNING', 'HIGH')).toBe('high');
    expect(build('WARNING')).toBe('medium');
    expect(build('INFO')).toBe('low');
  });

  it('maps rule categories onto the platform categories', () => {
    const categoryFor = (category?: string, checkId = 'rule.x') =>
      resultsToFindings(
        output([
          {
            check_id: checkId,
            path: 'src/routes/user.ts',
            start: { line: 1 },
            extra: { severity: 'WARNING', message: 'm', metadata: category ? { category } : {} },
          },
        ]),
        toRelative,
      )[0]!.category;

    expect(categoryFor('security')).toBe('security');
    expect(categoryFor('performance')).toBe('performance');
    expect(categoryFor('correctness')).toBe('bug');
    expect(categoryFor('best-practice')).toBe('quality');
    // No category metadata: fall back to the namespaced rule id.
    expect(categoryFor(undefined, 'javascript.lang.security.audit.x')).toBe('security');
  });

  it('does not store the "requires login" placeholder as code', () => {
    // Unauthenticated semgrep substitutes this string for the matched line and
    // the fingerprint; storing it would put nonsense in the snippet column.
    const draft = resultsToFindings(
      output([
        {
          check_id: 'r',
          path: 'src/routes/user.ts',
          start: { line: 5 },
          extra: {
            severity: 'ERROR',
            message: 'm',
            lines: 'requires login',
            fingerprint: 'requires login',
            engine_kind: 'OSS',
          },
        },
      ]),
      toRelative,
    )[0]!;

    expect(draft.snippet).toBeUndefined();
    expect(draft.metadata).toMatchObject({ fingerprint: null, engine: 'OSS' });
    // The placeholder must not leak into the evidence line either.
    expect(draft.evidence).not.toContain('requires login');
    expect(draft.evidence).toBe('src/routes/user.ts:5 matched rule r.');
  });

  it('uses the normalised rule id in the evidence line and the rule id', () => {
    const draft = resultsToFindings(
      output([
        {
          check_id: 'C.Users.komal.scratch.rules.my-rule',
          path: 'src/routes/user.ts',
          start: { line: 3 },
          extra: { severity: 'ERROR', message: 'm' },
        },
      ]),
      toRelative,
      'C:/Users/komal/scratch/rules/sqli.yaml',
    )[0]!;

    expect(draft.evidence).not.toContain('C.Users.komal.scratch');
    expect(draft.ruleId).toBe('semgrep.my-rule');
  });

  it('strips the filesystem prefix semgrep adds to local rule ids', () => {
    // A rule from a local file is named after that file's directory.
    expect(
      normalizeCheckId('C.Users.komal.scratch.fix.express-sqli-taint', 'C:/Users/komal/scratch/fix/rules.yaml'),
    ).toBe('express-sqli-taint');
    expect(normalizeCheckId('srv.rules.my-rule', '/srv/rules/sqli.yaml')).toBe('my-rule');

    // Registry ids are already tidy and must survive untouched.
    expect(normalizeCheckId('javascript.express.security.audit.express-sqli', 'p/default')).toBe(
      'javascript.express.security.audit.express-sqli',
    );
    // A prefix that does not match is left alone rather than guessed at.
    expect(normalizeCheckId('some.other.rule', '/srv/rules/sqli.yaml')).toBe('some.other.rule');
    expect(normalizeCheckId(undefined)).toBe('unknown');
  });

  it('drops results outside the workspace and ones semgrep itself ignored', () => {
    const drafts = resultsToFindings(
      output([
        { check_id: 'a', path: '/etc/passwd', start: { line: 1 }, extra: { severity: 'ERROR', message: 'm' } },
        { check_id: 'b', path: path.join(ROOT, 'src/unknown.ts'), start: { line: 1 }, extra: { severity: 'ERROR', message: 'm' } },
        {
          check_id: 'c',
          path: 'src/routes/user.ts',
          start: { line: 1 },
          extra: { severity: 'ERROR', message: 'm', is_ignored: true },
        },
      ]),
      toRelative,
    );

    expect(drafts).toEqual([]);
  });
});

describe('dataflow traces', () => {
  const taintResult = {
    check_id: 'javascript.express.security.express-open-redirect',
    path: 'src/routes/user.ts',
    start: { line: 30 },
    extra: {
      severity: 'WARNING',
      message: 'Untrusted input reaches a redirect.',
      metadata: { category: 'security', confidence: 'MEDIUM' },
      dataflow_trace: {
        taint_source: [
          'CliLoc',
          [{ path: 'src/routes/user.ts', start: { line: 10 }, end: { line: 10 } }, 'req.query.next'],
        ],
        intermediate_vars: [
          { location: { path: 'src/routes/user.ts', start: { line: 20 } }, content: 'const target = normalise(next)' },
        ],
        taint_sink: [
          'CliLoc',
          [{ path: 'src/routes/user.ts', start: { line: 30 }, end: { line: 30 } }, 'res.redirect(target)'],
        ],
      },
    },
  };

  it('flattens the trace into an ordered source-to-sink path', () => {
    const summary = describeDataflow(taintResult)!;

    expect(summary.steps.map((s) => s.content)).toEqual([
      'req.query.next',
      'const target = normalise(next)',
      'res.redirect(target)',
    ]);
    expect(summary.steps[0]?.location).toBe('src/routes/user.ts:10');
    expect(summary.steps[2]?.location).toBe('src/routes/user.ts:30');
  });

  it('puts the path into the finding and rates it above a syntactic match', () => {
    const withTaint = resultsToFindings(output([taintResult]), toRelative)[0]!;
    const withoutTaint = resultsToFindings(
      output([{ ...taintResult, extra: { ...taintResult.extra, dataflow_trace: undefined } }]),
      toRelative,
    )[0]!;

    // Semgrep proved the value reaches the sink, so it outranks a shape match.
    expect(withTaint.confidence).toBeGreaterThan(withoutTaint.confidence);
    expect(withTaint.description).toContain('req.query.next');
    expect(withTaint.description).toContain('res.redirect(target)');
    expect(withTaint.evidence).toContain('src/routes/user.ts:10');
    expect(withTaint.metadata).toHaveProperty('dataflow');
    expect(withoutTaint.metadata).not.toHaveProperty('dataflow');
  });

  it('returns nothing when there is no trace to describe', () => {
    expect(describeDataflow({ check_id: 'x', extra: { message: 'm' } })).toBeNull();
    expect(describeDataflow({ check_id: 'x', extra: { dataflow_trace: { taint_source: 'malformed' } } })).toBeNull();
  });
});

describe('parseSemgrepOutput', () => {
  it('reads a normal payload and tolerates an empty one', () => {
    expect(parseSemgrepOutput('{"results":[],"errors":[]}')).toEqual({ results: [], errors: [] });
    expect(parseSemgrepOutput('   ')).toEqual({ results: [] });
  });

  it('rejects output that is not JSON', () => {
    expect(() => parseSemgrepOutput('semgrep: command failed')).toThrow(/not valid JSON/);
  });
});
