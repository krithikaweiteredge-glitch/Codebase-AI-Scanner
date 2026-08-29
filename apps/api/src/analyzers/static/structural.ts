import type { StackProfile } from '../../indexer/projectMap';
import type { AnalysisFindingDraft, AnalyzableFile } from '../types';

const DB_CALL =
  /\b(?:await\s+)?(?:prisma|db|database|knex|sequelize|repo|repository|em|session|conn|connection|client|models?)\b[\w.]*\.(?:find\w*|query|select|get|fetch|aggregate|count|create|update|delete|save|insert|exec\w*)\s*\(|\.\$query\w*\s*\(|\bSELECT\b[\s\S]{0,60}\bFROM\b|\bfetch\s*\(|axios\.(?:get|post|put|delete)\s*\(/i;

const LOOP_HEAD = /\b(?:for\s*\(|for\s+\w+\s+in\b|while\s*\(|\.forEach\s*\(|\.map\s*\(|\bfor\s+\w+\s*:=\s*range\b)/g;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Returns the [start,end] character offsets of the block that follows `index`. */
function blockRange(content: string, index: number, language: string): { start: number; end: number } | null {
  if (language === 'python') {
    const lines = content.split('\n');
    const startLine = lineAt(content, index);
    const baseIndent = (lines[startLine - 1] ?? '').match(/^[ \t]*/)?.[0].length ?? 0;
    let endLine = startLine;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.trim()) continue;
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      endLine = i + 1;
    }
    const start = content.split('\n').slice(0, startLine).join('\n').length;
    const end = content.split('\n').slice(0, endLine).join('\n').length;
    return end > start ? { start, end } : null;
  }

  const open = content.indexOf('{', index);
  if (open === -1 || lineAt(content, open) > lineAt(content, index) + 2) return null;
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return null;
}

/**
 * N+1 detection: a data-access or network call inside a loop body.
 * Deterministic (no model involved), so findings are marked `likely` rather
 * than `potential`.
 */
export function detectNPlusOne(file: AnalyzableFile): AnalysisFindingDraft[] {
  if (file.isTest || file.isGenerated) return [];
  const findings: AnalysisFindingDraft[] = [];
  const lines = file.content.split('\n');
  LOOP_HEAD.lastIndex = 0;

  let match: RegExpExecArray | null;
  const seenLines = new Set<number>();

  while ((match = LOOP_HEAD.exec(file.content)) !== null) {
    const range = blockRange(file.content, match.index, file.language);
    if (!range) continue;
    const body = file.content.slice(range.start, range.end);
    if (body.length > 4000) continue;

    DB_CALL.lastIndex = 0;
    const call = DB_CALL.exec(body);
    if (!call) continue;

    const loopLine = lineAt(file.content, match.index);
    const callLine = lineAt(file.content, range.start + call.index);
    if (seenLines.has(loopLine)) continue;
    seenLines.add(loopLine);

    findings.push({
      category: 'performance',
      ruleId: 'perf.n-plus-one',
      type: 'n-plus-one-query',
      severity: 'high',
      title: 'Data access inside a loop (N+1)',
      description:
        `The loop starting at line ${loopLine} performs a data-access or network call on every iteration ` +
        `(line ${callLine}). Cost grows linearly with the collection size, and each call adds a full round trip.`,
      evidence: `Loop: ${(lines[loopLine - 1] ?? '').trim().slice(0, 160)} | Call: ${(lines[callLine - 1] ?? '').trim().slice(0, 160)}`,
      recommendation:
        'Fetch the rows in one query (WHERE id IN (...) / include / join) and map the results in memory, or batch the calls.',
      filePath: file.path,
      startLine: loopLine,
      endLine: lineAt(file.content, range.end),
      snippet: lines.slice(loopLine - 1, Math.min(lines.length, loopLine + 12)).join('\n').slice(0, 1200),
      confidence: 0.8,
      confidenceLabel: 'high',
      status: 'likely',
      source: 'static',
      metadata: { detector: 'loop-body-scan', callLine },
    });

    if (findings.length >= 12) break;
  }

  return findings;
}

/** Unused imports - deterministic, so these are reported as confirmed. */
export function detectUnusedImports(file: AnalyzableFile): AnalysisFindingDraft[] {
  if (!['typescript', 'tsx', 'javascript', 'jsx'].includes(file.language)) return [];
  if (file.isGenerated) return [];

  const findings: AnalysisFindingDraft[] = [];
  const importPattern = /^\s*import\s+(?!type\s)([\s\S]*?)\s+from\s+['"][^'"]+['"];?/gm;
  let match: RegExpExecArray | null;

  // Remove import statements and comments before counting usages.
  const body = file.content
    .replace(importPattern, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  importPattern.lastIndex = 0;
  while ((match = importPattern.exec(file.content)) !== null) {
    const clause = match[1] ?? '';
    const line = lineAt(file.content, match.index);
    const names: string[] = [];

    const namedBlock = clause.match(/\{([^}]*)\}/);
    if (namedBlock?.[1]) {
      for (const part of namedBlock[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
      }
    }
    const defaultName = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',')[0]?.trim();
    if (defaultName && /^[A-Za-z_$][\w$]*$/.test(defaultName)) names.push(defaultName);

    for (const name of names) {
      const usage = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
      const used = (body.match(usage) ?? []).length;
      if (used > 0) continue;

      findings.push({
        category: 'quality',
        ruleId: 'quality.unused-import',
        type: 'unused-import',
        severity: 'info',
        title: `Unused import "${name}"`,
        description: `"${name}" is imported but never referenced in this file.`,
        evidence: `Import at ${file.path}:${line}; zero references in the remainder of the file.`,
        recommendation: 'Remove the import.',
        filePath: file.path,
        startLine: line,
        endLine: line,
        confidence: 0.95,
        confidenceLabel: 'high',
        status: 'confirmed',
        source: 'static',
        metadata: { detector: 'unused-import', symbol: name },
      });
      if (findings.length >= 25) return findings;
    }
  }

  return findings;
}

/** Statements after an unconditional return/throw in the same block. */
export function detectUnreachableCode(file: AnalyzableFile): AnalysisFindingDraft[] {
  if (file.isGenerated) return [];
  const findings: AnalysisFindingDraft[] = [];
  const lines = file.content.split('\n');

  for (let i = 0; i < lines.length - 1; i++) {
    const line = (lines[i] as string).trim();
    if (!/^(return\b|throw\b|break;|continue;|raise\b)/.test(line)) continue;
    if (line.endsWith('{') || line.endsWith('(')) continue;

    const indent = (lines[i] as string).match(/^[ \t]*/)?.[0] ?? '';
    const next = lines[i + 1];
    if (next === undefined) continue;
    const nextTrimmed = next.trim();
    if (!nextTrimmed) continue;
    if (/^([})\]]|case\b|default\b|else\b|elif\b|catch\b|finally\b|\/\/|\/\*|\*|#|@)/.test(nextTrimmed)) continue;

    const nextIndent = next.match(/^[ \t]*/)?.[0] ?? '';
    if (nextIndent.length < indent.length) continue;

    findings.push({
      category: 'bug',
      ruleId: 'bug.unreachable-code',
      type: 'unreachable-code',
      severity: 'medium',
      title: 'Unreachable statement after return',
      description: `Line ${i + 2} can never execute: the previous statement leaves the block unconditionally.`,
      evidence: `${file.path}:${i + 1} -> "${line.slice(0, 120)}" followed by "${nextTrimmed.slice(0, 120)}"`,
      recommendation: 'Remove the dead statement, or move it before the return if it was meant to run.',
      filePath: file.path,
      startLine: i + 2,
      endLine: i + 2,
      confidence: 0.85,
      confidenceLabel: 'high',
      status: 'likely',
      source: 'static',
      metadata: { detector: 'unreachable-scan' },
    });
    if (findings.length >= 10) break;
  }

  return findings;
}

/** Routes with no visible authentication guard, from the deterministic route index. */
export function detectUnprotectedRoutes(stack: StackProfile): AnalysisFindingDraft[] {
  const findings: AnalysisFindingDraft[] = [];
  const hasAuthMechanism = stack.authMechanisms.length > 0;
  if (!hasAuthMechanism) return findings;

  const PUBLIC_BY_DESIGN = /^\/?(?:$|health|healthz|ready|live|ping|status|metrics|docs|swagger|openapi|auth\/(?:login|register|signup|signin|callback|refresh|forgot|reset)|login|register|signup|webhooks?\/)/i;

  for (const route of stack.routes) {
    if (route.protectedHint) continue;
    const normalised = route.path.replace(/^\//, '');
    if (PUBLIC_BY_DESIGN.test(normalised)) continue;

    const stateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method);

    findings.push({
      category: 'security',
      ruleId: 'sec.unprotected-route',
      type: 'missing-access-control',
      severity: stateChanging ? 'high' : 'medium',
      title: `${route.method} ${route.path} has no visible auth guard`,
      description:
        `This repository uses ${stack.authMechanisms.map((a) => a.name).join(', ')}, but no authentication ` +
        `middleware, guard or decorator was detected on or around this ${route.method} route.`,
      evidence: `Route declared at ${route.file}:${route.line} (${route.framework}); no auth identifier found within the surrounding declaration.`,
      recommendation:
        'Confirm the route is intentionally public. If not, attach the authentication middleware/guard used by the protected routes in this codebase.',
      filePath: route.file,
      startLine: route.line,
      endLine: route.line,
      confidence: 0.55,
      confidenceLabel: 'medium',
      status: 'potential',
      source: 'static',
      cwe: 'CWE-306',
      metadata: { detector: 'route-index', method: route.method, path: route.path, framework: route.framework },
    });

    if (findings.length >= 40) break;
  }

  return findings;
}

/** Auth endpoints without any rate limiting library or middleware in the repository. */
export function detectMissingRateLimit(stack: StackProfile, files: readonly AnalyzableFile[]): AnalysisFindingDraft[] {
  const authRoutes = stack.routes.filter(
    (r) => /\b(login|signin|register|signup|token|password|otp|verify)\b/i.test(r.path) && r.method === 'POST',
  );
  if (!authRoutes.length) return [];

  const rateLimitPattern = /rate[_-]?limit|express-rate-limit|@fastify\/rate-limit|slowDown|throttle|Bucket4j|django_ratelimit|limiter/i;
  const hasRateLimiting = files.some((f) => rateLimitPattern.test(f.content));
  if (hasRateLimiting) return [];

  const first = authRoutes[0]!;
  return [
    {
      category: 'security',
      ruleId: 'sec.missing-rate-limit',
      type: 'missing-rate-limiting',
      severity: 'medium',
      title: 'Authentication endpoints have no rate limiting',
      description:
        `${authRoutes.length} authentication-related endpoint(s) were detected, but no rate limiting middleware or ` +
        'library appears anywhere in the indexed code. Credential stuffing and brute-force attempts are unthrottled.',
      evidence: `Endpoints: ${authRoutes.slice(0, 6).map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`).join(', ')}`,
      recommendation:
        'Add rate limiting (per IP and per account) in front of the authentication routes, plus exponential backoff or lockout on repeated failures.',
      filePath: first.file,
      startLine: first.line,
      endLine: first.line,
      confidence: 0.7,
      confidenceLabel: 'medium',
      status: 'likely',
      source: 'static',
      cwe: 'CWE-307',
      metadata: { detector: 'stack-profile', endpoints: authRoutes.length },
    },
  ];
}

/** Files that nothing imports and that are not entry points, tests or config. */
export function detectDeadFiles(
  files: readonly AnalyzableFile[],
  incomingCounts: Map<string, number>,
  entryPoints: ReadonlySet<string>,
): AnalysisFindingDraft[] {
  const findings: AnalysisFindingDraft[] = [];

  for (const file of files) {
    if (file.isTest || file.isConfig || file.isGenerated) continue;
    if (entryPoints.has(file.path)) continue;
    if (!['typescript', 'tsx', 'javascript', 'jsx', 'python'].includes(file.language)) continue;
    if ((incomingCounts.get(file.id) ?? 0) > 0) continue;
    if (/(^|\/)(index|main|app|server|__init__)\.[a-z]+$/.test(file.path)) continue;
    if (file.lineCount < 15) continue;

    findings.push({
      category: 'quality',
      ruleId: 'quality.dead-file',
      type: 'dead-file',
      severity: 'low',
      title: 'File is never imported',
      description:
        'No indexed file imports this module, and it is not an entry point, test or configuration file. It may be dead code.',
      evidence: `Dependency graph shows zero incoming edges for ${file.path} (${file.lineCount} lines).`,
      recommendation:
        'Confirm it is not loaded dynamically (string path, framework auto-discovery, build glob). If unused, delete it.',
      filePath: file.path,
      startLine: 1,
      endLine: Math.min(file.lineCount, 5),
      confidence: 0.6,
      confidenceLabel: 'medium',
      status: 'potential',
      source: 'static',
      metadata: { detector: 'dependency-graph' },
    });

    if (findings.length >= 30) break;
  }

  return findings;
}
