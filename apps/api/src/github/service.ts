import { prisma } from '../db';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { AppError } from '../errors';
import { GitHubClient } from './client';
import { getInstallationAccessToken, getInstallationInfo } from './appAuth';

/** Builds an authenticated GitHub client for an installation ID using GitHub App tokens. */
export async function githubClientForInstallation(installationId: string): Promise<GitHubClient> {
  const token = await getInstallationAccessToken(installationId);
  return new GitHubClient(token);
}

/** Builds an authenticated GitHub client for a repository (prefers App installation, falls back to user token). */
export async function githubClientForRepository(repositoryId: string, userId: string): Promise<GitHubClient> {
  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
    select: { installationId: true },
  });

  if (repo?.installationId) {
    try {
      return await githubClientForInstallation(repo.installationId);
    } catch {
      // Fallback to user token if installation token generation fails
    }
  }

  return githubClientForUser(userId);
}

/** Builds an authenticated GitHub client for a user, checking App installations and personal tokens. */
export async function githubClientForUser(userId: string, installationId?: string): Promise<GitHubClient> {
  if (installationId) {
    return githubClientForInstallation(installationId);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      githubTokenEnc: true,
      installations: { take: 1, orderBy: { updatedAt: 'desc' } },
    },
  });

  if (user?.githubTokenEnc) {
    return new GitHubClient(decryptSecret(user.githubTokenEnc));
  }

  const firstInstallation = user?.installations?.[0];
  if (firstInstallation) {
    return githubClientForInstallation(firstInstallation.installationId);
  }

  throw new AppError(
    'No GitHub account is connected. Install the GitHub App or connect GitHub from Settings before importing repositories.',
    412,
    'GITHUB_NOT_CONNECTED',
  );
}

export async function hasGitHubToken(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      githubTokenEnc: true,
      installations: { take: 1 },
    },
  });
  return Boolean(user?.githubTokenEnc || (user?.installations && user.installations.length > 0));
}

/** Records or updates a GitHub App installation for a user. */
export async function saveGitHubInstallation(userId: string, installationId: string) {
  const info = await getInstallationInfo(installationId);

  const installation = await prisma.gitHubInstallation.upsert({
    where: { installationId: String(info.id) },
    create: {
      userId,
      installationId: String(info.id),
      accountLogin: info.account.login,
      accountType: info.account.type,
      accountAvatar: info.account.avatar_url,
      repositorySelection: info.repository_selection,
    },
    update: {
      userId,
      accountLogin: info.account.login,
      accountType: info.account.type,
      accountAvatar: info.account.avatar_url,
      repositorySelection: info.repository_selection,
      updatedAt: new Date(),
    },
  });

  return installation;
}

export async function listUserInstallations(userId: string) {
  return prisma.gitHubInstallation.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deleteGitHubInstallation(userId: string, installationId: string): Promise<void> {
  await prisma.gitHubInstallation.deleteMany({
    where: { userId, installationId },
  });
}

/** Verifies the token against the GitHub API before persisting it (encrypted). */
export async function storeGitHubToken(userId: string, token: string, scopes: string[] = []) {
  const client = new GitHubClient(token);
  const ghUser = await client.getUser();
  const resolvedScopes = scopes.length ? scopes : await client.getTokenScopes().catch(() => []);

  await prisma.user.update({
    where: { id: userId },
    data: {
      githubLogin: ghUser.login,
      githubUserId: String(ghUser.id),
      githubTokenEnc: encryptSecret(token),
      githubTokenScope: resolvedScopes.join(','),
      githubLinkedAt: new Date(),
      avatarUrl: ghUser.avatar_url,
    },
  });

  return { login: ghUser.login, avatarUrl: ghUser.avatar_url, scopes: resolvedScopes };
}

export async function disconnectGitHub(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { githubTokenEnc: null, githubTokenScope: null, githubLinkedAt: null },
  });
  await prisma.gitHubInstallation.deleteMany({
    where: { userId },
  });
}
