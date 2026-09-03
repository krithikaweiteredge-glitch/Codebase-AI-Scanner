import { describe, expect, it } from 'vitest';
import { applySuppressions } from '../analyzers/suppress';
import type { AnalysisFindingDraft, AnalyzableFile } from '../analyzers/types';

const file = (path: string, content: string): AnalyzableFile =>
  ({
    id: path,
    path,
    language: 'javascript',
    role: 'service',
    content,
    lineCount: content.split('\n').length,
    isTest: false,
    isConfig: false,
    isGenerated: false,
  }) as AnalyzableFile;

const finding = (over: Partial<AnalysisFindingDraft> = {}): AnalysisFindingDraft =>
  ({
    category: 'security',
    ruleId: 'sec.eval',
    type: 'eval',
    severity: 'high',
    title: 'eval',
    description: 'd',
    filePath: 'src/a.js',
    startLine: 2,
    endLine: 2,
    confidence: 0.9,
    source: 'static',
    ...over,
  }) as AnalysisFindingDraft;

describe('inline suppression', () => {
  const withMarker = (line: string) => [file('src/a.js', ['const a = 1;', line, 'const b = 2;'].join('\n'))];

  it('honours a marker on the offending line', () => {
    const { kept, summary } = applySuppressions([finding()], withMarker('eval(x); // codebase-ai-ignore'));
    expect(kept).toHaveLength(0);
    expect(summary.suppressed).toBe(1);
    expect(summary.byRule['sec.eval']).toBe(1);
  });

  it('honours a marker on the line above, for when the line is already long', () => {
    const files = [file('src/a.js', ['// codebase-ai-ignore', 'eval(x);', ''].join('\n'))];
    expect(applySuppressions([finding({ startLine: 2 })], files).kept).toHaveLength(0);
  });

  it('suppresses only the rules named, when any are named', () => {
    const files = withMarker('eval(x); // codebase-ai-ignore: sec.sql-injection.concat');
    expect(applySuppressions([finding()], files).kept).toHaveLength(1);
    expect(applySuppressions([finding({ ruleId: 'sec.sql-injection.concat' })], files).kept).toHaveLength(0);
  });

  it('accepts a prefix, so a family can be silenced together', () => {
    const files = withMarker('eval(x); // codebase-ai-ignore: sec.*');
    expect(applySuppressions([finding()], files).kept).toHaveLength(0);
    expect(applySuppressions([finding({ ruleId: 'bug.empty-catch' })], files).kept).toHaveLength(1);
  });

  it('does not honour another tool-s marker', () => {
    // nosemgrep and eslint-disable belong to other tools; silencing this
    // scanner on them would suppress findings nobody meant to.
    expect(applySuppressions([finding()], withMarker('eval(x); // nosemgrep')).kept).toHaveLength(1);
    expect(applySuppressions([finding()], withMarker('eval(x); // eslint-disable-line')).kept).toHaveLength(1);
  });

  it('leaves a finding alone when the marker is somewhere else entirely', () => {
    const files = [file('src/a.js', ['// codebase-ai-ignore', '', '', 'eval(x);'].join('\n'))];
    expect(applySuppressions([finding({ startLine: 4 })], files).kept).toHaveLength(1);
  });
});

describe('policy suppression', () => {
  const files = [file('benchmark/corpus.ts', 'eval(x);'), file('src/real.ts', 'eval(x);')];
  const drafts = [finding({ filePath: 'benchmark/corpus.ts' }), finding({ filePath: 'src/real.ts' })];

  it('silences a directory of fixtures without silencing real code', () => {
    const { kept } = applySuppressions(drafts, files, [{ files: ['benchmark/**'], reason: 'deliberate fixtures' }]);
    expect(kept.map((d) => d.filePath)).toEqual(['src/real.ts']);
  });

  it('can narrow by rule as well as by path', () => {
    const { kept } = applySuppressions(drafts, files, [{ files: ['benchmark/**'], rules: ['bug.*'] }]);
    expect(kept).toHaveLength(2);
  });

  it('can silence one rule everywhere, with no path given', () => {
    expect(applySuppressions(drafts, files, [{ rules: ['sec.eval'] }]).kept).toHaveLength(0);
  });

  it('ignores an entry that narrows nothing rather than silencing the report', () => {
    expect(applySuppressions(drafts, files, [{} as never]).kept).toHaveLength(2);
  });

  it('reports what it withheld, so a quiet run is distinguishable from a clean one', () => {
    const { summary } = applySuppressions(drafts, files, [{ files: ['benchmark/**'] }]);
    expect(summary).toEqual({ suppressed: 1, byRule: { 'sec.eval': 1 } });
  });
});
