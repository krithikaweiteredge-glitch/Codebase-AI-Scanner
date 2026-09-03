import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { relativise } from '../analyzers/sast';
import { runStaticRules } from '../analyzers/static/rules';
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

describe('authentication rules', () => {
  const ids = (content: string) =>
    runStaticRules({ ...file('backend/routes/authRoutes.js', content), language: 'javascript' }).map((d) => d.ruleId);

  it('flags a password compared inside the query', () => {
    // The version that shipped: matching on the password column only works if
    // the stored value is the password itself.
    expect(ids('const user = await User.findOne({ email, password });')).toContain('sec.password.plaintext-lookup');
  });

  it('does not flag a lookup by identifier followed by a hash comparison', () => {
    expect(ids('const user = await User.findOne({ email });')).not.toContain('sec.password.plaintext-lookup');
    expect(ids('const u = await User.findOne({ email, password: await bcrypt.hash(p, 10) });')).not.toContain(
      'sec.password.plaintext-lookup',
    );
  });

  it('flags a request body passed to a model constructor', () => {
    expect(ids('const user = new User(req.body);')).toContain('sec.mass-assignment.constructor');
    expect(ids('const user = new User({ ...req.body });')).toContain('sec.mass-assignment.constructor');
  });

  it('does not flag a constructor given explicit fields', () => {
    expect(ids('const user = new User({ email: req.body.email, name: req.body.name });')).not.toContain(
      'sec.mass-assignment.constructor',
    );
  });

  it('flags cors() called with no options, whose default is every origin', () => {
    expect(ids('app.use(cors());')).toContain('sec.cors.default-open');
  });

  it('does not flag cors given an explicit origin', () => {
    expect(ids('app.use(cors({ origin: ["https://app.example.com"] }));')).not.toContain('sec.cors.default-open');
  });
});

describe('rules derived from scanning public vulnerable applications', () => {
  const ids = (content: string, filePath = 'app/server.js') =>
    runStaticRules({ ...file(filePath, content), language: 'javascript' }).map((d) => d.ruleId);

  it('flags a Mongo $where built by interpolation (OWASP NodeGoat)', () => {
    expect(ids('return { $where: `this.userId == ${userId} && this.stocks > ${threshold}` };')).toContain(
      'sec.nosql-injection.where',
    );
    expect(ids('return { $where: "this.userId == " + userId };')).toContain('sec.nosql-injection.where');
  });

  it('leaves a $where with no input in it alone', () => {
    expect(ids('return { $where: "this.stocks > 0" };')).not.toContain('sec.nosql-injection.where');
  });

  it('flags a signing secret written into the source (appsecco/dvna)', () => {
    expect(ids("app.use(session({ secret: 'keyboard cat' }));")).toContain('sec.secret.hardcoded-literal');
    expect(ids("const jwtSecret = 's3cr3t-value';")).toContain('sec.secret.hardcoded-literal');
  });

  it('does not flag a secret read from configuration or an obvious placeholder', () => {
    expect(ids('app.use(session({ secret: process.env.SESSION_SECRET }));')).not.toContain(
      'sec.secret.hardcoded-literal',
    );
    expect(ids("const jwtSecret = 'your-secret-here';")).not.toContain('sec.secret.hardcoded-literal');
  });

  it('flags a session cookie without Secure or HttpOnly', () => {
    expect(ids('app.use(session({ cookie: { secure: false } }));')).toContain('sec.cookie.insecure-flags');
    expect(ids('res.cookie("sid", id, { httpOnly: false });')).toContain('sec.cookie.insecure-flags');
  });

  it('anchors the cookie finding to the offending line, not a comment above it', () => {
    // The first version matched across lines and started inside "// Init Session",
    // so the runner discarded it as commented out and the bug went unreported.
    const content = ['// Init Session', 'app.use(session({', '  cookie: { secure: false }', '}))'].join('\n');
    const drafts = runStaticRules({ ...file('app/server.js', content), language: 'javascript' });
    const cookie = drafts.find((d) => d.ruleId === 'sec.cookie.insecure-flags');
    expect(cookie?.startLine).toBe(3);
  });

  it('leaves a correctly configured cookie alone', () => {
    expect(ids('app.use(session({ cookie: { secure: true, httpOnly: true } }));')).not.toContain(
      'sec.cookie.insecure-flags',
    );
  });
});

describe('anchoring a multi-line match', () => {
  it('reports on the offending line when the match begins in a comment', () => {
    // The cookie rule matched from the word "Session" in the comment; the
    // runner then discarded the finding because that line was commented out.
    const content = [
      '// Intialize Session',
      'app.use(session({',
      '  resave: true,',
      '  cookie: { secure: false }',
      '}))',
    ].join('\n');
    const drafts = runStaticRules({ ...file('app/server.js', content), language: 'javascript' });
    const cookie = drafts.find((d) => d.ruleId === 'sec.cookie.insecure-flags');
    expect(cookie).toBeDefined();
    expect(cookie?.startLine).toBe(4);
  });

  it('still drops a finding whose every matched line is commented out', () => {
    const content = ['// app.use(session({ cookie: { secure: false } }))'].join('\n');
    const drafts = runStaticRules({ ...file('app/server.js', content), language: 'javascript' });
    expect(drafts.find((d) => d.ruleId === 'sec.cookie.insecure-flags')).toBeUndefined();
  });
});

describe('rules for the languages that had almost none', () => {
  const ids = (content: string, language: string, filePath = 'src/app.' + language) =>
    runStaticRules({ ...file(filePath, content), language }).map((d) => d.ruleId);

  it('flags a Java command built by concatenation (SasanLabs/VulnerableApp)', () => {
    expect(ids('new ProcessBuilder(new String[] {"sh", "-c", "ping -c 2 " + ipAddress});', 'java')).toContain(
      'sec.command-injection.java',
    );
    expect(ids('Runtime.getRuntime().exec("ls " + dir);', 'java')).toContain('sec.command-injection.java');
  });

  it('leaves a Java command of literals alone', () => {
    expect(ids('new ProcessBuilder("ls", "-la");', 'java')).not.toContain('sec.command-injection.java');
  });

  it('flags a Go command with an argument the code does not control', () => {
    // Both forms appear verbatim in Contrast-Security-OSS/go-test-bench.
    expect(ids('cmd = exec.Command("echo", in)', 'go')).toContain('sec.command-injection.go');
    expect(ids('cmd = exec.Command(args[0], args[1:]...)', 'go')).toContain('sec.command-injection.go');
  });

  it('leaves a Go command of literals alone', () => {
    expect(ids('cmd = exec.Command("ls")', 'go')).not.toContain('sec.command-injection.go');
  });

  it('flags an assembled string marked as trusted HTML', () => {
    expect(ids('return template.HTML(strings.Join(out, "\n"))', 'go')).toContain('sec.xss.go-template-html');
  });

  it('leaves literal markup alone, which is what the conversion is for', () => {
    expect(ids('return template.HTML("<b>bold</b>")', 'go')).not.toContain('sec.xss.go-template-html');
  });

  it('flags a bare md5 call, which the qualified pattern never saw', () => {
    // `from hashlib import md5` leaves no `hashlib.` prefix to match on, and the
    // bare form is the one people write. Found in anxolerd/dvpwa.
    expect(ids("return self.pwd_hash == md5(password.encode('utf-8')).hexdigest()", 'python')).toContain(
      'sec.weak-hash.bare-call',
    );
  });

  it('does not flag a modern digest', () => {
    expect(ids('return sha256(data).hexdigest()', 'python')).not.toContain('sec.weak-hash.bare-call');
  });
});
