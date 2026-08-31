import type { Prisma } from '@prisma/client';
import { analyzeRepository } from '../analyzers/engine';
import type { TriageState } from '../analyzers/fingerprint';
import { generateArchitecture } from '../analyzers/architecture';
import { generateDocumentation } from '../analyzers/documentation';
import { prisma } from '../db';
import { env } from '../env';
import { AppError } from '../errors';
import { indexRepository } from '../indexer/indexRepository';
import { INDEXING_STEPS, RunProgress } from '../indexer/progress';
import type { StackProfile } from '../indexer/projectMap';
import { getQueue, TerminalJobError, type JobRecord } from './queue';

export const ANALYSIS_JOB = 'repository.analyze';

export interface AnalysisJobPayload {
  runId: string;
  repositoryId: string;
  userId: string;
  branchName: string;
  incremental: boolean;
  generateDocs: boolean;
}

/**
 * The full pipeline for one analysis run:
 *   index -> deterministic analysis -> AI analysis -> architecture -> documentation
 *
 * Every stage records its own progress, and a failure records the reason on the
 * run instead of throwing into the void.
 */
export async function runAnalysisJob(
  payload: AnalysisJobPayload,
  job?: JobRecord<AnalysisJobPayload>,
): Promise<void> {
  const progress = new RunProgress(payload.runId, INDEXING_STEPS);

  try {
    await progress.begin();
    await prisma.analysisRun.update({
      where: { id: payload.runId },
      data: { aiProvider: env.AI_PROVIDER, aiModel: env.AI_MODEL },
    });

    const repository = await prisma.repository.findUniqueOrThrow({ where: { id: payload.repositoryId } });

    // ---- index ----------------------------------------------------------
    const indexResult = await indexRepository(
      {
        repositoryId: payload.repositoryId,
        userId: payload.userId,
        branchName: payload.branchName,
        incremental: payload.incremental,
      },
      progress,
    );

    progress.mergeStats({
      filesIndexed: indexResult.filesIndexed,
      filesUnchanged: indexResult.filesUnchanged,
      filesRemoved: indexResult.filesRemoved,
      filesSkipped: indexResult.filesSkipped,
      skippedReasons: indexResult.skippedReasons,
      symbols: indexResult.symbols,
      chunks: indexResult.chunks,
      embeddedChunks: indexResult.embeddedChunks,
      dependencies: indexResult.dependencies,
      totalLines: indexResult.totalLines,
      commitSha: indexResult.commitSha,
      treeTruncated: indexResult.treeTruncated,
    });

    await prisma.analysisRun.update({
      where: { id: payload.runId },
      data: { branchId: indexResult.branchId, commitSha: indexResult.commitSha },
    });

    // Read the user's triage decisions before the rebuild wipes them, so
    // dismissed findings do not come straight back on the next scan.
    const priorTriage = await loadPriorTriage(payload.repositoryId, indexResult.branchId);

    // Findings from previous runs on this branch are replaced, not accumulated.
    await prisma.analysisFinding.deleteMany({
      where: { repositoryId: payload.repositoryId, reviewId: null, file: { branchId: indexResult.branchId } },
    });

    // ---- analysis --------------------------------------------------------
    const summary = await analyzeRepository(
      {
        repositoryId: payload.repositoryId,
        branchId: indexResult.branchId,
        runId: payload.runId,
        repositoryName: repository.fullName,
        stack: indexResult.stack,
        userId: payload.userId,
        owner: repository.owner,
        repo: repository.name,
        commitSha: indexResult.commitSha,
        priorTriage,
      },
      progress,
    );

    progress.mergeStats({
      findings: summary.findings,
      findingsByCategory: summary.byCategory,
      findingsBySeverity: summary.bySeverity,
      aiUsed: summary.aiUsed,
      aiRejectedFindings: summary.aiRejectedFindings,
      dependencyPackagesScanned: summary.sca.packagesScanned,
      vulnerableDependencies: summary.sca.vulnerablePackages,
      dependencyManifests: summary.sca.manifests,
      semgrepVersion: summary.sast.version,
      semgrepFindings: summary.sast.findings,
      semgrepDataflowFindings: summary.sast.dataflowFindings,
      triageCarriedForward: summary.triageCarriedForward,
    });

    // ---- architecture ----------------------------------------------------
    const architecture = await generateArchitecture({
      repositoryId: payload.repositoryId,
      branchId: indexResult.branchId,
      repositoryName: repository.fullName,
      stack: indexResult.stack,
    });
    progress.setStat('architectureGeneratedBy', architecture.generatedBy);

    // ---- documentation ---------------------------------------------------
    if (payload.generateDocs) {
      await progress.start('docs');
      const sections = await generateDocumentation({
        repositoryId: payload.repositoryId,
        branchId: indexResult.branchId,
        repositoryName: repository.fullName,
        stack: indexResult.stack as StackProfile,
        runId: payload.runId,
      });
      await progress.complete('docs', `${sections.length} sections written`);
    } else {
      await progress.skip('docs', 'Documentation generation was not requested for this run');
    }

    await prisma.analysisRun.update({
      where: { id: payload.runId },
      data: {
        status: 'completed',
        progress: 100,
        finishedAt: new Date(),
        steps: progress.snapshot() as unknown as Prisma.InputJsonValue,
        stats: progress.getStats() as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : `Analysis failed: ${(error as Error).message ?? 'unknown error'}`;

    // A GitHub 502 halfway through indexing a large repository is worth
    // another go; a deleted repository or a revoked token is not. Rethrowing
    // is what hands the decision back to the queue - swallowing every error
    // here is why the retry counter used to be dead.
    const attemptsLeft = job ? job.attempts < job.maxAttempts : false;

    if (isTransient(error) && attemptsLeft) {
      await prisma.analysisRun
        .update({
          where: { id: payload.runId },
          data: {
            status: 'queued',
            error: `${message.slice(0, 1800)} (attempt ${job!.attempts} of ${job!.maxAttempts}; retrying)`,
            steps: progress.snapshot() as unknown as Prisma.InputJsonValue,
            stats: progress.getStats() as unknown as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);

      throw error;
    }

    const attemptNote = job && job.attempts > 1 ? ` (gave up after ${job.attempts} attempts)` : '';

    await prisma.analysisRun
      .update({
        where: { id: payload.runId },
        data: {
          status: 'failed',
          error: `${message}${attemptNote}`.slice(0, 2000),
          finishedAt: new Date(),
          steps: progress.snapshot() as unknown as Prisma.InputJsonValue,
          stats: progress.getStats() as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    // Terminal: tell the queue not to spend the remaining attempts on it.
    if (attemptsLeft) throw new TerminalJobError(message, error);
  }
}

/**
 * Snapshots the triage a user applied on this branch, keyed by fingerprint.
 *
 * Only findings actually acted on are returned - an untouched finding has
 * nothing to carry forward, and loading them all would grow with the whole
 * findings table for no benefit.
 */
async function loadPriorTriage(repositoryId: string, branchId: string): Promise<Map<string, TriageState>> {
  const rows = await prisma.analysisFinding.findMany({
    where: {
      repositoryId,
      reviewId: null,
      file: { branchId },
      fingerprint: { not: null },
      OR: [{ falsePositive: true }, { resolved: true }],
    },
    select: { fingerprint: true, falsePositive: true, resolved: true },
  });

  const triage = new Map<string, TriageState>();
  for (const row of rows) {
    if (!row.fingerprint) continue;
    triage.set(row.fingerprint, { falsePositive: row.falsePositive, resolved: row.resolved });
  }
  return triage;
}

/**
 * Whether a failure is worth retrying.
 *
 * Server-side and network failures (GitHub 5xx, an AI provider outage, a
 * socket reset) are transient by nature. A 4xx is the service telling us the
 * request itself is wrong - repeating it just wastes the attempt.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof AppError) return error.statusCode >= 500;
  // Anything unclassified is most often a network or driver fault.
  return true;
}

export function registerJobs(): void {
  const queue = getQueue();
  queue.register<AnalysisJobPayload>(ANALYSIS_JOB, runAnalysisJob);
}

export async function enqueueAnalysis(payload: AnalysisJobPayload): Promise<string> {
  return getQueue().enqueue(ANALYSIS_JOB, payload);
}
