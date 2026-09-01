import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import { normaliseStackProfile } from '../indexer/projectMap';
import {
  buildChatPrompt,
  buildExtractiveAnswer,
  chatAnswerSchema,
  CHAT_SYSTEM_PROMPT,
} from '../prompts/codebaseChat';
import { extractCitationsFromText, validateCitations, type ValidatedCitation } from '../search/citations';
import { buildCodeContext, buildRepositoryOverview, type ContextSource } from '../search/context';
import { findSymbols, hybridSearch } from '../search/hybrid';

export interface AskOptions {
  repositoryId: string;
  branchId: string;
  repositoryName: string;
  branchName: string;
  question: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  maxChunks?: number;
}

export interface AskResult {
  answer: string;
  citations: ValidatedCitation[];
  invalidCitations: ValidatedCitation[];
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
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number };
  degraded: boolean;
}

/**
 * The RAG pipeline:
 *   understand -> hybrid retrieve -> build budgeted context -> generate ->
 *   validate every citation against the index -> persist.
 *
 * Nothing reaches the user that was not either retrieved from the repository or
 * validated against it.
 */
export async function askCodebase(options: AskOptions): Promise<AskResult> {
  const started = Date.now();

  const search = await hybridSearch({
    repositoryId: options.repositoryId,
    branchId: options.branchId,
    query: options.question,
    limit: options.maxChunks ?? 16,
  });

  const context = buildCodeContext(search.results, env.CONTEXT_TOKEN_BUDGET);

  const stackInsight = await prisma.repositoryInsight.findUnique({
    where: { repositoryId_kind: { repositoryId: options.repositoryId, kind: 'stack' } },
  });
  const overview = stackInsight
    ? buildRepositoryOverview(normaliseStackProfile(stackInsight.data), { maxRoutes: 30, maxDirectories: 20 })
    : 'No project map is available for this repository yet.';

  // Direct symbol hits give the model exact identifier locations.
  const symbolLines: string[] = [];
  for (const literal of search.understood.literals.slice(0, 5)) {
    const hits = await findSymbols(options.repositoryId, options.branchId, literal, 6);
    for (const hit of hits) {
      symbolLines.push(`${hit.kind} ${hit.name} — ${hit.filePath}:${hit.startLine}-${hit.endLine}`);
    }
  }

  const retrieval = {
    intent: search.understood.intent,
    terms: search.understood.terms,
    retrievers: search.retrievers,
    chunksConsidered: search.results.length,
    chunksIncluded: context.chunksIncluded,
    contextTokens: context.tokensUsed,
    redactions: context.redactions,
  };

  // ---- offline / no generative provider ---------------------------------
  if (!aiEnabled()) {
    return {
      answer: buildExtractiveAnswer({ question: options.question, sources: context.sources }),
      citations: context.sources.map((source) => ({
        filePath: source.filePath,
        startLine: source.startLine,
        endLine: source.endLine,
        symbolName: source.symbolName,
        valid: true,
      })),
      invalidCitations: [],
      sources: context.sources,
      groundingScore: context.sources.length ? 1 : 0,
      answered: context.sources.length > 0,
      followUps: [],
      retrieval,
      degraded: true,
    };
  }

  // ---- generation --------------------------------------------------------
  if (!context.sources.length) {
    return {
      answer:
        "I couldn't determine this confidently from the indexed repository.\n\n" +
        'No indexed code matched this question. If the repository has changed, re-run indexing; otherwise try naming a ' +
        'specific file, function or endpoint.',
      citations: [],
      invalidCitations: [],
      sources: [],
      groundingScore: 0,
      answered: false,
      followUps: [],
      retrieval,
      degraded: false,
    };
  }

  let generated;
  try {
    generated = await generateStructured({
      system: CHAT_SYSTEM_PROMPT,
      user: buildChatPrompt({
        question: options.question,
        repositoryName: options.repositoryName,
        branchName: options.branchName,
        overview,
        codeContext: context.text,
        history: options.history,
        symbolHits: symbolLines.length ? symbolLines.slice(0, 30).join('\n') : undefined,
      }),
      schema: chatAnswerSchema,
      task: 'codebase-chat',
      maxTokens: env.AI_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    if (error instanceof AIGenerationUnavailable) {
      return {
        answer: buildExtractiveAnswer({ question: options.question, sources: context.sources }),
        citations: [],
        invalidCitations: [],
        sources: context.sources,
        groundingScore: 0,
        answered: false,
        followUps: [],
        retrieval,
        degraded: true,
      };
    }
    throw error;
  }

  // ---- citation validation ----------------------------------------------
  const declared = generated.data.citations.map((c) => ({
    filePath: c.filePath,
    startLine: c.startLine ?? null,
    endLine: c.endLine ?? null,
    symbolName: c.symbolName ?? null,
    note: c.note ?? null,
  }));
  const inline = extractCitationsFromText(generated.data.answer);

  const merged = [...declared];
  for (const citation of inline) {
    const duplicate = merged.some(
      (m) => m.filePath.endsWith(citation.filePath) && (m.startLine ?? null) === (citation.startLine ?? null),
    );
    if (!duplicate) {
      merged.push({
        filePath: citation.filePath,
        startLine: citation.startLine ?? null,
        endLine: citation.endLine ?? null,
        symbolName: null,
        note: null,
      });
    }
  }

  const grounding = await validateCitations(options.repositoryId, options.branchId, merged);

  let answer = generated.data.answer;
  if (grounding.invalid.length) {
    answer +=
      `\n\n> **Unverified references removed.** ${grounding.invalid.length} reference(s) in this answer ` +
      `(${grounding.invalid.map((c) => `\`${c.filePath}${c.startLine ? `:${c.startLine}` : ''}\``).join(', ')}) ` +
      'do not exist in the indexed branch and are not shown as sources. Treat any claim resting on them as unverified.';
  }

  return {
    answer,
    citations: grounding.citations,
    invalidCitations: grounding.invalid,
    sources: context.sources,
    groundingScore: grounding.groundingScore,
    answered: generated.data.answered,
    followUps: generated.data.followUps ?? [],
    retrieval,
    usage: { ...generated.usage, latencyMs: Date.now() - started },
    degraded: false,
  };
}

export async function persistChatTurn(params: {
  sessionId: string;
  question: string;
  result: AskResult;
}): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const userMessage = await prisma.chatMessage.create({
    data: { sessionId: params.sessionId, role: 'user', content: params.question },
  });

  const assistantMessage = await prisma.chatMessage.create({
    data: {
      sessionId: params.sessionId,
      role: 'assistant',
      content: params.result.answer,
      citations: params.result.citations as unknown as Prisma.InputJsonValue,
      contextChunkIds: params.result.sources.map((s) => s.chunkId) as unknown as Prisma.InputJsonValue,
      groundingScore: params.result.groundingScore,
      provider: params.result.usage?.provider ?? env.AI_PROVIDER,
      model: params.result.usage?.model ?? env.AI_MODEL,
      tokensIn: params.result.usage?.inputTokens ?? null,
      tokensOut: params.result.usage?.outputTokens ?? null,
      latencyMs: params.result.usage?.latencyMs ?? null,
    },
  });

  await prisma.chatSession.update({ where: { id: params.sessionId }, data: { updatedAt: new Date() } });

  return { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
}
