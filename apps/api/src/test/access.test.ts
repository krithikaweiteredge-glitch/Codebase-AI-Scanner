import { describe, expect, it, vi } from 'vitest';

/**
 * The tenancy boundary. `loadRepository` is the single check standing between
 * one account and another's indexed source, findings, chat history and tokens,
 * and it had no test of its own - so a refactor that dropped the ownership
 * comparison would have been caught by nothing. Worth noting that this is the
 * exact bug class (CWE-639) the project's own benchmark records as
 * undetectable by any of its rules.
 */

const repositories: { id: string; userId: string }[] = [];
const branches: { id: string; repositoryId: string; name: string; isDefault: boolean; indexedSha: string | null; indexedAt: Date | null; createdAt: Date }[] = [];

vi.mock('../db', () => ({
  prisma: {
    repository: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        repositories.find((r) => r.id === where.id) ?? null,
    },
    repositoryBranch: {
      findUnique: async ({ where }: { where: { repositoryId_name: { repositoryId: string; name: string } } }) =>
        branches.find(
          (b) => b.repositoryId === where.repositoryId_name.repositoryId && b.name === where.repositoryId_name.name,
        ) ?? null,
      findFirst: async ({ where }: { where: { repositoryId: string; indexedSha?: unknown } }) => {
        let rows = branches.filter((b) => b.repositoryId === where.repositoryId);
        if (where.indexedSha) rows = rows.filter((b) => b.indexedSha !== null);
        return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))[0] ?? null;
      },
    },
  },
}));

import { loadRepository, resolveBranch } from '../lib/access';

const reset = () => {
  repositories.length = 0;
  branches.length = 0;
};

describe('repository ownership', () => {
  it('returns the repository to the account that connected it', async () => {
    reset();
    repositories.push({ id: 'repo-1', userId: 'alice' });
    await expect(loadRepository('alice', 'repo-1')).resolves.toMatchObject({ id: 'repo-1' });
  });

  it('refuses another account, and does not leak that it exists as a 404', async () => {
    reset();
    repositories.push({ id: 'repo-1', userId: 'alice' });
    await expect(loadRepository('mallory', 'repo-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('reports a missing repository as not found', async () => {
    reset();
    await expect(loadRepository('alice', 'repo-missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not treat a falsy or empty user id as a match', async () => {
    reset();
    repositories.push({ id: 'repo-1', userId: '' });
    await expect(loadRepository('', 'repo-1')).resolves.toBeTruthy();
    await expect(loadRepository('alice', 'repo-1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('branch resolution', () => {
  const branch = (over: Partial<(typeof branches)[number]>) => ({
    id: 'b',
    repositoryId: 'repo-1',
    name: 'main',
    isDefault: false,
    indexedSha: null,
    indexedAt: null,
    createdAt: new Date(),
    ...over,
  });

  it('will not hand back a branch from a different repository', async () => {
    reset();
    branches.push(branch({ id: 'other', repositoryId: 'repo-2', name: 'main' }));
    await expect(resolveBranch('repo-1', 'main')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('prefers an indexed branch when none is named', async () => {
    reset();
    branches.push(branch({ id: 'stale', name: 'old' }));
    branches.push(branch({ id: 'fresh', name: 'main', indexedSha: 'abc', isDefault: true }));
    await expect(resolveBranch('repo-1')).resolves.toMatchObject({ id: 'fresh' });
  });

  it('says so when the repository has no branches at all', async () => {
    reset();
    await expect(resolveBranch('repo-1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('every repository-scoped route is guarded', () => {
  /**
   * A structural check rather than a behavioural one. `loadRepository` is only
   * protective where it is actually called, and the cost of forgetting it on a
   * new route is one account reading another's source. A test that reads the
   * route files catches that at the moment the route is written, which no
   * amount of testing the guard itself can do.
   */
  it('calls loadRepository, directly or through a helper that does', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, '..', 'routes');

    const unguarded: string[] = [];
    let examined = 0;
    for (const fileName of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(dir, fileName), 'utf8');

      // Helpers in this file that guard on the caller's behalf, so a route
      // delegating to one is covered.
      const guardedHelpers = [...source.matchAll(/const (\w+)\s*=\s*async\s*\(/g)]
        .map((m) => m[1] as string)
        .filter((name) => {
          const start = source.indexOf(`const ${name}`);
          return source.slice(start, start + 2000).includes('loadRepository');
        });

      // Each registration owns the text up to the next one.
      const registrations = [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/g)];
      registrations.forEach((match, index) => {
        const routePath = match[2] ?? '';
        if (!/^\/api\/repositories\/:id/.test(routePath)) return;
        examined++;
        const from = match.index ?? 0;
        const to = registrations[index + 1]?.index ?? source.length;
        const body = source.slice(from, to);
        const guarded =
          body.includes('loadRepository') || guardedHelpers.some((helper) => body.includes(`${helper}(`));
        if (!guarded) unguarded.push(`${fileName} ${match[1]?.toUpperCase()} ${routePath}`);
      });
    }

    expect(unguarded).toEqual([]);
    // A structural test that matches nothing passes forever. If the route
    // registration style changes this fails loudly instead of going quiet.
    expect(examined).toBeGreaterThan(25);
  });
});
