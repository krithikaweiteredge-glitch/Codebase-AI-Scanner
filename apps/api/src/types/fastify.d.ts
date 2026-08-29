import type { AuthUser } from '../auth/session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export {};
