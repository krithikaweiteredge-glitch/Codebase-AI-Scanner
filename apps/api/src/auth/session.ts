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

/** Fastify preHandler: populates request.user or throws 401. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = await resolveUser(token);
  if (!user) throw unauthorized();
  request.user = user;
}

/** Optional auth: populates request.user when a valid session exists. */
export async function attachUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = await resolveUser(request.cookies[SESSION_COOKIE]);
  if (user) request.user = user;
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export const sessionTtlDays = SESSION_TTL_DAYS;
export const sessionSecretConfigured = env.SESSION_SECRET.length >= 32;
