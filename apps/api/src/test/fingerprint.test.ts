import { describe, expect, it } from 'vitest';
import { applyPriorTriage, assignFingerprints, type TriageState } from '../analyzers/fingerprint';
import { addedLines } from '../analyzers/secretHistory';
import type { AnalysisFindingDraft } from '../analyzers/types';

function draft(overrides: Partial<AnalysisFindingDraft> = {}): AnalysisFindingDraft {
  return {
    category: 'security',
    ruleId: 'sec.sql-injection.template',
    type: 'sql-injection',
    severity: 'critical',
    title: 'SQL query built with string interpolation',
    description: 'd',
    filePath: 'src/repo.ts',
    startLine: 42,
    endLine: 42,
    snippet: '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
    confidence: 0.85,
    confidenceLabel: 'high',
    status: 'confirmed',
    source: 'static',
    ...overrides,
  };
}

function fingerprintOf(d: AnalysisFindingDraft): string {
  assignFingerprints([d]);
  return d.fingerprint!;
}

describe('finding fingerprints', () => {
  it('is stable when the finding moves down the file', () => {
    // The whole point: adding an import above a finding must not orphan it.
    const before = fingerprintOf(draft({ startLine: 42 }));
    const after = fingerprintOf(draft({ startLine: 87 }));

    expect(after).toBe(before);
  });

  it('is stable across reindentation of the matched code', () => {
    const tight = fingerprintOf(draft({ snippet: 'return db.query(`SELECT ${id}`);' }));
    const indented = fingerprintOf(draft({ snippet: '      return   db.query(`SELECT ${id}`);\n' }));

    expect(indented).toBe(tight);
  });

  it('changes when the rule, the file, or the matched code changes', () => {
    const base = fingerprintOf(draft());

    expect(fingerprintOf(draft({ ruleId: 'sec.command-injection' }))).not.toBe(base);
    expect(fingerprintOf(draft({ filePath: 'src/other.ts' }))).not.toBe(base);
    // A renamed variable genuinely is a different match.
    expect(fingerprintOf(draft({ snippet: 'return db.query(`SELECT ${userId}`);' }))).not.toBe(base);
  });

  it('distinguishes repeated matches of one rule in a file', () => {
    const first = draft({ startLine: 10, snippet: 'db.query(x)' });
    const second = draft({ startLine: 20, snippet: 'db.query(x)' });
    assignFingerprints([first, second]);

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('numbers repeated matches by line, not by detector order', () => {
    const low = draft({ startLine: 10, snippet: 'db.query(x)' });
    const high = draft({ startLine: 90, snippet: 'db.query(x)' });

    assignFingerprints([low, high]);
    const forward = [low.fingerprint, high.fingerprint];

    const low2 = draft({ startLine: 10, snippet: 'db.query(x)' });
    const high2 = draft({ startLine: 90, snippet: 'db.query(x)' });
    assignFingerprints([high2, low2]); // reversed input order

    expect([low2.fingerprint, high2.fingerprint]).toEqual(forward);
  });

  it('identifies a dependency finding by package and advisories, not location', () => {
    const sca = (line: number, advisories: string[]) =>
      draft({
        source: 'sca',
        ruleId: 'sca.npm.lodash',
        type: 'vulnerable-dependency',
        filePath: 'package-lock.json',
        startLine: line,
        snippet: undefined,
        metadata: {
          ecosystem: 'npm',
          package: 'lodash',
          advisories: advisories.map((id) => ({ id })),
        },
      });

    // Lockfiles churn constantly; the line a package sits on is meaningless.
    expect(fingerprintOf(sca(1397, ['GHSA-a']))).toBe(fingerprintOf(sca(88, ['GHSA-a'])));
    // A newly published advisory is a new finding, not the dismissed one.
    expect(fingerprintOf(sca(1397, ['GHSA-a', 'GHSA-b']))).not.toBe(fingerprintOf(sca(1397, ['GHSA-a'])));
  });

  it('treats a duplicate pair as one finding whichever side is reported first', () => {
    const forward = draft({
      category: 'duplicate',
      ruleId: 'quality.duplicate-code',
      filePath: 'src/a.ts',
      relatedFilePath: 'src/b.ts',
      snippet: undefined,
    });
    const reversed = draft({
      category: 'duplicate',
      ruleId: 'quality.duplicate-code',
      filePath: 'src/b.ts',
      relatedFilePath: 'src/a.ts',
      snippet: undefined,
    });

    expect(fingerprintOf(forward)).toBe(fingerprintOf(reversed));
  });
});

describe('triage carry-forward', () => {
  it('restores a dismissal across a re-scan', () => {
    // The bug this exists to fix: findings are deleted and rebuilt each run, so
    // without this a dismissed finding reappears on every scan.
    const original = draft();
    assignFingerprints([original]);

    const prior = new Map<string, TriageState>([
      [original.fingerprint!, { falsePositive: true, resolved: false }],
    ]);

    // Same defect, next run, now three lines further down.
    const rediscovered = draft({ startLine: 45 });
    assignFingerprints([rediscovered]);
    const { carried } = applyPriorTriage([rediscovered], prior);

    expect(carried).toBe(1);
    expect(rediscovered.falsePositive).toBe(true);
  });

  it('restores a resolved marking too', () => {
    const finding = draft();
    assignFingerprints([finding]);
    const prior = new Map<string, TriageState>([
      [finding.fingerprint!, { falsePositive: false, resolved: true }],
    ]);

    applyPriorTriage([finding], prior);

    expect(finding.resolved).toBe(true);
    expect(finding.falsePositive).toBe(false);
  });

  it('leaves untouched findings alone', () => {
    const finding = draft();
    assignFingerprints([finding]);

    const { carried } = applyPriorTriage([finding], new Map());

    expect(carried).toBe(0);
    expect(finding.falsePositive).toBeUndefined();
    expect(finding.resolved).toBeUndefined();
  });

  it('does not carry triage onto a genuinely different finding', () => {
    const dismissed = draft({ filePath: 'src/a.ts' });
    assignFingerprints([dismissed]);
    const prior = new Map<string, TriageState>([
      [dismissed.fingerprint!, { falsePositive: true, resolved: false }],
    ]);

    const elsewhere = draft({ filePath: 'src/b.ts' });
    assignFingerprints([elsewhere]);
    const { carried } = applyPriorTriage([elsewhere], prior);

    expect(carried).toBe(0);
    expect(elsewhere.falsePositive).toBeUndefined();
  });
});

describe('git history diffs', () => {
  it('reads only the lines a commit added', () => {
    const patch = [
      '@@ -1,4 +1,5 @@',
      ' const config = {',
      '-  apiKey: process.env.API_KEY,',
      '+  apiKey: "AKIAIOSFODNN7EXAMPLE",',
      '   region: "us-east-1",',
      ' };',
    ].join('\n');

    const added = addedLines(patch);

    expect(added).toContain('AKIAIOSFODNN7EXAMPLE');
    // A removed line is the secret being deleted - counting it would report
    // every removal as a fresh leak.
    expect(added).not.toContain('process.env.API_KEY');
    expect(added).not.toContain('region');
  });

  it('ignores the +++ file header', () => {
    const patch = ['--- a/config.ts', '+++ b/config.ts', '@@ -0,0 +1 @@', '+const x = 1;'].join('\n');

    expect(addedLines(patch)).toBe('const x = 1;');
  });
});
