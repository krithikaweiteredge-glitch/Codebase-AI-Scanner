import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { githubClientForRepository } from '../github/service';
import { env } from '../env';
import type { StackProfile } from '../indexer/projectMap';
import type { RunProgress } from '../indexer/progress';
import { detectSecrets } from '../indexer/secrets';
import { buildBugPrompt, BUG_SYSTEM_PROMPT, bugFindingsSchema } from '../prompts/bugDetection';
import { buildPerformancePrompt, PERFORMANCE_SYSTEM_PROMPT, performanceFindingsSchema } from '../prompts/performance';
import { buildSecurityPrompt, SECURITY_SYSTEM_PROMPT, securityFindingsSchema } from '../prompts/security';
import { confidenceLabel, findingStatus, type AIFinding } from '../prompts/shared';
import { filterGroundedFindings } from '../search/citations';
import { buildCodeContext, buildRepositoryOverview } from '../search/context';
import type { RetrievedChunk } from '../search/hybrid';
import { findDuplicatePairs, duplicatePairToFinding, type DuplicateCandidateUnit } from './duplicates';
import { applyPriorTriage, assignFingerprints, type TriageState } from './fingerprint';
import { runPolicies } from './policy';
import { scanSecretHistory } from './secretHistory';
import { triageFiles, type TriageVerdict } from './triage';
import { computeScores, type Score } from './scores';
import { runSastScan, SemgrepUnavailable } from './sast';
import { MAX_ADVISORY_FETCHES, scanDependencies } from './sca';
import { runStaticRules } from './static/rules';
import {
  detectDeadFiles,
  detectMissingRateLimit,
  detectNPlusOne,
  detectUnprotectedRoutes,
  detectUnreachableCode,
  detectUnusedImports,
} from './static/structural';
import type { AnalysisFindingDraft, AnalyzableFile } from './types';

export interface AnalysisContext {
  repositoryId: string;
  branchId: string;
  runId: string;
  repositoryName: string;
  stack: StackProfile;
  /** Owner of the GitHub token used to re-fetch lockfiles, which are not indexed. */
  userId: string;
  owner: string;
  repo: string;
  commitSha: string | null;
  /** Triage from the previous run on this branch, keyed by fingerprint. */
  priorTriage?: ReadonlyMap<string, TriageState>;
}

export interface AnalysisSummary {
  findings: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  aiUsed: boolean;
  aiRejectedFindings: number;
  scores: Score[];
  sca: ScaSummary;
  sast: SastSummary;
  /** How many findings kept a user's earlier false-positive/resolved decision. */
  triageCarriedForward: number;
  aiTriage: AiTriageSummary;
}

export interface AiTriageSummary {
  ran: boolean;
  filesTriaged: number;
  filesSelected: number;
  model: string | null;
  skippedReason?: string;
}

export interface SastSummary {
  ran: boolean;
  version: string | null;
  filesScanned: number;
  findings: number;
  dataflowFindings: number;
  skippedReason?: string;
}

export interface ScaSummary {
  ran: boolean;
  manifests: string[];
  packagesScanned: number;
  vulnerablePackages: number;
  advisories: number;
  skippedReason?: string;
}

export async function analyzeRepository(ctx: AnalysisContext, progress: RunProgress): Promise<AnalysisSummary> {
  await progress.start('static');

  const files = await loadAnalyzableFiles(ctx.branchId);
  const drafts: AnalysisFindingDraft[] = [];

  // ---- deterministic detectors ------------------------------------------
  for (const file of files) {
    drafts.push(...runStaticRules(file));
    drafts.push(...detectNPlusOne(file));
    drafts.push(...detectUnusedImports(file));
    drafts.push(...detectUnreachableCode(file));
    drafts.push(...secretFindings(file));
  }

  // The repository's own declared invariants. Unlike every other detector,
  // these encode what the project says must be true rather than what we think
  // is wrong - which is the only handle available on intent-dependent bugs.
  const policy = runPolicies(files);
  drafts.push(...policy.drafts);

  drafts.push(...detectUnprotectedRoutes(ctx.stack));
  drafts.push(...detectMissingRateLimit(ctx.stack, files));

  const incoming = await incomingImportCounts(ctx.repositoryId, ctx.branchId);
  const entryPoints = new Set(ctx.stack.entryPoints.map((e) => e.file));
  drafts.push(...detectDeadFiles(files, incoming, entryPoints));

  // ---- duplicates --------------------------------------------------------
  const duplicateUnits = await loadDuplicateUnits(ctx.repositoryId, ctx.branchId);
  const pairs = findDuplicatePairs(duplicateUnits);
  const duplicateLines = pairs.reduce((sum, p) => sum + (p.a.endLine - p.a.startLine + 1), 0);
  drafts.push(...pairs.map(duplicatePairToFinding));

  // ---- secrets in git history -------------------------------------------
  // Runs inside the static step: it is the same detectors, applied to commits
  // rather than the working tree.
  const currentSecrets = new Set(
    drafts
      .filter((draft) => draft.type === 'hardcoded-secret' && draft.ruleId)
      .map((draft) => `${draft.ruleId}|${draft.filePath}`),
  );
  const history = await runSecretHistory(ctx, currentSecrets, progress);
  drafts.push(...history);

  await progress.complete(
    'static',
    `${drafts.length} deterministic findings` +
      (policy.policyPath ? ` (${policy.rulesEvaluated} repository policy rule(s) applied)` : ''),
  );

  // ---- dependency vulnerabilities ----------------------------------------
  const sca = await runScaStep(ctx, files, progress);
  drafts.push(...sca.drafts);

  // ---- dataflow analysis -------------------------------------------------
  const sast = await runSastStep(files, progress);
  drafts.push(...sast.drafts);

  // ---- AI review ---------------------------------------------------------
  await progress.start('ai');
  let aiUsed = false;
  let aiRejected = 0;
  let aiTriage: { verdicts: ReadonlyMap<string, TriageVerdict>; summary: AiTriageSummary } = {
    verdicts: new Map(),
    summary: { ran: false, filesTriaged: 0, filesSelected: 0, model: null },
  };

  if (aiEnabled()) {
    const overview = buildRepositoryOverview(ctx.stack, { maxRoutes: 25, maxDirectories: 20 });

    // Stage one: sweep every file cheaply so stage two reads the right ones.
    aiTriage = await runTriageStage(ctx, files, overview, progress);

    for (const category of ['security', 'bug', 'performance'] as const) {
      try {
        const result = await runAiCategory(ctx, category, files, drafts, overview, aiTriage.verdicts);
        drafts.push(...result.findings);
        aiRejected += result.rejected;
        aiUsed = aiUsed || result.findings.length > 0 || result.ran;
      } catch (error) {
        if (error instanceof AIGenerationUnavailable) break;
        await progress.detail('ai', `${category} review failed: ${(error as Error).message}`);
      }
    }
    await progress.complete(
      'ai',
      aiUsed ? `AI review complete (${aiRejected} ungrounded finding(s) discarded)` : 'AI review produced no findings',
    );
  } else {
    await progress.skip('ai', 'AI_PROVIDER=local - deterministic analysis only');
  }

  // ---- persist -----------------------------------------------------------
  const deduped = dedupeFindings(drafts);

  // Identity first, then re-apply whatever the user already decided about
  // these findings on a previous run.
  assignFingerprints(deduped);
  const { carried } = applyPriorTriage(deduped, ctx.priorTriage ?? new Map());

  const stored = await persistFindings(ctx.repositoryId, ctx.runId, ctx.branchId, deduped);

  // ---- scores ------------------------------------------------------------
  await progress.start('scores');
  const symbolStats = await symbolComplexity(ctx.repositoryId, ctx.branchId);
  const counts = countBy(stored);

  const scores = computeScores({
    totalFiles: files.length,
    totalLines: files.reduce((sum, f) => sum + f.lineCount, 0),
    codeFiles: files.filter((f) => !f.isTest && !f.isConfig).length,
    testFiles: files.filter((f) => f.isTest).length,
    findingCounts: {
      security: counts.severityByCategory.security ?? {},
      bug: counts.severityByCategory.bug ?? {},
      performance: counts.severityByCategory.performance ?? {},
      duplicate: counts.byCategory.duplicate ?? 0,
      quality: counts.severityByCategory.quality ?? {},
    },
    duplicateLines,
    averageComplexity: symbolStats.average,
    maxComplexity: symbolStats.max,
    highComplexitySymbols: symbolStats.high,
    totalSymbols: symbolStats.total,
    hasTestFramework: ctx.stack.testFrameworks.length > 0,
    hasCI: ctx.stack.hasCI,
    documentedRoutes: ctx.stack.routes.length,
    totalRoutes: ctx.stack.routes.length,
    unprotectedRoutes: stored.filter((f) => f.ruleId === 'sec.unprotected-route').length,
    deadFiles: stored.filter((f) => f.ruleId === 'quality.dead-file').length,
    unusedImports: stored.filter((f) => f.ruleId === 'quality.unused-import').length,
  });

  await prisma.repositoryInsight.upsert({
    where: { repositoryId_kind: { repositoryId: ctx.repositoryId, kind: 'scores' } },
    create: { repositoryId: ctx.repositoryId, kind: 'scores', data: scores as unknown as Prisma.InputJsonValue },
    update: { data: scores as unknown as Prisma.InputJsonValue },
  });
  await progress.complete('scores', scores.map((s) => `${s.label} ${s.score}`).join(' | '));

  return {
    findings: stored.length,
    byCategory: counts.byCategory,
    bySeverity: counts.bySeverity,
    aiUsed,
    aiRejectedFindings: aiRejected,
    scores,
    sca: sca.summary,
    sast: sast.summary,
    triageCarriedForward: carried,
    aiTriage: aiTriage.summary,
  };
}

// ---------------------------------------------------------------------------
// Dataflow analysis
// ---------------------------------------------------------------------------

/**
 * Semgrep is an optional external binary, so "not installed" is an ordinary
 * outcome rather than an error - the step records why it was skipped and the
 * rest of the analysis is unaffected.
 */
async function runSastStep(
  files: readonly AnalyzableFile[],
  progress: RunProgress,
): Promise<{ drafts: AnalysisFindingDraft[]; summary: SastSummary }> {
  const empty: SastSummary = {
    ran: false,
    version: null,
    filesScanned: 0,
    findings: 0,
    dataflowFindings: 0,
  };

  if (!env.SEMGREP_ENABLED) {
    const reason = 'SEMGREP_ENABLED=false - dataflow analysis is switched off';
    await progress.skip('sast', reason);
    return { drafts: [], summary: { ...empty, skippedReason: reason } };
  }

  await progress.start('sast');

  try {
    const result = await runSastScan(files, {
      binary: env.SEMGREP_PATH,
      config: env.SEMGREP_CONFIG,
      timeoutMs: env.SEMGREP_TIMEOUT_MS,
      ruleTimeoutSeconds: env.SEMGREP_RULE_TIMEOUT_SECONDS,
      jobs: env.SEMGREP_JOBS,
      maxFiles: env.SEMGREP_MAX_FILES,
      maxTotalBytes: env.SEMGREP_MAX_TOTAL_BYTES,
      maxFileBytes: env.MAX_FILE_BYTES,
    });

    await progress.complete(
      'sast',
      `semgrep ${result.version}: ${result.drafts.length} finding(s) across ${result.filesScanned} file(s)` +
        (result.dataflowFindings ? `, ${result.dataflowFindings} with a tracked dataflow path` : ''),
    );

    return {
      drafts: result.drafts,
      summary: {
        ran: true,
        version: result.version,
        filesScanned: result.filesScanned,
        findings: result.drafts.length,
        dataflowFindings: result.dataflowFindings,
      },
    };
  } catch (error) {
    const reason =
      error instanceof SemgrepUnavailable
        ? error.message
        : `Dataflow analysis failed: ${(error as Error).message}`;
    await progress.skip('sast', reason.slice(0, 300));
    return { drafts: [], summary: { ...empty, skippedReason: reason } };
  }
}

// ---------------------------------------------------------------------------
// AI triage (stage one)
// ---------------------------------------------------------------------------

/**
 * Sweeps every file with a cheap model so the expensive review reads the right
 * ones. Best-effort: if it is disabled or fails, stage two falls back to
 * ranking by static findings and directory role, exactly as before.
 */
async function runTriageStage(
  ctx: AnalysisContext,
  files: readonly AnalyzableFile[],
  overview: string,
  progress: RunProgress,
): Promise<{ verdicts: ReadonlyMap<string, TriageVerdict>; summary: AiTriageSummary }> {
  const empty: AiTriageSummary = { ran: false, filesTriaged: 0, filesSelected: 0, model: null };

  if (!env.AI_TRIAGE_ENABLED) {
    return { verdicts: new Map(), summary: { ...empty, skippedReason: 'AI_TRIAGE_ENABLED=false' } };
  }

  try {
    const result = await triageFiles(files, {
      repositoryName: ctx.repositoryName,
      overview,
      batchSize: env.AI_TRIAGE_BATCH_FILES,
      maxFiles: env.AI_TRIAGE_MAX_FILES,
      maxTokens: env.AI_MAX_OUTPUT_TOKENS,
    });

    const selected = [...result.verdicts.values()].filter((v) => v.risk >= 0.5).length;
    await progress.detail(
      'ai',
      `triage swept ${result.filesTriaged} file(s) in ${result.batches} batch(es); ${selected} above the review threshold`,
    );

    return {
      verdicts: result.verdicts,
      summary: {
        ran: result.filesTriaged > 0,
        filesTriaged: result.filesTriaged,
        filesSelected: selected,
        model: env.AI_TRIAGE_MODEL || env.AI_MODEL,
      },
    };
  } catch (error) {
    // Includes AIGenerationUnavailable: the deep review will report that too.
    const reason = `Triage unavailable: ${(error as Error).message}`;
    return { verdicts: new Map(), summary: { ...empty, skippedReason: reason.slice(0, 300) } };
  }
}

// ---------------------------------------------------------------------------
// Secrets in git history
// ---------------------------------------------------------------------------

/**
 * Best-effort, like the other network-dependent steps: no GitHub access means
 * the current-tree secret scan still stands on its own.
 */
async function runSecretHistory(
  ctx: AnalysisContext,
  currentSecrets: ReadonlySet<string>,
  progress: RunProgress,
): Promise<AnalysisFindingDraft[]> {
  if (!env.SECRET_HISTORY_COMMITS || !ctx.commitSha) return [];

  try {
    const client = await githubClientForRepository(ctx.repositoryId, ctx.userId);
    const result = await scanSecretHistory(
      client,
      {
        owner: ctx.owner,
        repo: ctx.repo,
        commitSha: ctx.commitSha,
        maxCommits: env.SECRET_HISTORY_COMMITS,
      },
      currentSecrets,
    );

    if (result.drafts.length) {
      await progress.detail(
        'static',
        `${result.drafts.length} secret(s) found in ${result.commitsScanned} commit(s) of history`,
      );
    }
    return result.drafts;
  } catch {
    // Rate limited, no token, or a shallow/empty history.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dependency vulnerabilities
// ---------------------------------------------------------------------------

/**
 * Composition analysis is best-effort by design. It reaches two networks that
 * the rest of the engine does not need (GitHub for lockfiles, OSV for
 * advisories), and neither being down is a reason to lose an entire analysis
 * run - the step records why it was skipped and the rest carries on.
 */
/**
 * Package names the indexed code actually imports, taken from the external
 * edges of the dependency graph. Used to tell a reachable advisory from one in
 * a build tool that never runs.
 */
async function importedPackageNames(repositoryId: string): Promise<Set<string>> {
  const rows = await prisma.dependency.findMany({
    where: { repositoryId, isExternal: true },
    select: { specifier: true },
    take: 20000,
  });
  const names = new Set<string>();
  for (const row of rows) {
    const specifier = row.specifier;
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) continue;
    // `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`.
    const parts = specifier.split('/');
    names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
  }
  return names;
}

async function runScaStep(
  ctx: AnalysisContext,
  files: readonly AnalyzableFile[],
  progress: RunProgress,
): Promise<{ drafts: AnalysisFindingDraft[]; summary: ScaSummary }> {
  const empty: ScaSummary = {
    ran: false,
    manifests: [],
    packagesScanned: 0,
    vulnerablePackages: 0,
    advisories: 0,
  };

  if (!env.SCA_ENABLED) {
    const reason = 'SCA_ENABLED=false - dependency scanning is switched off';
    await progress.skip('sca', reason);
    return { drafts: [], summary: { ...empty, skippedReason: reason } };
  }

  await progress.start('sca');

  try {
    const result = await scanDependencies(
      {
        repositoryId: ctx.repositoryId,
        userId: ctx.userId,
        owner: ctx.owner,
        repo: ctx.repo,
        commitSha: ctx.commitSha,
      },
      files,
      {
        baseUrl: env.OSV_API_URL,
        maxDetailFetches: MAX_ADVISORY_FETCHES,
        importedPackages: await importedPackageNames(ctx.repositoryId),
      },
    );

    if (!result.manifests.length) {
      const reason = 'No dependency manifests or lockfiles found';
      await progress.skip('sca', reason);
      return { drafts: [], summary: { ...empty, skippedReason: reason } };
    }

    await progress.complete(
      'sca',
      `${result.packagesScanned} package(s) checked against OSV - ` +
        `${result.vulnerablePackages} vulnerable, ${result.advisories} advisor${result.advisories === 1 ? 'y' : 'ies'}`,
    );

    return {
      drafts: result.drafts,
      summary: {
        ran: true,
        manifests: result.manifests,
        packagesScanned: result.packagesScanned,
        vulnerablePackages: result.vulnerablePackages,
        advisories: result.advisories,
      },
    };
  } catch (error) {
    const reason = `Dependency scan unavailable: ${(error as Error).message}`;
    await progress.skip('sca', reason.slice(0, 300));
    return { drafts: [], summary: { ...empty, skippedReason: reason } };
  }
}

// ---------------------------------------------------------------------------
// AI category review
// ---------------------------------------------------------------------------

async function runAiCategory(
  ctx: AnalysisContext,
  category: 'security' | 'bug' | 'performance',
  files: AnalyzableFile[],
  existing: AnalysisFindingDraft[],
  overview: string,
  triage: ReadonlyMap<string, TriageVerdict>,
): Promise<{ findings: AnalysisFindingDraft[]; rejected: number; ran: boolean }> {
  const batches = selectReviewBatches(category, files, existing, triage, {
    maxFiles: env.AI_MAX_REVIEW_FILES,
    perBatch: env.AI_REVIEW_BATCH_FILES,
  });
  if (!batches.length) return { findings: [], rejected: 0, ran: false };

  const out: AnalysisFindingDraft[] = [];
  let rejected = 0;

  for (const batch of batches.slice(0, env.AI_BATCHES_PER_CATEGORY)) {
    const context = buildCodeContext(batch.chunks, Math.floor(env.CONTEXT_TOKEN_BUDGET * 0.9));
    if (!context.sources.length) continue;

    const staticSummary = existing
      .filter((f) => f.category === category && batch.paths.has(f.filePath))
      .slice(0, 25)
      .map((f) => `- [${f.severity}] ${f.title} (${f.filePath}:${f.startLine}) [${f.ruleId ?? 'rule'}]`)
      .join('\n');

    const prompt =
      category === 'security'
        ? buildSecurityPrompt({ repositoryName: ctx.repositoryName, overview, codeContext: context.text, staticFindings: staticSummary })
        : category === 'bug'
          ? buildBugPrompt({ repositoryName: ctx.repositoryName, overview, codeContext: context.text, staticFindings: staticSummary })
          : buildPerformancePrompt({ repositoryName: ctx.repositoryName, overview, codeContext: context.text, staticFindings: staticSummary });

    const system =
      category === 'security' ? SECURITY_SYSTEM_PROMPT : category === 'bug' ? BUG_SYSTEM_PROMPT : PERFORMANCE_SYSTEM_PROMPT;
    const schema =
      category === 'security' ? securityFindingsSchema : category === 'bug' ? bugFindingsSchema : performanceFindingsSchema;

    const { data } = await generateStructured({
      system,
      user: prompt,
      schema,
      task: `${category}-analysis`,
      maxTokens: env.AI_MAX_OUTPUT_TOKENS,
    });

    const grounded = await filterGroundedFindings(ctx.repositoryId, ctx.branchId, data.findings);
    rejected += grounded.rejected.length;

    for (const finding of grounded.kept) {
      out.push(aiFindingToDraft(finding, category));
    }
  }

  return { findings: out, rejected, ran: true };
}

function aiFindingToDraft(finding: AIFinding & { fileId: string }, category: 'security' | 'bug' | 'performance'): AnalysisFindingDraft {
  return {
    category,
    ruleId: `ai.${category}.${finding.type}`.slice(0, 80),
    type: finding.type,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    filePath: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine ?? finding.startLine,
    confidence: finding.confidence,
    confidenceLabel: confidenceLabel(finding.confidence),
    status: findingStatus('ai', finding.confidence),
    source: 'ai',
    ...(finding.cwe ? { cwe: finding.cwe } : {}),
    metadata: { detector: 'ai', model: env.AI_MODEL, provider: env.AI_PROVIDER },
  };
}

interface ReviewBatch {
  chunks: RetrievedChunk[];
  paths: Set<string>;
}

/**
 * Choose what the model actually looks at. Static analysis and structural role
 * information decide - the model never sees the whole repository.
 */
export function selectReviewBatches(
  category: 'security' | 'bug' | 'performance',
  files: AnalyzableFile[],
  existing: AnalysisFindingDraft[],
  triage?: ReadonlyMap<string, TriageVerdict>,
  limits: { maxFiles?: number; perBatch?: number } = {},
): ReviewBatch[] {
  const riskByPath = new Map<string, number>();

  const bump = (path: string, amount: number) => riskByPath.set(path, (riskByPath.get(path) ?? 0) + amount);

  for (const finding of existing) {
    if (finding.category !== category) continue;
    bump(finding.filePath, finding.severity === 'critical' ? 8 : finding.severity === 'high' ? 5 : 2);
  }

  const ROLE_WEIGHTS: Record<string, Record<string, number>> = {
    security: { route: 6, controller: 6, middleware: 5, auth: 7, repository: 4, service: 3, config: 3, model: 1 },
    bug: { service: 5, controller: 4, repository: 4, util: 3, worker: 3, component: 2, hook: 2 },
    performance: { repository: 6, service: 5, controller: 3, component: 4, worker: 3, hook: 2 },
  };

  for (const file of files) {
    if (file.isTest || file.isGenerated) continue;
    const weight = ROLE_WEIGHTS[category]?.[file.role] ?? 0;
    if (weight) bump(file.path, weight);
    if (file.lineCount > 400) bump(file.path, 1);
  }

  // Stage-one triage read every file, including ones no static rule flagged
  // and no role weighting favours - the blind spot the two heuristics above
  // share. Weighted to dominate them when it is confident, because it is the
  // only signal that actually looked at the contents.
  if (triage) {
    for (const file of files) {
      if (file.isGenerated) continue;
      const verdict = triage.get(file.path);
      if (!verdict) continue;
      const relevant = verdict.categories.length === 0 || verdict.categories.includes(category);
      if (!relevant) continue;
      bump(file.path, verdict.risk * 12);
    }
  }

  const ranked = [...riskByPath.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.maxFiles ?? 45)
    .map(([path]) => path);

  const byPath = new Map(files.map((f) => [f.path, f]));
  const batches: ReviewBatch[] = [];
  const perBatch = limits.perBatch ?? 15;

  for (let i = 0; i < ranked.length; i += perBatch) {
    const slice = ranked.slice(i, i + perBatch);
    const chunks: RetrievedChunk[] = [];
    const paths = new Set<string>();

    for (const path of slice) {
      const file = byPath.get(path);
      if (!file) continue;
      paths.add(path);
      chunks.push(fileAsChunk(file));
    }
    if (chunks.length) batches.push({ chunks, paths });
  }

  return batches;
}

/** Adapt a whole file into the retrieval chunk shape the context builder expects. */
function fileAsChunk(file: AnalyzableFile): RetrievedChunk {
  const MAX_LINES = 400;
  const lines = file.content.split('\n');
  const content = lines.slice(0, MAX_LINES).join('\n');
  return {
    id: `file:${file.id}`,
    fileId: file.id,
    filePath: file.path,
    language: file.language,
    role: file.role,
    symbolName: null,
    symbolType: 'file',
    startLine: 1,
    endLine: Math.min(lines.length, MAX_LINES),
    content,
    score: 1,
    matchedBy: ['selection'],
    fusedScore: 1,
    ranks: {},
  };
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

export async function loadAnalyzableFiles(branchId: string): Promise<AnalyzableFile[]> {
  const rows = await prisma.repositoryFile.findMany({
    where: { branchId },
    select: {
      id: true,
      path: true,
      language: true,
      role: true,
      content: true,
      lineCount: true,
      isTest: true,
      isConfig: true,
      isGenerated: true,
    },
  });

  return rows
    .filter((row) => row.content !== null)
    .map((row) => ({
      id: row.id,
      path: row.path,
      language: row.language ?? 'unknown',
      role: row.role ?? 'unknown',
      content: row.content as string,
      lineCount: row.lineCount,
      isTest: row.isTest,
      isConfig: row.isConfig,
      isGenerated: row.isGenerated,
    }));
}

function secretFindings(file: AnalyzableFile): AnalysisFindingDraft[] {
  if (file.isTest) return [];
  return detectSecrets(file.content).map((secret) => ({
    category: 'security' as const,
    ruleId: secret.ruleId,
    type: 'hardcoded-secret',
    severity: secret.severity,
    title: `${secret.label} committed to source`,
    description:
      `A value matching ${secret.label} appears directly in the source at line ${secret.line}. ` +
      'Anything in version control must be assumed compromised and rotated.',
    // Never store or transmit the secret itself.
    evidence: `Pattern ${secret.ruleId} matched at ${file.path}:${secret.line} (value masked as ${secret.preview}).`,
    recommendation:
      'Rotate the credential, remove it from the file and from git history, and load it from an environment variable or secret manager.',
    filePath: file.path,
    startLine: secret.line,
    endLine: secret.line,
    confidence: secret.confidence,
    confidenceLabel: confidenceLabel(secret.confidence),
    status: findingStatus('static', secret.confidence),
    source: 'static' as const,
    cwe: 'CWE-798',
    metadata: { detector: 'secret-scanner', rule: secret.ruleId },
  }));
}

async function incomingImportCounts(repositoryId: string, branchId: string): Promise<Map<string, number>> {
  const rows = await prisma.dependency.groupBy({
    by: ['toFileId'],
    where: { repositoryId, toFileId: { not: null }, toFile: { branchId } },
    _count: { toFileId: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.toFileId) map.set(row.toFileId, row._count.toFileId);
  }
  return map;
}

async function loadDuplicateUnits(repositoryId: string, branchId: string): Promise<DuplicateCandidateUnit[]> {
  const chunks = await prisma.codeChunk.findMany({
    where: { repositoryId, file: { branchId, isGenerated: false }, symbolName: { not: null } },
    select: {
      symbolName: true,
      symbolType: true,
      startLine: true,
      endLine: true,
      content: true,
      file: { select: { path: true, isTest: true } },
    },
    take: 8000,
  });

  return chunks.map((chunk) => ({
    filePath: chunk.file.path,
    symbolName: chunk.symbolName ?? 'anonymous',
    symbolType: chunk.symbolType,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    isTest: chunk.file.isTest,
  }));
}

async function symbolComplexity(
  repositoryId: string,
  branchId: string,
): Promise<{ average: number; max: number; high: number; total: number }> {
  const rows = await prisma.codeSymbol.findMany({
    where: { repositoryId, file: { branchId } },
    select: { complexity: true },
  });
  if (!rows.length) return { average: 0, max: 0, high: 0, total: 0 };
  const total = rows.length;
  const sum = rows.reduce((acc, r) => acc + r.complexity, 0);
  const max = rows.reduce((acc, r) => Math.max(acc, r.complexity), 0);
  const high = rows.filter((r) => r.complexity > 20).length;
  return { average: sum / total, max, high, total };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function dedupeFindings(drafts: readonly AnalysisFindingDraft[]): AnalysisFindingDraft[] {
  const seen = new Map<string, AnalysisFindingDraft>();
  for (const draft of drafts) {
    // Dependency findings are identified by package, not by location: every
    // package in a lockfile can legitimately land on the same line, so the
    // location key would collapse unrelated vulnerabilities into one.
    const key =
      draft.source === 'sca'
        ? `sca:${draft.ruleId}:${draft.filePath}`
        : `${draft.category}:${draft.type}:${draft.filePath}:${draft.startLine}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, draft);
      continue;
    }
    // Prefer the deterministic finding, then the more confident one.
    if (existing.source !== 'static' && draft.source === 'static') seen.set(key, draft);
    else if (existing.source === draft.source && draft.confidence > existing.confidence) seen.set(key, draft);
    else if (existing.source === 'static' && draft.source === 'ai') {
      existing.source = 'hybrid';
      existing.status = findingStatus('hybrid', Math.max(existing.confidence, draft.confidence));
      existing.confidence = Math.max(existing.confidence, draft.confidence);
      existing.description = `${existing.description}\n\nAI review agreed: ${draft.description}`.slice(0, 4000);
    }
  }
  return [...seen.values()];
}

export async function persistFindings(
  repositoryId: string,
  runId: string | null,
  branchId: string,
  drafts: readonly AnalysisFindingDraft[],
  reviewId?: string,
): Promise<AnalysisFindingDraft[]> {
  if (!drafts.length) return [];

  const files = await prisma.repositoryFile.findMany({
    where: { repositoryId, branchId },
    select: { id: true, path: true },
  });
  const fileIdByPath = new Map(files.map((f) => [f.path, f.id]));

  const data = drafts.map((draft) => ({
    repositoryId,
    runId,
    reviewId: reviewId ?? null,
    fileId: fileIdByPath.get(draft.filePath) ?? null,
    category: draft.category,
    ruleId: draft.ruleId ?? null,
    type: draft.type,
    severity: draft.severity,
    title: draft.title,
    description: draft.description,
    evidence: draft.evidence ?? null,
    recommendation: draft.recommendation ?? null,
    filePath: draft.filePath,
    startLine: draft.startLine,
    endLine: draft.endLine ?? draft.startLine,
    snippet: draft.snippet ?? null,
    relatedFilePath: draft.relatedFilePath ?? null,
    relatedStartLine: draft.relatedStartLine ?? null,
    relatedEndLine: draft.relatedEndLine ?? null,
    similarity: draft.similarity ?? null,
    confidence: draft.confidence,
    confidenceLabel: draft.confidenceLabel,
    status: draft.status,
    source: draft.source,
    cwe: draft.cwe ?? null,
    metadata: (draft.metadata ?? {}) as Prisma.InputJsonValue,
    fingerprint: draft.fingerprint ?? null,
    falsePositive: draft.falsePositive ?? false,
    resolved: draft.resolved ?? false,
  }));

  for (let i = 0; i < data.length; i += 200) {
    await prisma.analysisFinding.createMany({ data: data.slice(i, i + 200) });
  }

  return [...drafts];
}

function countBy(findings: readonly AnalysisFindingDraft[]): {
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  severityByCategory: Record<string, Record<string, number>>;
} {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const severityByCategory: Record<string, Record<string, number>> = {};

  for (const finding of findings) {
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    const bucket = (severityByCategory[finding.category] ??= {});
    bucket[finding.severity] = (bucket[finding.severity] ?? 0) + 1;
  }

  return { byCategory, bySeverity, severityByCategory };
}
