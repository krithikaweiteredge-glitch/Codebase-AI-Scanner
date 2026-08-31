export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  githubLogin: string | null;
  githubLinked: boolean;
}

export interface AppConfig {
  aiProvider: string;
  aiModel: string;
  aiGeneration: boolean;
  embeddingProvider: string;
  githubOAuthConfigured: boolean;
  contextTokenBudget: number;
}

export interface Repository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  sizeKb: number | null;
  primaryLanguage: string | null;
  lastAnalyzedAt: string | null;
  createdAt: string;
  ignorePatterns: string[];
  indexedBranch?: string | null;
  indexedAt?: string | null;
  fileCount?: number;
  findingCount?: number;
}

export interface BranchInfo {
  name: string;
  sha: string | null;
  isDefault: boolean;
  indexedSha?: string | null;
  indexedAt?: string | null;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AnalysisRun {
  id: string;
  repositoryId: string;
  branchId: string | null;
  commitSha: string | null;
  kind: string;
  status: RunStatus;
  steps: RunStep[] | null;
  progress: number;
  stats: Record<string, unknown> | null;
  error: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'confirmed' | 'likely' | 'potential';
export type FindingCategory = 'security' | 'bug' | 'performance' | 'duplicate' | 'quality' | 'test';

export interface Finding {
  id: string;
  repositoryId: string;
  fileId: string | null;
  category: FindingCategory;
  ruleId: string | null;
  type: string;
  severity: Severity;
  title: string;
  description: string;
  evidence: string | null;
  recommendation: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  relatedFilePath: string | null;
  relatedStartLine: number | null;
  relatedEndLine: number | null;
  similarity: number | null;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  status: FindingStatus;
  source: 'static' | 'ai' | 'hybrid' | 'sca' | 'sast';
  cwe: string | null;
  falsePositive: boolean;
  resolved: boolean;
  createdAt: string;
}

export interface RepositoryFileSummary {
  id: string;
  path: string;
  name: string;
  language: string | null;
  role: string | null;
  sizeBytes: number;
  lineCount: number;
  isTest: boolean;
  isConfig: boolean;
  hasSecrets: boolean;
  complexity: number;
}

export interface FileSymbol {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  complexity: number;
  parentName: string | null;
}

export interface FileDetail {
  file: {
    id: string;
    path: string;
    name: string;
    language: string | null;
    role: string | null;
    content: string | null;
    lineCount: number;
    sizeBytes: number;
    isTest: boolean;
    isConfig: boolean;
    isGenerated: boolean;
    hasSecrets: boolean;
    complexity: number;
    blobSha: string | null;
  };
  symbols: FileSymbol[];
  imports: { specifier: string; isExternal: boolean; target: { id: string; path: string } | null }[];
  importedBy: { id: string; path: string }[];
  findings: Finding[];
}

export interface Citation {
  filePath: string;
  startLine?: number | null;
  endLine?: number | null;
  symbolName?: string | null;
  note?: string | null;
  valid: boolean;
  reason?: string;
}

export interface ContextSource {
  ref: string;
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolType: string | null;
  language: string | null;
  role: string | null;
  score: number;
  matchedBy: string[];
}

export interface ChatAnswer {
  sessionId: string | null;
  answer: string;
  citations: Citation[];
  invalidCitations: Citation[];
  sources: ContextSource[];
  groundingScore: number;
  answered: boolean;
  followUps: string[];
  retrieval: {
    intent: string;
    terms: string[];
    retrievers: { name: string; hits: number; error?: string }[];
    chunksConsidered: number;
    chunksIncluded: number;
    contextTokens: number;
    redactions: number;
  };
  usage: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number } | null;
  degraded: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[] | null;
  groundingScore: number | null;
  model: string | null;
  provider: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface ScoreFactor {
  label: string;
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

export interface LanguageStat {
  language: string;
  key: string;
  files: number;
  lines: number;
  bytes: number;
  percent: number;
}

export interface DashboardResponse {
  repository: Repository;
  branch: string | null;
  stats: {
    files: number;
    lines: number;
    bytes: number;
    languages: LanguageStat[];
    frameworks: string[];
    routes: number;
    entryPoints: { file: string; line?: number; detail?: string }[];
    testFrameworks: string[];
  };
  findings: Record<string, Record<string, number>>;
  scores: Score[] | null;
  latestRun: AnalysisRun | null;
  recentCommits: { sha: string; message: string; author: string | null; committedAt: string | null }[];
}

export interface SearchResult {
  chunkId: string;
  fileId: string;
  filePath: string;
  language: string | null;
  role: string | null;
  symbolName: string | null;
  symbolType: string | null;
  startLine: number;
  endLine: number;
  score: number;
  matchedBy: string[];
  snippet: string;
}

export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string | null;
  updatedAt: string | null;
  latestReview: { id: string; status: string; verdict: string | null; createdAt: string; postedToGithub: boolean } | null;
}

export interface TestCase {
  name: string;
  kind: 'happy-path' | 'edge-case' | 'error-path' | 'security' | 'regression';
  given: string;
  expected: string;
  priority: 'high' | 'medium' | 'low';
}

export interface TestSuggestion {
  framework: string;
  target: string;
  rationale?: string;
  cases: TestCase[];
  code?: string;
  uncoveredBehaviour?: string[];
  filePath: string;
  startLine: number;
  endLine: number;
  generatedBy: 'ai' | 'deterministic';
  frameworkEvidence: string;
}

export interface DocSection {
  id: string;
  section: string;
  title: string;
  contentMd: string;
  sources: string[] | null;
  updatedAt: string;
}

export interface DependencyGraph {
  nodes: { id: string; path: string; role: string | null; language: string | null; loc: number; fanIn: number; fanOut: number }[];
  edges: { from: string; to: string; specifier: string }[];
  externals: { specifier: string; importers: number }[];
  cycles: string[][];
  hotspots: { path: string; fanIn: number; fanOut: number }[];
}

export interface ArchitectureInsight {
  summary?: string;
  layers?: { name: string; purpose: string; directories: string[]; keyFiles: string[] }[];
  directoryPurposes?: { path: string; purpose: string; responsibilities: string[]; importantFiles: string[] }[];
  flows?: { name: string; steps: { label: string; filePath?: string | null; startLine?: number | null }[] }[];
  risks?: { title: string; detail: string; filePath?: string | null; severity: 'high' | 'medium' | 'low' }[];
  mermaid: string;
  generatedBy: 'ai' | 'deterministic';
  graphSummary: {
    files: number;
    edges: number;
    externalPackages: number;
    cycles: number;
    hotspots: { path: string; fanIn: number; fanOut: number }[];
  };
}
