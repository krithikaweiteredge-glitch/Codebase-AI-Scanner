import { describe, expect, it } from 'vitest';
import { runPolicies } from '../analyzers/policy';
import { evaluatePolicies } from '../analyzers/policy/evaluate';
import { parsePolicy } from '../analyzers/policy/schema';
import type { AnalyzableFile } from '../analyzers/types';

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

function policyFile(yaml: string): AnalyzableFile {
  return file('.codebase-ai/policy.yml', yaml, { language: 'yaml', role: 'config', isConfig: true });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('policy parsing', () => {
  it('reads a YAML policy', () => {
    const { file: parsed, errors } = parsePolicy(
      '.codebase-ai/policy.yml',
      [
        'version: 1',
        'policies:',
        '  - id: admin-auth',
        '    description: Admin routes must use the auth guard',
        '    files: "src/routes/admin/**"',
        '    require: requireAuth',
      ].join('\n'),
    );

    expect(errors).toEqual([]);
    expect(parsed?.policies).toHaveLength(1);
    // A bare string is accepted where a list is allowed, because both read naturally.
    expect(parsed?.policies[0]?.require).toEqual(['requireAuth']);
    expect(parsed?.policies[0]?.severity).toBe('high');
  });

  it('reads a JSON policy', () => {
    const { file: parsed, errors } = parsePolicy(
      'codebase-ai.policy.json',
      JSON.stringify({
        version: 1,
        policies: [{ id: 'no-eval', description: 'No eval', forbid: ['eval('], severity: 'critical' }],
      }),
    );

    expect(errors).toEqual([]);
    expect(parsed?.policies[0]?.severity).toBe('critical');
  });

  it('rejects a rule that asserts nothing', () => {
    const { file: parsed, errors } = parsePolicy(
      '.codebase-ai/policy.yml',
      ['version: 1', 'policies:', '  - id: empty', '    description: Does nothing'].join('\n'),
    );

    expect(parsed).toBeNull();
    expect(errors.join(' ')).toMatch(/must assert at least one/);
  });

  it('reports malformed YAML instead of silently ignoring it', () => {
    const { file: parsed, errors } = parsePolicy('.codebase-ai/policy.yml', 'policies: [unclosed');

    expect(parsed).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('drops a rule with an uncompilable regex but keeps the rest', () => {
    const { file: parsed, errors } = parsePolicy(
      '.codebase-ai/policy.yml',
      [
        'version: 1',
        'policies:',
        '  - id: broken',
        '    description: Bad pattern',
        '    forbidPattern: "([unclosed"',
        '  - id: fine',
        '    description: Good pattern',
        '    forbid: "eval("',
      ].join('\n'),
    );

    expect(parsed?.policies.map((p) => p.id)).toEqual(['fine']);
    expect(errors.join(' ')).toMatch(/invalid pattern/);
  });

  it('bounds pattern length, since patterns come from the scanned repository', () => {
    const { file: parsed } = parsePolicy(
      '.codebase-ai/policy.yml',
      ['version: 1', 'policies:', '  - id: huge', '    description: x', `    forbidPattern: "${'a'.repeat(400)}"`].join('\n'),
    );

    expect(parsed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

describe('policy evaluation', () => {
  const rule = (overrides: Record<string, unknown>) =>
    parsePolicy(
      'p.json',
      JSON.stringify({ version: 1, policies: [{ id: 'r', description: 'd', ...overrides }] }),
    ).file!.policies;

  it('flags a file missing something the policy requires', () => {
    const files = [file('src/routes/admin/users.ts', 'export const handler = () => {};')];

    const { drafts } = evaluatePolicies(rule({ files: 'src/routes/admin/**', require: 'requireAuth' }), files, 'p.json');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.ruleId).toBe('policy.r');
    expect(drafts[0]?.type).toBe('policy-violation');
    expect(drafts[0]?.evidence).toMatch(/does not contain the required/);
  });

  it('stays quiet when the requirement is satisfied', () => {
    const files = [file('src/routes/admin/users.ts', 'app.get("/x", requireAuth, handler);')];

    const { drafts } = evaluatePolicies(rule({ files: 'src/routes/admin/**', require: 'requireAuth' }), files, 'p.json');

    expect(drafts).toEqual([]);
  });

  it('flags a forbidden construct at its exact line', () => {
    const files = [file('src/api/thing.ts', ['const a = 1;', 'const b = 2;', 'db.$queryRawUnsafe(sql);'].join('\n'))];

    const { drafts } = evaluatePolicies(rule({ forbid: '$queryRawUnsafe' }), files, 'p.json');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.startLine).toBe(3);
    expect(drafts[0]?.snippet).toContain('$queryRawUnsafe');
  });

  it('honours exclude, so the data layer can do what the app layer cannot', () => {
    const files = [file('src/db/client.ts', 'db.$queryRawUnsafe(sql);'), file('src/api/thing.ts', 'db.$queryRawUnsafe(sql);')];

    const { drafts } = evaluatePolicies(
      rule({ files: 'src/**', exclude: 'src/db/**', forbid: '$queryRawUnsafe' }),
      files,
      'p.json',
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.filePath).toBe('src/api/thing.ts');
  });

  it('reports a rule whose glob matched nothing', () => {
    const { unmatchedRules } = evaluatePolicies(rule({ files: 'src/typo/**', forbid: 'x' }), [file('src/a.ts', 'x')], 'p.json');

    expect(unmatchedRules).toEqual(['r']);
  });

  it('skips generated files', () => {
    const files = [file('src/gen.ts', 'eval(x);', { isGenerated: true })];

    const { drafts } = evaluatePolicies(rule({ forbid: 'eval(' }), files, 'p.json');

    expect(drafts).toEqual([]);
  });

  it('caps how much one rule can report', () => {
    const many = Array.from({ length: 80 }, (_, i) => file(`src/f${i}.ts`, 'eval(x);'));

    const { drafts } = evaluatePolicies(rule({ forbid: 'eval(' }), many, 'p.json');

    // One misfiring policy must not drown out every other finding.
    expect(drafts.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// The point of the whole feature
// ---------------------------------------------------------------------------

describe('catching an intent-dependent bug', () => {
  it('catches the fail-open signature check that every other detector missed', () => {
    // This is the real bug found by hand in this codebase: verification
    // returned true when no secret was configured, so an unauthenticated
    // request was accepted. No pattern rule can know that is wrong - but the
    // project can declare that it is.
    const files = [
      policyFile(
        [
          'version: 1',
          'policies:',
          '  - id: verifier-fails-closed',
          '    description: Signature verification must never succeed without a configured secret',
          '    severity: critical',
          '    cwe: CWE-347',
          '    files: "**/*webhook*"',
          // [\w.]* rather than \w*, because the guard reads
          // `process.env.WEBHOOK_SECRET` and \w cannot cross a dot.
          '    forbidPattern: "if\\\\s*\\\\(!\\\\s*[\\\\w.]*(SECRET|secret)[\\\\w.]*\\\\s*\\\\)\\\\s*return true"',
          '    remediation: Return false when the secret is absent, so the endpoint fails closed.',
        ].join('\n'),
      ),
      file(
        'src/webhook/verify.ts',
        [
          'export function verifySignature(payload: string, signature?: string) {',
          '  if (!process.env.WEBHOOK_SECRET) return true;',
          '  if (!signature) return false;',
          '  return hmac(payload) === signature;',
          '}',
        ].join('\n'),
      ),
    ];

    const result = runPolicies(files);

    expect(result.policyPath).toBe('.codebase-ai/policy.yml');
    expect(result.rulesEvaluated).toBe(1);
    expect(result.violations).toBe(1);

    const finding = result.drafts[0]!;
    expect(finding.severity).toBe('critical');
    expect(finding.cwe).toBe('CWE-347');
    expect(finding.startLine).toBe(2);
    expect(finding.recommendation).toContain('fails closed');
  });

  it('stays quiet once the same code fails closed', () => {
    const files = [
      policyFile(
        [
          'version: 1',
          'policies:',
          '  - id: verifier-fails-closed',
          '    description: Signature verification must never succeed without a configured secret',
          '    files: "**/*webhook*"',
          // [\w.]* rather than \w*, because the guard reads
          // `process.env.WEBHOOK_SECRET` and \w cannot cross a dot.
          '    forbidPattern: "if\\\\s*\\\\(!\\\\s*[\\\\w.]*(SECRET|secret)[\\\\w.]*\\\\s*\\\\)\\\\s*return true"',
        ].join('\n'),
      ),
      file(
        'src/webhook/verify.ts',
        ['export function verifySignature(payload: string) {', '  if (!process.env.WEBHOOK_SECRET) return false;', '}'].join('\n'),
      ),
    ];

    expect(runPolicies(files).violations).toBe(0);
  });
});

describe('policy discovery', () => {
  it('does nothing when the repository has no policy file', () => {
    const result = runPolicies([file('src/a.ts', 'const a = 1;')]);

    expect(result.policyPath).toBeNull();
    expect(result.drafts).toEqual([]);
  });

  it('reports a broken policy file rather than ignoring it', () => {
    // Silently skipping it would let a project believe it has guardrails
    // that are not actually running.
    const result = runPolicies([policyFile('policies: [unclosed')]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.ruleId).toBe('policy.invalid-configuration');
    expect(result.drafts[0]?.category).toBe('quality');
  });
});

describe('policy authoring mistakes', () => {
  it('reports a rule whose glob matches nothing, since it is silently inert', () => {
    // The commonest way to get a policy wrong: the rule looks present, runs
    // against zero files, and the project believes it is protected.
    const files = [
      policyFile(
        [
          'version: 1',
          'policies:',
          '  - id: typo-in-glob',
          '    description: Admin routes need auth',
          '    files: "src/route/admin/**"',
          '    require: requireAuth',
        ].join('\n'),
      ),
      file('src/routes/admin/users.ts', 'export const handler = () => {};'),
    ];

    const result = runPolicies(files);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.ruleId).toBe('policy.invalid-configuration');
    expect(result.drafts[0]?.description).toContain('matched no files');
  });
});
