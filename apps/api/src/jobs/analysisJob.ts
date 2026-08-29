import type { Prisma } from '@prisma/client';
import { analyzeRepository } from '../analyzers/engine';
import { generateArchitecture } from '../analyzers/architecture';
import { generateDocumentation } from '../analyzers/documentation';
import { prisma } from '../db';
import { env } from '../env';
import { AppError } from '../errors';
import { indexRepository } from '../indexer/indexRepository';
import { INDEXING_STEPS, RunProgress } from '../indexer/progress';
import type { StackProfile } from '../indexer/projectMap';
import { getQueue } from './queue';

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
export async function runAnalysisJob(payload: AnalysisJobPayload): Promise<void> {
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
      },
      progress,
    );

    progress.mergeStats({
      findings: summary.findings,
      findingsByCategory: summary.byCategory,
      findingsBySeverity: summary.bySeverity,
      aiUsed: summary.aiUsed,
      aiRejectedFindings: summary.aiRejectedFindings,
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

    await prisma.analysisRun
      .update({
        where: { id: payload.runId },
        data: {
          status: 'failed',
          error: message.slice(0, 2000),
          finishedAt: new Date(),
          steps: progress.snapshot() as unknown as Prisma.InputJsonValue,
          stats: progress.getStats() as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}

export function registerJobs(): void {
  const queue = getQueue();
  queue.register<AnalysisJobPayload>(ANALYSIS_JOB, runAnalysisJob);
}

export async function enqueueAnalysis(payload: AnalysisJobPayload): Promise<string> {
  return getQueue().enqueue(ANALYSIS_JOB, payload);
}
