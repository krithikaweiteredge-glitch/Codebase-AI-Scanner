/**
 * Unit tests run without a database or network. Environment variables the
 * config loader requires are set here so importing modules is safe.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-long-enough-1234';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.AI_PROVIDER ??= 'local';
process.env.EMBEDDING_PROVIDER ??= 'local';
// Route tests build the real Fastify app; keep its request logging out of the output.
process.env.LOG_LEVEL ??= 'fatal';
