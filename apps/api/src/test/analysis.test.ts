import { describe, expect, it } from 'vitest';
import { duplicatePairToFinding, findDuplicatePairs } from '../analyzers/duplicates';
import { computeScores } from '../analyzers/scores';
import { deterministicTestPlan, detectTestFramework } from '../analyzers/tests';
import { analyseDiffStatically } from '../analyzers/pullRequestReview';
import { dedupeFindings } from '../analyzers/engine';
import { runStaticRules } from '../analyzers/static/rules';
import { detectNPlusOne, detectUnreachableCode, detectUnusedImports } from '../analyzers/static/structural';
import type { AnalyzableFile } from '../analyzers/types';
import type { StackProfile } from '../indexer/projectMap';

function file(path: string, content: string, overrides: Partial<AnalyzableFile> = {}): AnalyzableFile {
  return {
    id: `id-${path}`,
    path,
    language: path.endsWith('.py') ? 'python' : 'typescript',
    role: 'service',
    content,
    lineCount: content.split('\n').length,
    isTest: false,
    isConfig: false,
    isGenerated: false,
    ...overrides,
  };
}

describe('static security rules', () => {
  it('flags SQL built by interpolation, with the right line', () => {
    const source = ['export async function find(id: string) {', '  return db.query(`SELECT * FROM users WHERE id = ${id}`);', '}'].join('\n');
    const findings = runStaticRules(file('src/repo.ts', source));
    const sqli = findings.find((f) => f.type === 'sql-injection');

    expect(sqli).toBeDefined();
    expect(sqli!.startLine).toBe(2);
    expect(sqli!.severity).toBe('critical');
    expect(sqli!.source).toBe('static');
    expect(sqli!.cwe).toBe('CWE-89');
  });

  it('does not flag parameterised queries', () => {
    const source = 'return db.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);';
    const findings = runStaticRules(file('src/repo.ts', source));
    expect(findings.filter((f) => f.type === 'sql-injection')).toHaveLength(0);
  });

  it('flags jwt.decode used without verification', () => {
    const findings = runStaticRules(file('src/auth.ts', 'const payload = jwt.decode(token);'));
    expect(findings.some((f) => f.ruleId === 'sec.jwt.decode-without-verify')).toBe(true);
  });

  it('flags python shell=True but not a safe subprocess call', () => {
    const unsafe = runStaticRules(file('app/run.py', 'subprocess.run(cmd, shell=True)'));
    expect(unsafe.some((f) => f.type === 'command-injection')).toBe(true);

    const safe = runStaticRules(file('app/run.py', 'subprocess.run(["ls", "-la"])'));
    expect(safe.some((f) => f.type === 'command-injection')).toBe(false);
  });

  it('ignores matches inside comments', () => {
    const findings = runStaticRules(file('src/repo.ts', '// db.query(`SELECT * FROM t WHERE id = ${id}`)'));
    expect(findings.filter((f) => f.type === 'sql-injection')).toHaveLength(0);
  });

  it('skips test files for rules marked skipTests', () => {
    const findings = runStaticRules(file('src/a.test.ts', 'console.log("x");', { isTest: true }));
    expect(findings.some((f) => f.ruleId === 'quality.console-log')).toBe(false);
  });
});

describe('structural detectors', () => {
  it('detects a database call inside a loop as N+1', () => {
    const source = [
      'async function load(orders) {',
      '  for (const order of orders) {',
      '    const user = await prisma.user.findUnique({ where: { id: order.userId } });',
      '    order.user = user;',
      '  }',
      '}',
    ].join('\n');

    const findings = detectNPlusOne(file('src/OrderService.ts', source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe('n-plus-one-query');
    expect(findings[0]!.startLine).toBe(2);
    expect(findings[0]!.status).toBe('likely');
  });

  it('does not flag a loop without data access', () => {
    const source = ['for (const x of xs) {', '  total += x.amount;', '}'].join('\n');
    expect(detectNPlusOne(file('src/sum.ts', source))).toHaveLength(0);
  });

  it('detects unused imports and keeps used ones', () => {
    const source = [
      "import { used, unused } from './helpers';",
      "import path from 'node:path';",
      '',
      'export const run = () => used(path.sep);',
    ].join('\n');

    const findings = detectUnusedImports(file('src/run.ts', source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('unused');
    expect(findings[0]!.status).toBe('confirmed');
  });

  it('detects unreachable statements after return', () => {
    const source = ['function f() {', '  return 1;', '  console.log("never");', '}'].join('\n');
    const findings = detectUnreachableCode(file('src/f.ts', source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.startLine).toBe(3);
  });
});

describe('duplicate detection', () => {
  const bodyA = [
    'function formatUserName(user) {',
    '  if (!user) return "";',
    '  const first = (user.firstName || "").trim();',
    '  const last = (user.lastName || "").trim();',
    '  if (!first && !last) return user.email || "unknown";',
    '  return [first, last].filter(Boolean).join(" ");',
    '}',
    '',
    'const extra = 1;',
    'const more = 2;',
  ].join('\n');

  const bodyB = bodyA.replace('formatUserName', 'buildDisplayName');

  it('finds near-duplicate symbol bodies across files', () => {
    const pairs = findDuplicatePairs([
      {
        filePath: 'src/utils/user.ts',
        symbolName: 'formatUserName',
        symbolType: 'function',
        startLine: 24,
        endLine: 33,
        content: bodyA,
        isTest: false,
      },
      {
        filePath: 'src/helpers/userHelper.ts',
        symbolName: 'buildDisplayName',
        symbolType: 'function',
        startLine: 51,
        endLine: 60,
        content: bodyB,
        isTest: false,
      },
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.similarity).toBeGreaterThan(0.7);

    const finding = duplicatePairToFinding(pairs[0]!);
    expect(finding.category).toBe('duplicate');
    expect(finding.filePath).toBe('src/utils/user.ts');
    expect(finding.relatedFilePath).toBe('src/helpers/userHelper.ts');
    expect(finding.startLine).toBe(24);
    expect(finding.relatedStartLine).toBe(51);
  });

  it('does not pair unrelated functions', () => {
    const other = [
      'function calculateShippingCost(order) {',
      '  const weight = order.items.reduce((sum, item) => sum + item.weight, 0);',
      '  if (weight > 100) return 50;',
      '  if (order.express) return 25;',
      '  return Math.max(5, weight * 0.4);',
      '}',
      'const rateTable = { standard: 1, express: 2 };',
      'const zones = ["eu", "us", "apac"];',
      'export default calculateShippingCost;',
      'const version = 3;',
    ].join('\n');

    const pairs = findDuplicatePairs([
      { filePath: 'a.ts', symbolName: 'formatUserName', symbolType: 'function', startLine: 1, endLine: 10, content: bodyA, isTest: false },
      { filePath: 'b.ts', symbolName: 'calculateShippingCost', symbolType: 'function', startLine: 1, endLine: 10, content: other, isTest: false },
    ]);
    expect(pairs).toHaveLength(0);
  });
});

describe('finding deduplication', () => {
  it('merges an AI finding into a matching static finding as hybrid', () => {
    const merged = dedupeFindings([
      {
        category: 'security',
        type: 'sql-injection',
        severity: 'critical',
        title: 'SQL injection',
        description: 'static',
        filePath: 'src/repo.ts',
        startLine: 12,
        confidence: 0.85,
        confidenceLabel: 'high',
        status: 'likely',
        source: 'static',
      },
      {
        category: 'security',
        type: 'sql-injection',
        severity: 'critical',
        title: 'SQL injection',
        description: 'ai reasoning',
        filePath: 'src/repo.ts',
        startLine: 12,
        confidence: 0.9,
        confidenceLabel: 'high',
        status: 'potential',
        source: 'ai',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('hybrid');
    expect(merged[0]!.confidence).toBe(0.9);
    expect(merged[0]!.description).toContain('AI review agreed');
  });
});

describe('pull request diff analysis', () => {
  it('only reports rules that match lines the diff adds', () => {
    const patch = [
      '@@ -10,6 +10,8 @@ export class UserRepository {',
      '   async findById(id: string) {',
      '-    return this.db.query("SELECT * FROM users WHERE id = $1", [id]);',
      '+    return this.db.query(`SELECT * FROM users WHERE id = ${id}`);',
      '   }',
      ' }',
    ].join('\n');

    const findings = analyseDiffStatically([
      { filename: 'src/UserRepository.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, sha: 'abc', patch },
    ]);

    expect(findings.some((f) => f.type === 'sql-injection')).toBe(true);
    expect(findings[0]!.filePath).toBe('src/UserRepository.ts');
    // The removed line consumes no new-file line, so the added line is 11.
    expect(findings[0]!.startLine).toBe(11);
  });

  it('returns nothing when the patch only removes code', () => {
    const patch = ['@@ -1,3 +1,2 @@', ' const a = 1;', '-eval(userInput);', ' const b = 2;'].join('\n');
    const findings = analyseDiffStatically([
      { filename: 'src/x.ts', status: 'modified', additions: 0, deletions: 1, changes: 1, sha: 'abc', patch },
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe('test suggestions', () => {
  const stack = {
    testFrameworks: [{ name: 'Vitest', evidence: [{ file: 'package.json', detail: 'declared dependency "vitest"' }] }],
  } as unknown as StackProfile;

  it('prefers the framework the repository actually uses', () => {
    expect(detectTestFramework(stack, 'typescript').framework).toBe('Vitest');
  });

  it('falls back to a language default and says so', () => {
    const empty = { testFrameworks: [] } as unknown as StackProfile;
    const result = detectTestFramework(empty, 'python');
    expect(result.framework).toBe('pytest');
    expect(result.evidence).toContain('no test framework found');
  });

  it('derives cases from real branches, throws and catches', () => {
    const code = [
      'async function login(email, password) {',
      '  if (!email) {',
      '    throw new ValidationError("email required");',
      '  }',
      '  try {',
      '    const user = await repo.findByEmail(email);',
      '    return sign(user);',
      '  } catch (error) {',
      '    throw new AuthError("lookup failed");',
      '  }',
      '}',
    ].join('\n');

    const plan = deterministicTestPlan('login', code, 'Vitest', 10);
    const kinds = plan.cases.map((c) => c.kind);
    expect(kinds).toContain('happy-path');
    expect(kinds).toContain('error-path');
    expect(plan.cases.some((c) => c.name.includes('ValidationError'))).toBe(true);
    expect(plan.framework).toBe('Vitest');
  });
});

describe('explainable scores', () => {
  const base = {
    totalFiles: 120,
    totalLines: 20_000,
    codeFiles: 100,
    testFiles: 25,
    findingCounts: { security: {}, bug: {}, performance: {}, duplicate: 0, quality: {} },
    duplicateLines: 0,
    averageComplexity: 4,
    maxComplexity: 18,
    highComplexitySymbols: 0,
    totalSymbols: 400,
    hasTestFramework: true,
    hasCI: true,
    documentedRoutes: 10,
    totalRoutes: 10,
    unprotectedRoutes: 0,
    deadFiles: 0,
    unusedImports: 0,
  };

  it('gives a clean repository high scores', () => {
    const scores = computeScores(base);
    const security = scores.find((s) => s.key === 'security')!;
    expect(security.score).toBe(100);
    expect(scores.find((s) => s.key === 'health')!.grade).toMatch(/[AB]/);
  });

  it('penalises critical security findings and itemises why', () => {
    const scores = computeScores({
      ...base,
      findingCounts: { ...base.findingCounts, security: { critical: 2, high: 5 } },
      unprotectedRoutes: 3,
    });
    const security = scores.find((s) => s.key === 'security')!;

    expect(security.score).toBeLessThan(80);
    expect(security.factors.length).toBeGreaterThanOrEqual(2);
    expect(security.factors.every((factor) => factor.detail.length > 0)).toBe(true);
    expect(security.factors.some((factor) => factor.label.includes('critical'))).toBe(true);
  });

  it('reflects missing tests in testability', () => {
    const scores = computeScores({ ...base, testFiles: 0, hasTestFramework: false, hasCI: false });
    const testability = scores.find((s) => s.key === 'testability')!;
    expect(testability.score).toBeLessThan(40);
    expect(testability.factors.some((f) => f.label.includes('No test framework'))).toBe(true);
  });
});
