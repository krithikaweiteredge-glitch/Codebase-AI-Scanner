import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { env, isProd } from '../env';
import { randomToken, sha256 } from '../lib/crypto';
import { unauthorized } from '../errors';

export const SESSION_COOKIE = 'cbai_session';
const SESSION_TTL_DAYS = 14;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  githubLogin: string | null;
  githubLinked: boolean;
}

/**
 * How long a token issued for automation lives.
 *
 * Longer than a browser session because a pipeline cannot re-authenticate,
 * and still finite because a credential that never expires is one nobody ever
 * rotates.
 */
const CI_TOKEN_TTL_DAYS = 365;

/** Marks the session as belonging to automation, so it is recognisable in the list. */
export const CI_TOKEN_AGENT = 'ci-token';

/**
 * Issues a long-lived token for a pipeline. The raw value is returned once and
 * never stored - only its hash is - so a lost token is replaced rather than
 * recovered, and revoking it is deleting the session like any other.
 */
export async function createApiToken(userId: string, label?: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + CI_TOKEN_TTL_DAYS * 86_400_000);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: `${CI_TOKEN_AGENT}:${(label ?? 'unnamed').slice(0, 60)}`,
    },
  });
  return { token, expiresAt };
}

export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await prisma.session.create({
    data: { userId, tokenHash: sha256(token), expiresAt, userAgent: userAgent?.slice(0, 255) ?? null },
  });
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_DAYS * 86_400,
    signed: false,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  });
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function resolveUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    githubLogin: session.user.githubLogin,
    githubLinked: Boolean(session.user.githubTokenEnc),
  };
}

/**
 * The credential on the request, from either transport.
 *
 * The browser sends a cookie. A CI job cannot - it has no browser and no
 * origin - so it sends the same token as a bearer header instead. One session
 * row backs both, which means revoking a CI token is the same operation as
 * signing a device out, with no second credential system to keep correct.
 */
function credentialFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  return request.cookies[SESSION_COOKIE];
}

/** Fastify preHandler: populates request.user or throws 401. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = credentialFrom(request);
  const user = await resolveUser(token);
  if (!user) throw unauthorized();
  request.user = user;
}

/** Optional auth: populates request.user when a valid session exists. */
export async function attachUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = await resolveUser(credentialFrom(request));
  if (user) request.user = user;
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export const sessionTtlDays = SESSION_TTL_DAYS;
export const sessionSecretConfigured = env.SESSION_SECRET.length >= 32;
