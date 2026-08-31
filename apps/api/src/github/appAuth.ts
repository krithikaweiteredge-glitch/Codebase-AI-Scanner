import crypto from 'node:crypto';
import { env } from '../env';
import { AppError } from '../errors';

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalizePrivateKey(rawKey: string): string {
  let key = rawKey.trim();
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  // Support escaped newlines \n in env strings
  key = key.replace(/\\n/g, '\n');
  return key;
}

/**
 * Generates an RS256 JWT authenticating as the GitHub App.
 * Uses native node:crypto with no external runtime dependencies.
 */
export function getAppJwt(): string {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new AppError('GitHub App is not configured on this server.', 500, 'GITHUB_APP_NOT_CONFIGURED');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60 seconds in the past for clock drift
    exp: now + 540, // 9 minutes expiration (GitHub allows max 10m)
    iss: env.GITHUB_APP_ID,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  const signature = signer.sign(normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY));
  const encodedSignature = base64UrlEncode(signature);

  return `${message}.${encodedSignature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Returns a valid, short-lived Installation Access Token for an installed account.
 * Automatically caches and refreshes before the 1-hour expiration.
 */
export async function getInstallationAccessToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 120_000) {
    return cached.token;
  }

  const appJwt = getAppJwt();
  const url = `${env.GITHUB_API_URL.replace(/\/$/, '')}/app/installations/${installationId}/access_tokens`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codebase-ai-platform',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError(
      `Failed to generate installation token for installation ${installationId}: ${text}`,
      response.status === 404 ? 404 : 502,
      'GITHUB_APP_TOKEN_ERROR',
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

export interface GitHubInstallationInfo {
  id: number;
  account: {
    login: string;
    type: string;
    avatar_url: string;
  };
  repository_selection: 'all' | 'selected';
  html_url: string;
  app_id: number;
}

/**
 * Fetches installation details directly from GitHub API using the App JWT.
 */
export async function getInstallationInfo(installationId: string): Promise<GitHubInstallationInfo> {
  const appJwt = getAppJwt();
  const url = `${env.GITHUB_API_URL.replace(/\/$/, '')}/app/installations/${installationId}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codebase-ai-platform',
    },
  });

  if (!response.ok) {
    throw new AppError(
      `GitHub installation not found (${installationId})`,
      response.status === 404 ? 404 : 502,
      'GITHUB_INSTALLATION_NOT_FOUND',
    );
  }

  return (await response.json()) as GitHubInstallationInfo;
}

/**
 * Verifies an incoming webhook HMAC SHA-256 signature from GitHub.
 */
export function verifyWebhookSignature(payload: string | Buffer, signature: string | undefined): boolean {
  // Fail closed. Without a secret there is no way to tell a real delivery from
  // a forged one, and this endpoint mutates state - returning true here meant
  // anyone on the internet could post a synthetic "installation deleted" event
  // and unlink another user's GitHub account.
  if (!env.GITHUB_WEBHOOK_SECRET) return false;
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', env.GITHUB_WEBHOOK_SECRET);
  // Must hash the bytes GitHub actually signed. Re-serialising a parsed body
  // is not guaranteed to reproduce them.
  hmac.update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
  const expected = `sha256=${hmac.digest('hex')}`;

  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
