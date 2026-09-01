import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Connections go through node-postgres rather than the query engine's own
 * socket layer.
 *
 * Prisma's engine connects to the first address `getaddrinfo` returns and stays
 * there. On a host that advertises working IPv6 but cannot actually route it -
 * a common ISP configuration - that is the AAAA record, and every connection
 * hangs until the timeout and is reported as "Can't reach database server",
 * which points at the wrong thing entirely. Node's connector implements Happy
 * Eyeballs (RFC 8305) and falls back to IPv4, so the same URL just connects.
 */
function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: env.LOG_LEVEL === 'debug' ? ['warn', 'error', 'query'] : ['warn', 'error'],
  });
}

export const prisma = global.__prisma ?? createClient();

if (env.NODE_ENV !== 'production') global.__prisma = prisma;

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
