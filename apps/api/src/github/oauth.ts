import { prisma } from '../db';
import { env, githubOAuthConfigured } from '../env';
import { AppError, badRequest, githubAuthFailed } from '../errors';
import { randomToken } from '../lib/crypto';

const OAUTH_SCOPES = 'read:user user:email repo';

export function assertOAuthConfigured(): void {
  if (!githubOAuthConfigured) {
    throw new AppError(
      'GitHub OAuth is not configured on this server. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, ' +
        'or connect a Personal Access Token instead.',
      501,
      'GITHUB_OAUTH_NOT_CONFIGURED',
    );
  }
}

export async function beginOAuth(userId: string, redirect?: string): Promise<string> {
  assertOAuthConfigured();
  const state = randomToken(24);
  await prisma.oAuthState.create({
    data: {
      state,
      userId,
      redirect: redirect ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.GITHUB_CALLBACK_URL);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function consumeOAuthState(state: string): Promise<{ userId: string; redirect: string | null }> {
  const record = await prisma.oAuthState.findUnique({ where: { state } });
  if (!record) throw badRequest('Invalid or already-used OAuth state');
  await prisma.oAuthState.delete({ where: { id: record.id } }).catch(() => undefined);
  if (record.expiresAt.getTime() < Date.now()) throw badRequest('OAuth request expired, please try again');
  return { userId: record.userId, redirect: record.redirect };
}

export async function exchangeCodeForToken(code: string): Promise<{ token: string; scopes: string[] }> {
  assertOAuthConfigured();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_CALLBACK_URL,
    }),
  });

  if (!response.ok) throw githubAuthFailed('GitHub rejected the OAuth code exchange');
  const payload = (await response.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!payload.access_token) {
    throw githubAuthFailed(payload.error_description ?? 'GitHub did not return an access token');
  }
  return {
    token: payload.access_token,
    scopes: (payload.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
