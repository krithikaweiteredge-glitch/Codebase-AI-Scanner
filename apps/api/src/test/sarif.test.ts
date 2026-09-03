import { describe, expect, it } from 'vitest';
import { toSarif, type SarifFinding } from '../analyzers/sarif';

const finding = (over: Partial<SarifFinding> = {}): SarifFinding => ({
  ruleId: 'sec.sql-injection.php',
  type: 'sql-injection',
  title: 'SQL string built from a PHP variable',
  description: 'A value the caller supplies is concatenated into the statement.',
  severity: 'critical',
  category: 'security',
  filePath: 'app/db.php',
  startLine: 12,
  endLine: 12,
  recommendation: 'Use a prepared statement.',
  cwe: 'CWE-89',
  confidence: 0.9,
  fingerprint: 'abc123',
  source: 'static',
  ...over,
});

describe('SARIF document', () => {
  it('produces a valid 2.1.0 envelope', () => {
    const log = toSarif([finding()]) as never as { version: string; runs: unknown[]; $schema: string };
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.runs).toHaveLength(1);
  });

  it('lists each rule once and points results at it by index', () => {
    // This is what lets a consumer say "3 instances of SQL injection" instead
    // of showing three unrelated rows.
    const log = toSarif([finding(), finding({ startLine: 40 }), finding({ ruleId: 'sec.eval' })]) as never as {
      runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; ruleIndex: number }[] }[];
    };
    const run = log.runs[0]!;
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['sec.sql-injection.php', 'sec.eval']);
    expect(run.results).toHaveLength(3);
    expect(run.results[2]!.ruleIndex).toBe(1);
    expect(run.tool.driver.rules[run.results[0]!.ruleIndex]!.id).toBe(run.results[0]!.ruleId);
  });

  it('collapses five severities onto the three SARIF levels', () => {
    const level = (severity: string) =>
      (toSarif([finding({ severity })]) as never as { runs: { results: { level: string }[] }[] }).runs[0]!.results[0]!
        .level;
    expect(level('critical')).toBe('error');
    expect(level('high')).toBe('error');
    expect(level('medium')).toBe('warning');
    expect(level('low')).toBe('note');
    expect(level('info')).toBe('note');
  });

  it('keeps all five severities in security-severity, which GitHub sorts on', () => {
    const score = (severity: string) =>
      (
        toSarif([finding({ severity })]) as never as {
          runs: { tool: { driver: { rules: { properties: Record<string, string> }[] } } }[];
        }
      ).runs[0]!.tool.driver.rules[0]!.properties['security-severity'];
    expect(score('critical')).toBe('9.5');
    expect(score('high')).toBe('7.5');
    expect(score('low')).toBe('3.0');
  });

  it('carries the CWE as a tag in the form GitHub filters on', () => {
    const log = toSarif([finding()]) as never as {
      runs: { tool: { driver: { rules: { properties: { tags: string[] } }[] } } }[];
    };
    expect(log.runs[0]!.tool.driver.rules[0]!.properties.tags).toContain('external/cwe/cwe-89');
  });

  it('reuses the existing fingerprint, so triage survives a re-run', () => {
    const log = toSarif([finding()]) as never as {
      runs: { results: { partialFingerprints?: Record<string, string> }[] }[];
    };
    expect(log.runs[0]!.results[0]!.partialFingerprints?.codebaseAiFingerprint).toBe('abc123');
  });

  it('omits fingerprints rather than inventing one', () => {
    const log = toSarif([finding({ fingerprint: null })]) as never as {
      runs: { results: { partialFingerprints?: unknown }[] }[];
    };
    expect(log.runs[0]!.results[0]!.partialFingerprints).toBeUndefined();
  });

  it('places a finding with no file at the repository root rather than guessing', () => {
    const log = toSarif([finding({ filePath: null, startLine: null, endLine: null })]) as never as {
      runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[] }[] }[];
    };
    const loc = log.runs[0]!.results[0]!.locations[0]!.physicalLocation;
    expect(loc.artifactLocation.uri).toBe('.');
    expect(loc.region.startLine).toBe(1);
  });

  it('records the commit the findings describe', () => {
    const log = toSarif([finding()], { commitSha: 'deadbeef', repositoryUri: 'https://github.com/a/b' }) as never as {
      runs: { versionControlProvenance: { revisionId: string; repositoryUri: string }[] }[];
    };
    expect(log.runs[0]!.versionControlProvenance[0]).toEqual({
      repositoryUri: 'https://github.com/a/b',
      revisionId: 'deadbeef',
    });
  });

  it('handles an empty report without producing a malformed document', () => {
    const log = toSarif([]) as never as { runs: { results: unknown[]; tool: { driver: { rules: unknown[] } } }[] };
    expect(log.runs[0]!.results).toEqual([]);
    expect(log.runs[0]!.tool.driver.rules).toEqual([]);
  });
});
