/**
 * HTTP-boundary tests.
 *
 * Everything else in this suite exercises pure functions. These go through the
 * real Fastify instance - real routing, real preHandlers, real Zod parsing,
 * real error handler - with only the database faked, because the properties
 * worth protecting live in that wiring: that a route without a session is
 * refused, and that one user can never read or write another user's
 * repository. Those are correct today; the point of these tests is that they
 * stay correct through the next refactor.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A hand-rolled Prisma double. Hoisted because `vi.mock` factories run before
 * imports, and shared by reference so each test can rewrite `state` directly.
 */
const mocked = vi.hoisted(() => {
  interface Row {
    [key: string]: unknown;
  }

  const state = {
    users: [] as Row[],
    sessions: [] as Row[],
    repositories: [] as Row[],
    findings: [] as Row[],
    /** Records reads of finding data, to prove a refused request never got there. */
    findingQueries: 0,
    /** Counts installation unlinks, to prove a forged webhook never causes one. */
    installationsDeleted: 0,
  };

  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value === null || typeof value !== 'object') return row[key] === value;
      // Only the operators these routes actually use.
      const clause = value as { in?: unknown[] };
      if (Array.isArray(clause.in)) return clause.in.includes(row[key]);
      return true;
    });
  };

  const prisma = {
    $queryRawUnsafe: async (sql: string) => (sql.includes('pg_extension') ? [{ installed: true }] : [{ '?column?': 1 }]),

    user: {
      findUnique: async ({ where }: { where: Row }) =>
        state.users.find((u) => matches(u, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `user-${state.users.length + 1}`, githubLogin: null, githubTokenEnc: null, ...data };
        state.users.push(row);
        return row;
      },
    },

    session: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const session = state.sessions.find((s) => matches(s, where));
        if (!session) return null;
        if (!include?.user) return session;
        return { ...session, user: state.users.find((u) => u.id === session.userId) ?? null };
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `session-${state.sessions.length + 1}`, createdAt: new Date(), ...data };
        state.sessions.push(row);
        return row;
      },
      findMany: async ({ where }: { where?: Row }) => state.sessions.filter((s) => matches(s, where)),
      delete: async ({ where }: { where: Row }) => {
        const index = state.sessions.findIndex((s) => matches(s, where));
        if (index >= 0) state.sessions.splice(index, 1);
        return {};
      },
      deleteMany: async ({ where }: { where?: Row }) => {
        const kept = state.sessions.filter((s) => !matches(s, where));
        const removed = state.sessions.length - kept.length;
        state.sessions = kept;
        return { count: removed };
      },
    },

    repository: {
      findUnique: async ({ where }: { where: Row }) => state.repositories.find((r) => matches(r, where)) ?? null,
    },

    gitHubInstallation: {
      deleteMany: async () => {
        state.installationsDeleted++;
        return { count: 1 };
      },
    },

    analysisFinding: {
      findMany: async ({ where }: { where?: Row }) => {
        state.findingQueries++;
        return state.findings.filter((f) => matches(f, where));
      },
      count: async ({ where }: { where?: Row }) => {
        state.findingQueries++;
        return state.findings.filter((f) => matches(f, where)).length;
      },
      groupBy: async () => {
        state.findingQueries++;
        return [];
      },
      findFirst: async ({ where }: { where?: Row }) => {
        state.findingQueries++;
        return state.findings.find((f) => matches(f, where)) ?? null;
      },
      update: async ({ data }: { data: Row }) => {
        state.findingQueries++;
        return { id: 'finding-1', ...data };
      },
    },
  };

  return { state, prisma };
});

vi.mock('../db', () => ({ prisma: mocked.prisma }));

// Safe as static imports: vitest hoists the `vi.mock` above them, so `../app`
// already sees the fake database by the time it is evaluated.
import { buildApp } from '../app';
import { sha256 } from '../lib/crypto';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const REPO_A = '33333333-3333-4333-8333-333333333333';
const REPO_B = '44444444-4444-4444-8444-444444444444';
const FINDING = '55555555-5555-4555-8555-555555555555';
const MISSING_REPO = '66666666-6666-4666-8666-666666666666';

const TOKEN_A = 'token-for-user-a';
const TOKEN_B = 'token-for-user-b';

let app: FastifyInstance;

/** Builds the cookie header a browser would send for a given session token. */
function session(token: string): Record<string, string> {
  return { cookie: `cbai_session=${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  const { state } = mocked;

  state.users = [
    { id: USER_A, email: 'a@example.test', name: 'A', passwordHash: '', githubLogin: null, githubTokenEnc: null },
    { id: USER_B, email: 'b@example.test', name: 'B', passwordHash: '', githubLogin: null, githubTokenEnc: null },
  ];
  state.sessions = [
    { id: 's-a', userId: USER_A, tokenHash: sha256(TOKEN_A), expiresAt: new Date(Date.now() + 86_400_000) },
    { id: 's-b', userId: USER_B, tokenHash: sha256(TOKEN_B), expiresAt: new Date(Date.now() + 86_400_000) },
  ];
  state.repositories = [
    { id: REPO_A, userId: USER_A, fullName: 'a/repo', owner: 'a', name: 'repo' },
    { id: REPO_B, userId: USER_B, fullName: 'b/repo', owner: 'b', name: 'repo' },
  ];
  state.findings = [];
  state.findingQueries = 0;
  state.installationsDeleted = 0;
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe('public routes', () => {
  it('serves health without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', pgvector: 'installed' });
  });

  it('answers /api/auth/me anonymously rather than refusing it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null });
  });

  it('returns a structured 404 for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  /** Every route here changes or exposes user data and must never be anonymous. */
  const protectedRoutes: [string, string][] = [
    ['GET', `/api/repositories`],
    ['GET', `/api/repositories/${REPO_A}`],
    ['GET', `/api/repositories/${REPO_A}/findings`],
    ['GET', `/api/repositories/${REPO_A}/security`],
    ['GET', `/api/repositories/${REPO_A}/files`],
    ['GET', `/api/repositories/${REPO_A}/runs`],
    ['GET', `/api/repositories/${REPO_A}/dashboard`],
    ['GET', `/api/findings/summary`],
    ['GET', `/api/auth/sessions`],
    ['POST', `/api/repositories`],
    ['POST', `/api/repositories/${REPO_A}/analyze`],
    ['PATCH', `/api/repositories/${REPO_A}`],
    ['DELETE', `/api/repositories/${REPO_A}`],
    ['DELETE', `/api/auth/account`],
  ];

  it.each(protectedRoutes)('refuses %s %s without a session', async (method, url) => {
    const response = await app.inject({ method: method as 'GET', url });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('refuses a session token that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_A}/findings`,
      headers: session('not-a-real-token'),
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an expired session and clears it away', async () => {
    mocked.state.sessions = [
      { id: 's-old', userId: USER_A, tokenHash: sha256(TOKEN_A), expiresAt: new Date(Date.now() - 1000) },
    ];

    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_A}/findings`,
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(401);
    // An expired row is not left behind to be checked again on every request.
    expect(mocked.state.sessions).toHaveLength(0);
  });

  it('accepts a valid session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: session(TOKEN_A) });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: USER_A, email: 'a@example.test' });
  });
});

// ---------------------------------------------------------------------------
// The ownership boundary
// ---------------------------------------------------------------------------

describe('repository ownership', () => {
  it('lets a user read their own repository findings', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_A}/findings`,
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('findings');
  });

  it('refuses a read of another user\'s repository, and never queries its data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_B}/findings`,
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    // The authorisation check must come before any data access, so a refusal
    // cannot leak row counts or timing about someone else's repository.
    expect(mocked.state.findingQueries).toBe(0);
  });

  it('refuses a write to another user\'s repository', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${REPO_B}/findings/${FINDING}`,
      headers: session(TOKEN_A),
      payload: { resolved: true },
    });

    expect(response.statusCode).toBe(403);
    expect(mocked.state.findingQueries).toBe(0);
  });

  it.each([
    ['GET', `/api/repositories/${REPO_B}`],
    ['GET', `/api/repositories/${REPO_B}/security`],
    ['GET', `/api/repositories/${REPO_B}/files`],
    ['GET', `/api/repositories/${REPO_B}/runs`],
    ['GET', `/api/repositories/${REPO_B}/dependencies`],
    ['PATCH', `/api/repositories/${REPO_B}`],
    ['DELETE', `/api/repositories/${REPO_B}`],
    ['POST', `/api/repositories/${REPO_B}/analyze`],
  ])('refuses %s %s across the ownership boundary', async (method, url) => {
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: session(TOKEN_A),
      ...(method === 'PATCH' || method === 'POST' ? { payload: {} } : {}),
    });

    expect(response.statusCode).toBe(403);
  });

  it('reports a repository that does not exist as 404, not 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${MISSING_REPO}/findings`,
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('request validation', () => {
  it('rejects a repository id that is not a uuid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/repositories/not-a-uuid/findings',
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().error.details).toBeInstanceOf(Array);
  });

  it('rejects out-of-range paging instead of trusting it', async () => {
    const tooMany = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_A}/findings?limit=5000`,
      headers: session(TOKEN_A),
    });
    const negative = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_A}/findings?offset=-1`,
      headers: session(TOKEN_A),
    });

    expect(tooMany.statusCode).toBe(400);
    expect(negative.statusCode).toBe(400);
  });

  it('rejects a registration with a weak password or bad email', async () => {
    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'new@example.test', password: 'short' },
    });
    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'a-good-password' },
    });

    expect(shortPassword.statusCode).toBe(400);
    expect(badEmail.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Session cookie handling
// ---------------------------------------------------------------------------

describe('session cookies', () => {
  it('issues an httpOnly session cookie on register', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'fresh@example.test', password: 'a-good-password' },
    });

    expect(response.statusCode).toBe(201);

    const cookie = response.cookies.find((c) => c.name === 'cbai_session');
    expect(cookie).toBeDefined();
    // Not readable from JavaScript, so XSS cannot lift the session.
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.path).toBe('/');
    expect(cookie!.value).not.toBe('');
  });

  it('does not reveal whether an email exists when login fails', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@example.test', password: 'wrong-password' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    // Identical responses, so the endpoint cannot be used to enumerate accounts.
    expect(wrongPassword.json().error.message).toBe(noSuchUser.json().error.message);
  });

  it('refuses to register an email that already exists', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.test', password: 'a-good-password' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('destroys the session on logout', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: session(TOKEN_A),
    });

    expect(response.statusCode).toBe(200);
    expect(mocked.state.sessions.some((s) => s.tokenHash === sha256(TOKEN_A))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub webhook
// ---------------------------------------------------------------------------

describe('github webhook', () => {
  const forgedDeletion = {
    action: 'deleted',
    installation: { id: '99999' },
  };

  it('refuses unsigned deliveries when no secret is configured', async () => {
    // GITHUB_WEBHOOK_SECRET is unset in the test env, which is exactly the
    // state production was in. This used to return 200 and act on the payload.
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'x-github-event': 'installation', 'content-type': 'application/json' },
      payload: forgedDeletion,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/not configured/i);
  });

  it('does not act on a forged installation-deleted event', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'x-github-event': 'installation', 'content-type': 'application/json' },
      payload: forgedDeletion,
    });

    // The whole point: an unauthenticated POST must not be able to unlink
    // somebody else's GitHub account.
    expect(mocked.state.installationsDeleted).toBe(0);
  });

  it('rejects a signature that does not match', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'x-github-event': 'installation',
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
      payload: forgedDeletion,
    });

    // 503 (no secret configured) or 401 (bad signature) - never 200.
    expect([401, 503]).toContain(response.statusCode);
    expect(mocked.state.installationsDeleted).toBe(0);
  });
});
