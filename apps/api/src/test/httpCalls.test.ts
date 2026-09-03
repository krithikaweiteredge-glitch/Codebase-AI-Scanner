import { describe, expect, it } from 'vitest';
import type { DetectedRoute } from '../indexer/apiRoutes';
import { detectHttpCalls, matchCallToRoute, normaliseCallPath, scoreRouteMatch } from '../indexer/httpCalls';

const route = (method: string, path: string): DetectedRoute => ({
  method,
  path,
  line: 1,
  framework: 'express',
  protectedHint: false,
});

describe('detecting client HTTP calls', () => {
  it('finds axios calls on the default export and on a configured instance', () => {
    const calls = detectHttpCalls(
      ['axios.get("/api/dentists");', 'api.post("/api/appointments", body);', 'client.delete(`/api/users/${id}`);'].join(
        '\n',
      ),
      'javascript',
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/dentists',
      'POST /api/appointments',
      'DELETE /api/users/:param',
    ]);
  });

  it('reads the verb out of a fetch options object, defaulting to GET', () => {
    const calls = detectHttpCalls(
      ['fetch("/api/me");', 'fetch("/api/login", { method: "POST", body });'].join('\n'),
      'javascript',
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('ignores map.get and other lookups that are not requests', () => {
    // The receiver is unconstrained on purpose, so the path has to disqualify these.
    const calls = detectHttpCalls(
      ['cache.get("user-42");', 'styles.get("primary");', 'params.get("q");'].join('\n'),
      'javascript',
    );
    expect(calls).toEqual([]);
  });

  it('strips the origin, the base-url variable and the query string', () => {
    expect(normaliseCallPath('https://api.example.com/api/users?page=2')).toBe('/api/users');
    expect(normaliseCallPath('${API_URL}/appointments/')).toBe('/appointments');
    expect(normaliseCallPath('/api/users/${userId}/visits')).toBe('/api/users/:param/visits');
  });

  it('does not scan server-side languages for client calls', () => {
    expect(detectHttpCalls('axios.get("/api/x")', 'python')).toEqual([]);
  });
});

describe('matching a call to the route that serves it', () => {
  const routes = [
    route('POST', '/login'),
    route('POST', '/register'),
    route('GET', '/'),
    route('GET', '/:id'),
    route('GET', '/api/dentists'),
  ];

  it('matches through an Express mount prefix the route file cannot see', () => {
    // authRoutes.js declares "/login"; the client writes "/api/auth/login".
    const [call] = detectHttpCalls('axios.post("/api/auth/login", form);', 'javascript');
    expect(matchCallToRoute(call!, routes)?.path).toBe('/login');
  });

  it('prefers the more specific route when several could fit', () => {
    const [call] = detectHttpCalls('axios.get("/api/dentists");', 'javascript');
    expect(matchCallToRoute(call!, routes)?.path).toBe('/api/dentists');
  });

  it('refuses a route whose verb disagrees', () => {
    const [call] = detectHttpCalls('axios.get("/api/auth/login");', 'javascript');
    expect(matchCallToRoute(call!, routes)).toBeNull();
  });

  it('refuses a route made only of parameters, which would match anything', () => {
    const call = { method: 'GET', path: '/api/anything', line: 1 };
    expect(scoreRouteMatch(call, route('GET', '/:id'))).toBeNull();
  });

  it('treats a path parameter as equivalent to the call that fills it', () => {
    const [call] = detectHttpCalls('axios.get(`/api/appointments/${id}`);', 'javascript');
    expect(matchCallToRoute(call!, [route('GET', '/api/appointments/:appointmentId')])?.path).toBe(
      '/api/appointments/:appointmentId',
    );
  });

  it('returns null when nothing serves the path', () => {
    const [call] = detectHttpCalls('axios.get("/api/unknown/thing");', 'javascript');
    expect(matchCallToRoute(call!, routes)).toBeNull();
  });
});

describe('the diagram distinguishes a network call from an import', () => {
  it('draws an HTTP edge dashed and labels it', async () => {
    const { deterministicMermaid } = await import('../analyzers/architecture');
    const stack = { directories: [], externalServices: [], databases: [] } as never;
    const graph = {
      nodes: [
        { id: 'f1', path: 'frontend/src/api.js', role: 'util', language: 'javascript', loc: 20, fanIn: 0, fanOut: 1 },
        { id: 'f2', path: 'frontend/src/App.js', role: 'component', language: 'javascript', loc: 30, fanIn: 0, fanOut: 1 },
        { id: 'b1', path: 'backend/routes/authRoutes.js', role: 'route', language: 'javascript', loc: 40, fanIn: 1, fanOut: 0 },
        { id: 'b2', path: 'backend/routes/dentistRoutes.js', role: 'route', language: 'javascript', loc: 40, fanIn: 1, fanOut: 0 },
      ],
      edges: [
        { from: 'f1', to: 'b1', specifier: 'POST /api/auth/login', kind: 'http' },
        { from: 'f2', to: 'b2', specifier: 'GET /api/dentists', kind: 'http' },
      ],
      externals: [],
      cycles: [],
      hotspots: [],
    } as never;

    const mermaid = deterministicMermaid(stack, graph);
    expect(mermaid).toContain('-.->');
    expect(mermaid).toContain('HTTP');
    // The two halves are no longer disconnected islands.
    expect(mermaid).toMatch(/frontend\/src/);
    expect(mermaid).toMatch(/backend\/routes/);
  });
});
