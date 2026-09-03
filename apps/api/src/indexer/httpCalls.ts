/**
 * Client-side HTTP calls, and how they connect to the routes that serve them.
 *
 * The dependency graph is built from import specifiers, so a React frontend and
 * an Express backend in one repository appear as two islands with nothing
 * between them - `fetch('/api/appointments')` is not an import, and it is
 * usually the single most important relationship in a full-stack repository.
 * These edges are what close that gap.
 */

import type { Language } from './languages';
import type { DetectedRoute } from './apiRoutes';

export interface DetectedHttpCall {
  /** Upper-case verb, or null when the call does not state one. */
  method: string | null;
  /** Request path, normalised: no origin, no query string, interpolation as `:param`. */
  path: string;
  line: number;
}

const CLIENT_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'vue',
  'svelte',
]);

/**
 * `axios.get('/x')`, `api.post('/x')`, `client.delete(...)` - any receiver, so
 * that configured instances are caught as well as the axios default export.
 */
const VERB_CALL = /\b[\w$]+\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+)\2/gi;

/** `fetch('/x')` and `fetch(`/x/${id}`)`, with the verb read from the options object when present. */
const FETCH_CALL = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([^}]{0,200})\})?/gi;

/** `axios({ url: '/x', method: 'post' })` and the same shape passed to fetch. */
const OPTIONS_CALL = /\burl\s*:\s*(['"`])([^'"`]+)\1/gi;

/**
 * A path worth recording: rooted, or absolute with a scheme. Anything else is a
 * relative asset reference, a CSS class or an object key that happens to sit
 * behind a `.get(`.
 */
function isRequestPath(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (value.startsWith('/')) return !value.startsWith('//');
  // `${API_URL}/appointments` - a base URL from configuration, then a path.
  return /^\$\{[^}]*\}\//.test(value);
}

/**
 * Reduces a written path to something comparable with a declared route:
 * drops the origin and query string, and turns every interpolation or dynamic
 * segment into a single `:param` marker.
 */
export function normaliseCallPath(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^https?:\/\/[^/]+/i, '');
  // A leading `${BASE}` is configuration, not part of the path.
  value = value.replace(/^\$\{[^}]*\}/, '');
  value = value.split('?')[0] ?? value;
  value = value.split('#')[0] ?? value;
  value = value.replace(/\$\{[^}]*\}/g, ':param');
  value = value.replace(/\/{2,}/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/** Declared routes use `:id`, `{id}`, `<int:id>` and `*` for the same idea. */
function normaliseRoutePath(raw: string): string {
  let value = raw.trim();
  value = value.split('?')[0] ?? value;
  value = value.replace(/\{[^}]*\}/g, ':param');
  value = value.replace(/<[^>]*>/g, ':param');
  value = value.replace(/:[A-Za-z_][\w]*/g, ':param');
  value = value.replace(/\*+/g, ':param');
  value = value.replace(/\/{2,}/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

/** Every HTTP request this file makes, as far as the source states it. */
export function detectHttpCalls(content: string, language: Language): DetectedHttpCall[] {
  if (!CLIENT_LANGUAGES.has(language)) return [];
  const calls: DetectedHttpCall[] = [];
  const seen = new Set<string>();

  const add = (method: string | null, rawPath: string, index: number) => {
    if (!isRequestPath(rawPath)) return;
    const path = normaliseCallPath(rawPath);
    if (path === '/' || path.length < 2) return;
    const line = lineOf(content, index);
    const key = `${method ?? ''} ${path} ${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ method, path, line });
  };

  for (const match of content.matchAll(VERB_CALL)) {
    add((match[1] ?? '').toUpperCase(), match[3] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(FETCH_CALL)) {
    const options = match[3] ?? '';
    const verb = /method\s*:\s*['"`](\w+)['"`]/i.exec(options)?.[1];
    add(verb ? verb.toUpperCase() : 'GET', match[2] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(OPTIONS_CALL)) {
    add(null, match[2] ?? '', match.index ?? 0);
  }

  return calls.sort((a, b) => a.line - b.line || a.path.localeCompare(b.path));
}

function segmentsMatch(callSegment: string, routeSegment: string): boolean {
  if (routeSegment === ':param' || callSegment === ':param') return true;
  return callSegment.toLowerCase() === routeSegment.toLowerCase();
}

/**
 * Scores a declared route against a call, or returns null when they cannot be
 * the same endpoint.
 *
 * Matching is by suffix on purpose. Express mounts a router under a prefix
 * (`app.use('/api/auth', authRoutes)`), so the file declaring the route says
 * `/login` while the client writes `/api/auth/login`; requiring equality would
 * connect almost nothing in a conventionally organised backend. The score
 * prefers the longest and most literal agreement, so a specific route beats a
 * short one that merely happens to end the same way.
 */
export function scoreRouteMatch(call: DetectedHttpCall, route: DetectedRoute): number | null {
  const callParts = normaliseCallPath(call.path).split('/').filter(Boolean);
  const routeParts = normaliseRoutePath(route.path).split('/').filter(Boolean);
  if (!routeParts.length || routeParts.length > callParts.length) return null;

  const offset = callParts.length - routeParts.length;
  let literals = 0;
  for (let i = 0; i < routeParts.length; i++) {
    const callSegment = callParts[offset + i] ?? '';
    const routeSegment = routeParts[i] ?? '';
    if (!segmentsMatch(callSegment, routeSegment)) return null;
    if (routeSegment !== ':param' && callSegment !== ':param') literals++;
  }
  // A route of only parameters would match any path of the same shape.
  if (literals === 0) return null;

  // A stated verb that disagrees is a different endpoint, not a weaker match.
  if (call.method && route.method && route.method !== 'ALL' && call.method !== route.method.toUpperCase()) return null;

  const verbAgrees = call.method && route.method && call.method === route.method.toUpperCase() ? 1 : 0;
  const exact = offset === 0 ? 1 : 0;
  return literals * 10 + routeParts.length + verbAgrees * 3 + exact * 2;
}

/** The declared route a call most likely reaches, or null when none fits. */
export function matchCallToRoute<T extends DetectedRoute>(call: DetectedHttpCall, routes: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const route of routes) {
    const score = scoreRouteMatch(call, route);
    if (score !== null && score > bestScore) {
      best = route;
      bestScore = score;
    }
  }
  return best;
}
