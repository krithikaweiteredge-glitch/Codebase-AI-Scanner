import { PrismaClient } from '@prisma/client';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.LOG_LEVEL === 'debug' ? ['warn', 'error', 'query'] : ['warn', 'error'],
  });

if (env.NODE_ENV !== 'production') global.__prisma = prisma;

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
