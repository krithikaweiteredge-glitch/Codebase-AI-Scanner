import { describe, expect, it } from 'vitest';
import { CORPUS } from '../benchmark/corpus';
import { runBenchmark } from '../benchmark/run';

describe('detection benchmark', () => {
  const report = runBenchmark();

  it('detects every case labelled vulnerable', () => {
    const missed = report.outcomes.filter((o) => o.kind === 'vulnerable' && !o.detected);
    expect(missed.map((m) => `${m.cwe} ${m.id}`)).toEqual([]);
  });

  it('reports nothing on code labelled safe', () => {
    // Precision is what decides whether anyone keeps the tool switched on.
    const spurious = report.outcomes.filter((o) => o.kind === 'safe' && o.detected);
    expect(spurious.map((s) => `${s.id} [${s.firedRules.join(',')}]`)).toEqual([]);
  });

  it('covers a meaningful spread of CWEs', () => {
    expect(report.byCwe.length).toBeGreaterThanOrEqual(12);
    expect(report.totals.vulnerable).toBeGreaterThanOrEqual(15);
    expect(report.totals.safe).toBeGreaterThanOrEqual(8);
  });

  it('documents why each known blind spot is missed', () => {
    // A blind spot without an explanation is just an untested case.
    const undocumented = CORPUS.filter((c) => c.kind === 'known-miss' && !c.note);
    expect(undocumented.map((c) => c.id)).toEqual([]);
  });

  it('keeps the blind spots honest', () => {
    // If one of these starts passing, it is either a real capability gain
    // worth celebrating or a fixture that accidentally matches a pattern -
    // either way it must be looked at, not silently absorbed.
    expect(report.totals.knownMissesDetected).toBe(0);
  });
});
