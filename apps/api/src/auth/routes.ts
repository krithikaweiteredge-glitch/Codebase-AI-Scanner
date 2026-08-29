import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { badRequest, conflict, unauthorized } from '../errors';
import {
  SESSION_COOKIE,
  attachUser,
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
} from './session';

const credentials = z.object({
  email: z.string().email('A valid email address is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(120).optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    const body = credentials.parse(request.body);
    const email = body.email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict('An account with that email already exists');

    const user = await prisma.user.create({
      data: { email, name: body.name ?? null, passwordHash: hashPassword(body.password) },
    });

    const token = await createSession(user.id, request.headers['user-agent']);
    setSessionCookie(reply, token);
    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: user.name, githubLogin: null, githubLinked: false },
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = credentials.omit({ name: true }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    // Constant-ish response regardless of which half failed.
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw unauthorized('Invalid email or password');
    }
    const token = await createSession(user.id, request.headers['user-agent']);
    setSessionCookie(reply, token);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        githubLogin: user.githubLogin,
        githubLinked: Boolean(user.githubTokenEnc),
      },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: attachUser }, async (request) => {
    if (!request.user) return { user: null };
    return { user: request.user };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (request) => {
    const sessions = await prisma.session.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, createdAt: true, expiresAt: true },
    });
    return { sessions };
  });

  app.delete('/api/auth/account', { preHandler: requireAuth }, async (request, reply) => {
    const confirm = z.object({ email: z.string() }).safeParse(request.body);
    if (!confirm.success || confirm.data.email.toLowerCase() !== request.user!.email) {
      throw badRequest('Confirm deletion by sending your account email address');
    }
    await prisma.user.delete({ where: { id: request.user!.id } });
    clearSessionCookie(reply);
    return { ok: true };
  });
}
