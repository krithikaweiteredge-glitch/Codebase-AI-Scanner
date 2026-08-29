import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import { notFound } from '../errors';
import type { StackProfile } from '../indexer/projectMap';
import { sliceLines } from '../lib/text';
import {
  TEST_SYSTEM_PROMPT,
  buildTestPrompt,
  testSuggestionSchema,
  type TestSuggestionPayload,
} from '../prompts/testGeneration';

export interface TestGenerationRequest {
  repositoryId: string;
  branchId: string;
  repositoryName: string;
  stack: StackProfile;
  filePath: string;
  symbolName?: string;
}

export interface TestGenerationResult extends TestSuggestionPayload {
  filePath: string;
  startLine: number;
  endLine: number;
  generatedBy: 'ai' | 'deterministic';
  frameworkEvidence: string;
}

const LANGUAGE_DEFAULT_FRAMEWORK: Record<string, string> = {
  typescript: 'Vitest',
  tsx: 'Vitest',
  javascript: 'Jest',
  jsx: 'Jest',
  python: 'pytest',
  java: 'JUnit',
  kotlin: 'JUnit',
  go: 'Go testing',
  csharp: 'xUnit',
  ruby: 'RSpec',
  php: 'PHPUnit',
  rust: 'Rust built-in tests',
};

/** Framework detection is evidence-first: manifests and imports beat language defaults. */
export function detectTestFramework(stack: StackProfile, language: string): { framework: string; evidence: string } {
  if (stack.testFrameworks.length) {
    const preferred = stack.testFrameworks[0]!;
    const evidence = preferred.evidence[0];
    return {
      framework: preferred.name,
      evidence: `detected from ${evidence?.file ?? 'the repository manifests'}${evidence?.detail ? ` (${evidence.detail})` : ''}`,
    };
  }
  const fallback = LANGUAGE_DEFAULT_FRAMEWORK[language] ?? 'the language default test runner';
  return { framework: fallback, evidence: `no test framework found in the repository; defaulting to ${fallback} for ${language}` };
}

export async function generateTestSuggestions(request: TestGenerationRequest): Promise<TestGenerationResult> {
  const file = await prisma.repositoryFile.findFirst({
    where: { branchId: request.branchId, path: request.filePath },
    select: { id: true, path: true, content: true, language: true, lineCount: true },
  });
  if (!file || file.content === null) throw notFound(`File "${request.filePath}" is not indexed on this branch`);

  const symbol = request.symbolName
    ? await prisma.codeSymbol.findFirst({
        where: { fileId: file.id, name: request.symbolName },
        orderBy: { startLine: 'asc' },
      })
    : null;

  if (request.symbolName && !symbol) {
    throw notFound(`Symbol "${request.symbolName}" was not found in ${request.filePath}`);
  }

  const startLine = symbol?.startLine ?? 1;
  const endLine = symbol?.endLine ?? Math.min(file.lineCount, 400);
  const targetCode = sliceLines(file.content, startLine, endLine);
  const target = symbol ? `${symbol.name} (${symbol.kind})` : file.path;

  const { framework, evidence } = detectTestFramework(request.stack, file.language ?? 'unknown');
  const existingTest = await findExampleTest(request.branchId, file.language ?? 'unknown');
  const collaborators = await describeCollaborators(file.id);

  const deterministic = deterministicTestPlan(target, targetCode, framework, startLine);

  if (aiEnabled()) {
    try {
      const { data } = await generateStructured({
        system: TEST_SYSTEM_PROMPT,
        user: buildTestPrompt({
          repositoryName: request.repositoryName,
          target,
          filePath: file.path,
          framework,
          frameworkEvidence: evidence,
          targetCode: numbered(targetCode, startLine),
          existingTestExample: existingTest ?? undefined,
          dependencies: collaborators,
        }),
        schema: testSuggestionSchema,
        task: 'test-generation',
        maxTokens: env.AI_MAX_OUTPUT_TOKENS,
      });

      const result: TestGenerationResult = {
        ...data,
        filePath: file.path,
        startLine,
        endLine,
        generatedBy: 'ai',
        frameworkEvidence: evidence,
      };
      await persist(request, file.id, result);
      return result;
    } catch (error) {
      if (!(error instanceof AIGenerationUnavailable)) throw error;
    }
  }

  const result: TestGenerationResult = {
    ...deterministic,
    filePath: file.path,
    startLine,
    endLine,
    generatedBy: 'deterministic',
    frameworkEvidence: evidence,
  };
  await persist(request, file.id, result);
  return result;
}

async function persist(request: TestGenerationRequest, fileId: string, result: TestGenerationResult): Promise<void> {
  await prisma.testSuggestion.create({
    data: {
      repositoryId: request.repositoryId,
      fileId,
      target: result.target,
      targetKind: request.symbolName ? 'function' : 'file',
      framework: result.framework,
      cases: result.cases as unknown as Prisma.InputJsonValue,
      code: result.code ?? null,
      rationale: result.rationale ?? null,
      filePath: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
    },
  });
}

async function findExampleTest(branchId: string, language: string): Promise<string | null> {
  const test = await prisma.repositoryFile.findFirst({
    where: { branchId, isTest: true, language, content: { not: null } },
    orderBy: { lineCount: 'asc' },
    select: { path: true, content: true },
  });
  if (!test?.content) return null;
  return `// ${test.path}\n${test.content.slice(0, 4000)}`;
}

async function describeCollaborators(fileId: string): Promise<string> {
  const deps = await prisma.dependency.findMany({
    where: { fromFileId: fileId, toFileId: { not: null } },
    select: { specifier: true, toFile: { select: { path: true, id: true } } },
    take: 10,
  });
  if (!deps.length) return '';

  const lines: string[] = [];
  for (const dep of deps) {
    if (!dep.toFile) continue;
    const symbols = await prisma.codeSymbol.findMany({
      where: { fileId: dep.toFile.id, exported: true },
      select: { name: true, kind: true, signature: true, startLine: true },
      take: 8,
    });
    lines.push(`${dep.toFile.path} (imported as "${dep.specifier}")`);
    for (const symbol of symbols) {
      lines.push(`  - ${symbol.kind} ${symbol.name} @${symbol.startLine}: ${symbol.signature ?? ''}`);
    }
  }
  return lines.join('\n').slice(0, 4000);
}

function numbered(code: string, startLine: number): string {
  return code
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(5, ' ')} | ${line}`)
    .join('\n');
}

/**
 * Offline test plan: every guard, throw and early return in the target becomes a
 * case. It cites the real line each case comes from, so it is verifiable.
 */
export function deterministicTestPlan(
  target: string,
  code: string,
  framework: string,
  startLine: number,
): TestSuggestionPayload {
  const lines = code.split('\n');
  const cases: TestSuggestionPayload['cases'] = [];

  cases.push({
    name: `${target} returns the expected result for valid input`,
    kind: 'happy-path',
    given: 'All inputs valid and every dependency resolves successfully.',
    expected: 'The function completes and returns its documented result.',
    priority: 'high',
  });

  const seen = new Set<string>();
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = startLine + index;

    const throwMatch = line.match(/\bthrow\s+(?:new\s+)?([A-Za-z_$][\w$]*)?/);
    if (throwMatch) {
      const key = `throw:${throwMatch[1] ?? 'error'}:${line.slice(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        cases.push({
          name: `${target} throws ${throwMatch[1] ?? 'an error'} when the guard at line ${lineNumber} is hit`,
          kind: 'error-path',
          given: `Input or state that satisfies the condition guarding line ${lineNumber}: ${line.slice(0, 160)}`,
          expected: `The call rejects/throws ${throwMatch[1] ?? 'an error'} and performs no partial side effects.`,
          priority: 'high',
        });
      }
    }

    const guardMatch = line.match(/^(?:if|elif)\s*\(?\s*(!?[\w$.[\]]+)/);
    if (guardMatch && /\breturn\b|\bthrow\b|\braise\b/.test(lines[index + 1] ?? '')) {
      const key = `guard:${guardMatch[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        cases.push({
          name: `${target} handles the "${guardMatch[1]}" branch at line ${lineNumber}`,
          kind: 'edge-case',
          given: `A value that makes \`${guardMatch[1]}\` take the branch at line ${lineNumber}.`,
          expected: 'The early-exit behaviour on that branch is observed, not the main path.',
          priority: 'medium',
        });
      }
    }

    if (/\bcatch\b|\bexcept\b/.test(line)) {
      const key = `catch:${lineNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        cases.push({
          name: `${target} handles a dependency failure (catch at line ${lineNumber})`,
          kind: 'error-path',
          given: 'A collaborator (database, HTTP client, filesystem) rejects or throws.',
          expected: 'The error path at this line runs: the failure is surfaced or translated as the code specifies.',
          priority: 'high',
        });
      }
    }

    if (/\bawait\b/.test(line) && cases.length < 18 && !seen.has('async-reject')) {
      seen.add('async-reject');
      cases.push({
        name: `${target} propagates rejection from the awaited call at line ${lineNumber}`,
        kind: 'error-path',
        given: 'The awaited promise rejects.',
        expected: 'The rejection is handled or propagated; no unhandled rejection escapes.',
        priority: 'medium',
      });
    }
  });

  if (/\b(?:req|request)\.(?:body|params|query)\b/.test(code) && cases.length < 20) {
    cases.push({
      name: `${target} rejects malformed input`,
      kind: 'security',
      given: 'Missing required fields, wrong types, and oversized values in the request payload.',
      expected: 'Input validation rejects the request before any side effect occurs.',
      priority: 'high',
    });
  }

  return {
    framework,
    target,
    rationale:
      'Derived deterministically from the branches, throws and catch blocks in the target. ' +
      'Configure an AI provider to also generate runnable test code in the style of the existing suite.',
    cases: cases.slice(0, 20),
    uncoveredBehaviour: [],
  };
}
