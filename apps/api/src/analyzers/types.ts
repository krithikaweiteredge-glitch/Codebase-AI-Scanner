export type FindingCategory = 'security' | 'bug' | 'performance' | 'duplicate' | 'test' | 'quality';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/**
 * `sca`  - composition analysis: a dependency matched against an advisory database.
 * `sast` - an external dataflow engine (semgrep) traced a value to a sink.
 */
export type FindingSource = 'static' | 'ai' | 'hybrid' | 'sca' | 'sast';
export type FindingStatus = 'confirmed' | 'likely' | 'potential';

export interface AnalysisFindingDraft {
  category: FindingCategory;
  ruleId?: string;
  type: string;
  severity: Severity;
  title: string;
  description: string;
  evidence?: string;
  recommendation?: string;
  filePath: string;
  startLine: number;
  endLine?: number;
  snippet?: string;
  relatedFilePath?: string;
  relatedStartLine?: number;
  relatedEndLine?: number;
  similarity?: number;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  status: FindingStatus;
  source: FindingSource;
  cwe?: string;
  metadata?: Record<string, unknown>;
  /** Stable identity across runs; see analyzers/fingerprint.ts. */
  fingerprint?: string;
  /** Carried forward from a previous run's triage, not set by detectors. */
  falsePositive?: boolean;
  resolved?: boolean;
}

export interface AnalyzableFile {
  id: string;
  path: string;
  language: string;
  role: string;
  content: string;
  lineCount: number;
  isTest: boolean;
  isConfig: boolean;
  isGenerated: boolean;
}

export interface AnalyzerContext {
  repositoryId: string;
  branchId: string;
  repositoryName: string;
  files: AnalyzableFile[];
}
