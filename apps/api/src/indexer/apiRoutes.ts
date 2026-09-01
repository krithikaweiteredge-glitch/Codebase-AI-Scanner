import type { Language } from './languages';

export interface DetectedRoute {
  method: string;
  path: string;
  line: number;
  framework: string;
  handler?: string;
  /** True when an auth guard/middleware is visible on or around the declaration. */
  protectedHint: boolean;
}

interface RoutePattern {
  framework: string;
  languages: Language[];
  pattern: RegExp;
  method: number | string;
  path: number;
  handler?: number;
}

const PATTERNS: RoutePattern[] = [
  {
    framework: 'express/fastify/koa',
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    pattern:
      /\b(?:app|router|api|server|fastify|route[rs]?)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]([\s\S]{0,200}?)\)/g,
    method: 1,
    path: 2,
    handler: 3,
  },
  {
    framework: 'fastify-route-object',
    languages: ['typescript', 'javascript'],
    pattern: /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`][\s\S]{0,120}?url\s*:\s*['"`]([^'"`]+)['"`]/gi,
    method: 1,
    path: 2,
  },
  {
    framework: 'nestjs',
    languages: ['typescript'],
    pattern: /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)\s*(?:async\s+)?(\w+)?/g,
    method: 1,
    path: 2,
    handler: 3,
  },
  {
    framework: 'flask',
    languages: ['python'],
    pattern: /@\w+\.route\s*\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?[^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g,
    method: 'ROUTE_METHODS',
    path: 1,
    handler: 3,
  },
  {
    framework: 'fastapi',
    languages: ['python'],
    pattern: /@\w+\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"][^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g,
    method: 1,
    path: 2,
    handler: 3,
  },
  {
    framework: 'django',
    languages: ['python'],
    pattern: /\b(?:re_)?path\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/g,
    method: 'ANY',
    path: 1,
    handler: 2,
  },
  {
    framework: 'spring',
    languages: ['java', 'kotlin'],
    pattern: /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]*)['"]/g,
    method: 1,
    path: 2,
  },
  {
    framework: 'aspnet',
    languages: ['csharp'],
    pattern: /\[Http(Get|Post|Put|Patch|Delete)\s*\(?\s*['"]?([^'"\])]*)['"]?\s*\)?\]/g,
    method: 1,
    path: 2,
  },
  {
    framework: 'aspnet-minimal',
    languages: ['csharp'],
    pattern: /\bMap(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]+)['"]/g,
    method: 1,
    path: 2,
  },
  {
    framework: 'go-net-http',
    languages: ['go'],
    pattern: /\b(?:http|mux|r|router|s)\s*\.\s*Handle(?:Func)?\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\w.]+)?/g,
    method: 'ANY',
    path: 1,
    handler: 2,
  },
  {
    framework: 'go-gin-echo-chi',
    languages: ['go'],
    pattern: /\b\w+\s*\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\w.]+)?/g,
    method: 1,
    path: 2,
    handler: 3,
  },
];

const AUTH_HINT =
  /\b(auth|authenticate|authorize|requireAuth|isAuthenticated|ensureAuth|jwt|passport|guard|preHandler|verifyToken|@UseGuards|@PreAuthorize|\[Authorize\]|login_required|permission_classes|IsAuthenticated)\b/i;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function contextWindow(content: string, index: number): string {
  const start = Math.max(0, index - 400);
  return content.slice(start, Math.min(content.length, index + 400));
}

/** Extract HTTP endpoints declared in a file, with an auth-protection hint. */
export function detectRoutes(content: string, language: Language): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const seen = new Set<string>();

  for (const spec of PATTERNS) {
    if (!spec.languages.includes(language)) continue;
    spec.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = spec.pattern.exec(content)) !== null) {
      const rawPath = match[spec.path];
      if (rawPath === undefined) continue;

      let method: string;
      if (spec.method === 'ANY') method = 'ANY';
      else if (spec.method === 'ROUTE_METHODS') {
        const methods = match[2];
        method = methods ? methods.replace(/['"\s]/g, '').toUpperCase() : 'GET';
      } else method = (match[spec.method as number] ?? 'GET').toUpperCase();

      if (method === 'REQUEST') method = 'ANY';
      const routePath = rawPath.startsWith('/') || rawPath === '' ? rawPath || '/' : `/${rawPath}`;
      const line = lineAt(content, match.index);
      const key = `${method} ${routePath}@${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const around = contextWindow(content, match.index);
      routes.push({
        method,
        path: routePath,
        line,
        framework: spec.framework,
        handler: spec.handler ? cleanHandler(match[spec.handler]) : undefined,
        protectedHint: AUTH_HINT.test(around),
      });
      if (routes.length >= 300) return routes;
    }
  }

  return routes.sort((a, b) => a.line - b.line);
}

/**
 * The handler's name, when the route refers to one. An inline callback has no
 * name - scanning into its body just returned the first parameter, so every
 * Fastify route came back as "handled by request()".
 */
function cleanHandler(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^,\s*/, '');
  if (!trimmed || /^(async\b|function\b|\(|\{|\[)/.test(trimmed)) return undefined;
  return trimmed.match(/^([A-Za-z_$][\w$.]*)\s*(?:\)|,|$)/)?.[1];
}

/** Path prefixes that group nothing: every endpoint in the app shares them. */
const GENERIC_PREFIXES = new Set(['api', 'rest', 'graphql', 'v1', 'v2', 'v3', 'internal', 'public']);

/**
 * The segment an endpoint belongs under. Grouping on the first segment alone
 * put all 64 endpoints of an `/api/...` service into a single group, which made
 * the workflow and flow views useless.
 */
export function routeGroup(routePath: string): string {
  const segments = routePath.split('/').filter(Boolean);
  for (const segment of segments) {
    const name = segment.toLowerCase();
    if (GENERIC_PREFIXES.has(name)) continue;
    if (/^[:{*]/.test(segment)) continue;
    return segment;
  }
  return segments[0] ?? 'root';
}
