import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Load .env from the repo root (and apps/api/.env) without extra dependencies. */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadDotEnv();

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: intFromEnv(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  GITHUB_CLIENT_ID: z.string().optional().default(''),
  GITHUB_CLIENT_SECRET: z.string().optional().default(''),
  GITHUB_CALLBACK_URL: z.string().default('http://localhost:4000/api/github/callback'),
  GITHUB_API_URL: z.string().default('https://api.github.com'),

  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_APP_SLUG: z.string().optional().default(''),
  GITHUB_APP_CLIENT_ID: z.string().optional().default(''),
  GITHUB_APP_CLIENT_SECRET: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),

  AI_PROVIDER: z.enum(['anthropic', 'openai', 'groq', 'gemini', 'local']).default('local'),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_BASE_URL: z.string().optional().default(''),
  AI_MAX_OUTPUT_TOKENS: intFromEnv(4096),

  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('local'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_API_KEY: z.string().optional().default(''),

  MAX_REPO_FILES: intFromEnv(6000),
  MAX_FILE_BYTES: intFromEnv(400_000),
  MAX_TOTAL_BYTES: intFromEnv(200_000_000),
  INDEX_CONCURRENCY: intFromEnv(8),
  CONTEXT_TOKEN_BUDGET: intFromEnv(12_000),

  REDIS_URL: z.string().optional().default(''),
  WORKER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean()),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const githubOAuthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
export const githubAppConfigured = Boolean(
  env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_SLUG,
);
export const EMBEDDING_DIMENSIONS = 1536;
