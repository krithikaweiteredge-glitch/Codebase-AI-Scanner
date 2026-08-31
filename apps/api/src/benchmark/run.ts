/**
 * Measures detection against the labelled corpus.
 *
 * Runs only the deterministic detectors - static rules, structural checks and
 * secret scanning - so the result is reproducible, offline, and fast enough for
 * CI. AI review is excluded deliberately: it is non-deterministic, and a
 * benchmark that moves on its own tells you nothing about a change you made.
 *
 * Reported per CWE:
 *   recall     of the vulnerable cases, how many were reported
 *   precision  of everything reported, how much was actually vulnerable
 *
 * Known-miss cases are scored separately. They do not count against recall,
 * because they are documented blind spots rather than regressions - but a
 * *detection* on one is a genuine improvement worth noticing.
 */

import { detectSecrets } from '../indexer/secrets';
import { runStaticRules } from '../analyzers/static/rules';
import { detectNPlusOne, detectUnreachableCode } from '../analyzers/static/structural';
import type { AnalysisFindingDraft, AnalyzableFile } from '../analyzers/types';
import { CORPUS, type BenchmarkCase, type CaseKind } from './corpus';

export interface CaseOutcome {
  id: string;
  cwe: string;
  kind: CaseKind;
  detected: boolean;
  /** Rule ids that fired, for debugging a miss or a spurious hit. */
  firedRules: string[];
  note?: string;
}

export interface CweScore {
  cwe: string;
  vulnerable: number;
  detected: number;
  safe: number;
  falsePositives: number;
  recall: number;
  precision: number;
}

export interface BenchmarkReport {
  outcomes: CaseOutcome[];
  byCwe: CweScore[];
  totals: {
    vulnerable: number;
    detected: number;
    safe: number;
    falsePositives: number;
    knownMisses: number;
    knownMissesDetected: number;
    recall: number;
    precision: number;
  };
}

function toFile(entry: BenchmarkCase): AnalyzableFile {
  return {
    id: entry.id,
    path: entry.path,
    language: entry.language,
    role: 'service',
    content: entry.code,
    lineCount: entry.code.split('\n').length,
    isTest: false,
    isConfig: false,
    isGenerated: false,
  };
}

/** Every deterministic detector that operates on a single file. */
function detect(entry: BenchmarkCase): AnalysisFindingDraft[] {
  const file = toFile(entry);
  const findings: AnalysisFindingDraft[] = [
    ...runStaticRules(file),
    ...detectNPlusOne(file),
    ...detectUnreachableCode(file),
  ];

  for (const secret of detectSecrets(file.content)) {
    findings.push({
      category: 'security',
      ruleId: secret.ruleId,
      type: 'hardcoded-secret',
      severity: secret.severity,
      title: secret.label,
      description: '',
      filePath: file.path,
      startLine: secret.line,
      confidence: secret.confidence,
      confidenceLabel: 'high',
      status: 'confirmed',
      source: 'static',
      cwe: 'CWE-798',
    });
  }

  return findings;
}

export function runBenchmark(corpus: readonly BenchmarkCase[] = CORPUS): BenchmarkReport {
  const outcomes: CaseOutcome[] = corpus.map((entry) => {
    const findings = detect(entry);
    // A "detection" means a security finding on this file at all. Matching the
    // exact CWE would be stricter, but rule authors legitimately tag the same
    // defect differently, and the question here is whether the bug was caught.
    const security = findings.filter((f) => f.category === 'security');

    return {
      id: entry.id,
      cwe: entry.cwe,
      kind: entry.kind,
      detected: security.length > 0,
      firedRules: security.map((f) => f.ruleId ?? f.type),
      ...(entry.note ? { note: entry.note } : {}),
    };
  });

  const cwes = [...new Set(corpus.filter((c) => c.kind !== 'known-miss').map((c) => c.cwe))].sort();

  const byCwe: CweScore[] = cwes.map((cwe) => {
    const vulnerable = outcomes.filter((o) => o.cwe === cwe && o.kind === 'vulnerable');
    const safe = outcomes.filter((o) => o.cwe === cwe && o.kind === 'safe');
    const detected = vulnerable.filter((o) => o.detected).length;
    const falsePositives = safe.filter((o) => o.detected).length;

    return {
      cwe,
      vulnerable: vulnerable.length,
      detected,
      safe: safe.length,
      falsePositives,
      recall: vulnerable.length ? detected / vulnerable.length : 1,
      precision: detected + falsePositives ? detected / (detected + falsePositives) : 1,
    };
  });

  const vulnerable = outcomes.filter((o) => o.kind === 'vulnerable');
  const safe = outcomes.filter((o) => o.kind === 'safe');
  const knownMiss = outcomes.filter((o) => o.kind === 'known-miss');
  const detected = vulnerable.filter((o) => o.detected).length;
  const falsePositives = safe.filter((o) => o.detected).length;

  return {
    outcomes,
    byCwe,
    totals: {
      vulnerable: vulnerable.length,
      detected,
      safe: safe.length,
      falsePositives,
      knownMisses: knownMiss.length,
      knownMissesDetected: knownMiss.filter((o) => o.detected).length,
      recall: vulnerable.length ? detected / vulnerable.length : 1,
      precision: detected + falsePositives ? detected / (detected + falsePositives) : 1,
    },
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push('DETECTION BENCHMARK (deterministic detectors only)');
  lines.push('');
  lines.push('CWE          vuln  found  recall   safe  false-pos  precision');
  lines.push('-----------  ----  -----  ------   ----  ---------  ---------');

  for (const row of report.byCwe) {
    lines.push(
      [
        row.cwe.padEnd(11),
        String(row.vulnerable).padStart(4),
        String(row.detected).padStart(6),
        pct(row.recall).padStart(7),
        String(row.safe).padStart(6),
        String(row.falsePositives).padStart(10),
        pct(row.precision).padStart(10),
      ].join(' '),
    );
  }

  lines.push('');
  lines.push(`RECALL     ${totals.detected}/${totals.vulnerable} vulnerable cases detected  (${pct(totals.recall)})`);
  lines.push(`PRECISION  ${totals.falsePositives} false positive(s) on ${totals.safe} safe cases  (${pct(totals.precision)})`);

  const misses = report.outcomes.filter((o) => o.kind === 'vulnerable' && !o.detected);
  if (misses.length) {
    lines.push('');
    lines.push('MISSED (should be detected):');
    for (const miss of misses) lines.push(`  ${miss.cwe.padEnd(10)} ${miss.id}`);
  }

  const spurious = report.outcomes.filter((o) => o.kind === 'safe' && o.detected);
  if (spurious.length) {
    lines.push('');
    lines.push('FALSE POSITIVES (safe code reported):');
    for (const fp of spurious) lines.push(`  ${fp.cwe.padEnd(10)} ${fp.id}  [${fp.firedRules.join(', ')}]`);
  }

  lines.push('');
  lines.push(
    `KNOWN BLIND SPOTS  ${totals.knownMissesDetected}/${totals.knownMisses} detected ` +
      '(not counted above - these need dataflow or intent)',
  );
  for (const miss of report.outcomes.filter((o) => o.kind === 'known-miss')) {
    lines.push(`  ${miss.detected ? '[now caught]' : '[still missed]'} ${miss.cwe.padEnd(10)} ${miss.id}`);
    if (miss.note) lines.push(`      ${miss.note}`);
  }

  return lines.join('\n');
}
