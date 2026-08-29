import { prisma } from '../db';
import { forbidden, notFound } from '../errors';

/**
 * Repository-level access control: a repository is only reachable by the user
 * who connected it. Every repository-scoped route funnels through here.
 */
export async function loadRepository(userId: string, repositoryId: string) {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repository) throw notFound('Repository not found');
  if (repository.userId !== userId) throw forbidden('You do not have access to this repository');
  return repository;
}

export async function resolveBranch(repositoryId: string, branchName?: string) {
  if (branchName) {
    const branch = await prisma.repositoryBranch.findUnique({
      where: { repositoryId_name: { repositoryId, name: branchName } },
    });
    if (!branch) throw notFound(`Branch "${branchName}" is not indexed for this repository`);
    return branch;
  }
  const indexed = await prisma.repositoryBranch.findFirst({
    where: { repositoryId, indexedSha: { not: null } },
    orderBy: [{ isDefault: 'desc' }, { indexedAt: 'desc' }],
  });
  if (indexed) return indexed;
  const fallback = await prisma.repositoryBranch.findFirst({
    where: { repositoryId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  if (!fallback) throw notFound('No branches are registered for this repository');
  return fallback;
}
