export interface ScoreFactor {
  label: string;
  /** Points added to (or subtracted from) the 100-point baseline. */
  impact: number;
  detail: string;
}

export interface Score {
  key: string;
  label: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: string;
  factors: ScoreFactor[];
}

export interface ScoreInputs {
  totalFiles: number;
  totalLines: number;
  codeFiles: number;
  testFiles: number;
  findingCounts: {
    security: Record<string, number>;
    bug: Record<string, number>;
    performance: Record<string, number>;
    duplicate: number;
    quality: Record<string, number>;
  };
  duplicateLines: number;
  averageComplexity: number;
  maxComplexity: number;
  highComplexitySymbols: number;
  totalSymbols: number;
  hasTestFramework: boolean;
  hasCI: boolean;
  documentedRoutes: number;
  totalRoutes: number;
  unprotectedRoutes: number;
  deadFiles: number;
  unusedImports: number;
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 22, high: 11, medium: 4, low: 1.2, info: 0.2 };

function grade(score: number): Score['grade'] {
  if (score >= 90) return 'A';
  if (score >= 78) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function weighted(counts: Record<string, number>): number {
  return Object.entries(counts).reduce((sum, [severity, count]) => sum + (SEVERITY_WEIGHT[severity] ?? 1) * count, 0);
}

/**
 * All scores are derived from counted, inspectable inputs and every deduction is
 * itemised in `factors`, so a reader can reconstruct the number by hand.
 */
export function computeScores(input: ScoreInputs): Score[] {
  const kloc = Math.max(input.totalLines / 1000, 0.5);

  // ---- security ----------------------------------------------------------
  const securityFactors: ScoreFactor[] = [];
  const securityPenalty = weighted(input.findingCounts.security) / Math.sqrt(kloc);
  for (const [severity, count] of Object.entries(input.findingCounts.security)) {
    if (!count) continue;
    securityFactors.push({
      label: `${count} ${severity} security finding${count === 1 ? '' : 's'}`,
      impact: -Math.round(((SEVERITY_WEIGHT[severity] ?? 1) * count) / Math.sqrt(kloc)),
      detail: `${SEVERITY_WEIGHT[severity] ?? 1} points each, scaled by repository size (${Math.round(input.totalLines)} lines).`,
    });
  }
  if (input.unprotectedRoutes > 0) {
    securityFactors.push({
      label: `${input.unprotectedRoutes} route(s) without a detected auth guard`,
      impact: -Math.min(12, input.unprotectedRoutes),
      detail: `Out of ${input.totalRoutes} detected endpoints.`,
    });
  }
  const securityScore = clamp(100 - securityPenalty - Math.min(12, input.unprotectedRoutes));

  // ---- code quality ------------------------------------------------------
  const qualityFactors: ScoreFactor[] = [];
  const duplicateRatio = input.totalLines ? input.duplicateLines / input.totalLines : 0;
  const duplicatePenalty = Math.min(25, duplicateRatio * 400);
  if (input.findingCounts.duplicate > 0) {
    qualityFactors.push({
      label: `${input.findingCounts.duplicate} duplicate code pair(s)`,
      impact: -Math.round(duplicatePenalty),
      detail: `${input.duplicateLines} lines involved (${(duplicateRatio * 100).toFixed(1)}% of the codebase).`,
    });
  }
  const qualityIssues = weighted(input.findingCounts.quality) / Math.sqrt(kloc);
  if (qualityIssues > 0) {
    qualityFactors.push({
      label: 'Quality findings (TODOs, debug output, unused code)',
      impact: -Math.round(qualityIssues),
      detail: `${Object.entries(input.findingCounts.quality).map(([s, c]) => `${c} ${s}`).join(', ')}.`,
    });
  }
  if (input.deadFiles > 0) {
    qualityFactors.push({
      label: `${input.deadFiles} file(s) with no incoming imports`,
      impact: -Math.min(10, input.deadFiles),
      detail: 'Potentially dead modules found via the dependency graph.',
    });
  }
  if (input.unusedImports > 0) {
    qualityFactors.push({
      label: `${input.unusedImports} unused import(s)`,
      impact: -Math.min(6, Math.round(input.unusedImports / 4)),
      detail: 'Confirmed by reference counting after removing import statements and comments.',
    });
  }
  const qualityScore = clamp(
    100 - duplicatePenalty - qualityIssues - Math.min(10, input.deadFiles) - Math.min(6, input.unusedImports / 4),
  );

  // ---- complexity --------------------------------------------------------
  const complexityFactors: ScoreFactor[] = [];
  const complexityPenalty = Math.min(45, Math.max(0, (input.averageComplexity - 5) * 6));
  complexityFactors.push({
    label: `Average symbol complexity ${input.averageComplexity.toFixed(1)}`,
    impact: -Math.round(complexityPenalty),
    detail: 'Branch-count approximation across all indexed functions, classes and methods. Under 5 costs nothing.',
  });
  const hotspotRatio = input.totalSymbols ? input.highComplexitySymbols / input.totalSymbols : 0;
  const hotspotPenalty = Math.min(25, hotspotRatio * 150);
  if (input.highComplexitySymbols) {
    complexityFactors.push({
      label: `${input.highComplexitySymbols} symbol(s) above complexity 20`,
      impact: -Math.round(hotspotPenalty),
      detail: `${(hotspotRatio * 100).toFixed(1)}% of ${input.totalSymbols} symbols. Peak complexity is ${input.maxComplexity}.`,
    });
  }
  const complexityScore = clamp(100 - complexityPenalty - hotspotPenalty);

  // ---- testability -------------------------------------------------------
  const testFactors: ScoreFactor[] = [];
  const testRatio = input.codeFiles ? input.testFiles / input.codeFiles : 0;
  const testCoverageProxy = Math.min(45, testRatio * 180);
  testFactors.push({
    label: `${input.testFiles} test files for ${input.codeFiles} source files`,
    impact: Math.round(testCoverageProxy - 45),
    detail: `Ratio ${(testRatio * 100).toFixed(1)}%. A 25% file ratio scores full marks here. This is a structural proxy, not measured coverage.`,
  });
  if (!input.hasTestFramework) {
    testFactors.push({ label: 'No test framework detected', impact: -20, detail: 'No test runner appears in the manifests or imports.' });
  }
  if (!input.hasCI) {
    testFactors.push({ label: 'No CI configuration detected', impact: -8, detail: 'No GitHub Actions / GitLab CI / Jenkins configuration was indexed.' });
  }
  const complexityDrag = Math.min(15, Math.max(0, (input.averageComplexity - 6) * 3));
  if (complexityDrag > 0) {
    testFactors.push({
      label: 'High average complexity makes units harder to test',
      impact: -Math.round(complexityDrag),
      detail: `Average complexity ${input.averageComplexity.toFixed(1)}.`,
    });
  }
  const testabilityScore = clamp(
    55 + testCoverageProxy - (input.hasTestFramework ? 0 : 20) - (input.hasCI ? 0 : 8) - complexityDrag,
  );

  // ---- bugs / reliability -------------------------------------------------
  const reliabilityPenalty = weighted(input.findingCounts.bug) / Math.sqrt(kloc);
  const performancePenalty = weighted(input.findingCounts.performance) / Math.sqrt(kloc);

  const health = clamp(
    securityScore * 0.3 +
      qualityScore * 0.2 +
      complexityScore * 0.15 +
      testabilityScore * 0.2 +
      clamp(100 - reliabilityPenalty) * 0.1 +
      clamp(100 - performancePenalty) * 0.05,
  );

  return [
    {
      key: 'health',
      label: 'Repository health',
      score: health,
      grade: grade(health),
      summary: 'Weighted blend: security 30%, quality 20%, testability 20%, complexity 15%, reliability 10%, performance 5%.',
      factors: [
        { label: 'Security score', impact: Math.round(securityScore * 0.3), detail: `${securityScore} x 30%` },
        { label: 'Code quality score', impact: Math.round(qualityScore * 0.2), detail: `${qualityScore} x 20%` },
        { label: 'Testability score', impact: Math.round(testabilityScore * 0.2), detail: `${testabilityScore} x 20%` },
        { label: 'Complexity score', impact: Math.round(complexityScore * 0.15), detail: `${complexityScore} x 15%` },
        { label: 'Reliability (bug findings)', impact: Math.round(clamp(100 - reliabilityPenalty) * 0.1), detail: `${clamp(100 - reliabilityPenalty)} x 10%` },
        { label: 'Performance findings', impact: Math.round(clamp(100 - performancePenalty) * 0.05), detail: `${clamp(100 - performancePenalty)} x 5%` },
      ],
    },
    {
      key: 'security',
      label: 'Security',
      score: securityScore,
      grade: grade(securityScore),
      summary: 'Starts at 100; severity-weighted findings are subtracted, scaled by the square root of repository size.',
      factors: securityFactors.length ? securityFactors : [{ label: 'No security findings', impact: 0, detail: 'Static rules and AI review produced no security findings.' }],
    },
    {
      key: 'quality',
      label: 'Code quality',
      score: qualityScore,
      grade: grade(qualityScore),
      summary: 'Starts at 100; duplication, leftover debug/TODO markers, dead files and unused imports are subtracted.',
      factors: qualityFactors.length ? qualityFactors : [{ label: 'No quality findings', impact: 0, detail: 'No duplication or dead code detected.' }],
    },
    {
      key: 'complexity',
      label: 'Complexity',
      score: complexityScore,
      grade: grade(complexityScore),
      summary: 'Higher is simpler. Based on average branch complexity per symbol and the share of symbols above complexity 20.',
      factors: complexityFactors,
    },
    {
      key: 'testability',
      label: 'Testability',
      score: testabilityScore,
      grade: grade(testabilityScore),
      summary: 'Structural proxy from the test-to-source file ratio, framework and CI presence, and average complexity. Not measured coverage.',
      factors: testFactors,
    },
  ];
}
