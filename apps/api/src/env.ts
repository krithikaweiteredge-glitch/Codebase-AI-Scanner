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

// Render, Heroku and similar hosts inject the port to bind on as PORT and route
// external traffic to it. Honour that unless API_PORT was set explicitly.
if (!process.env.API_PORT && process.env.PORT) {
  process.env.API_PORT = process.env.PORT;
}

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

  /**
   * Retry and timeout for model requests. Providers are the flakiest
   * dependency here - a busy model returns 503 and, without this, the engine
   * discarded a whole review category while still reporting success.
   * AI_MAX_ATTEMPTS of 1 disables retrying.
   */
  AI_MAX_ATTEMPTS: intFromEnv(3),
  AI_RETRY_BASE_MS: intFromEnv(1500),
  AI_RETRY_CAP_MS: intFromEnv(20_000),
  AI_REQUEST_TIMEOUT_MS: intFromEnv(120_000),

  /**
   * Two-stage AI review. Stage one sweeps a compact digest of every file with
   * a cheap model and scores what deserves a real read; stage two reads the
   * winners in full. Without it, file selection is blind to any file that no
   * static rule flagged and no directory role favours.
   *
   * AI_TRIAGE_MODEL should be the cheapest usable model on the same provider
   * (gemini-3.6-flash, gpt-5-mini, claude-haiku-4-5-20251001). Empty reuses
   * AI_MODEL, which works but removes the cost advantage.
   */
  AI_TRIAGE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean()),
  AI_TRIAGE_MODEL: z.string().optional().default(''),
  AI_TRIAGE_BATCH_FILES: intFromEnv(40),
  AI_TRIAGE_MAX_FILES: intFromEnv(1500),

  /** Files the deep review may read, and how they are grouped into requests. */
  AI_MAX_REVIEW_FILES: intFromEnv(90),
  AI_REVIEW_BATCH_FILES: intFromEnv(15),
  AI_BATCHES_PER_CATEGORY: intFromEnv(4),

  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('local'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_API_KEY: z.string().optional().default(''),
  /**
   * Any OpenAI-compatible embeddings endpoint. Gemini serves one on the free
   * tier, so real semantic embeddings need no paid account:
   *   EMBEDDING_PROVIDER=openai
   *   EMBEDDING_MODEL=gemini-embedding-001
   *   EMBEDDING_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   * Empty means api.openai.com.
   */
  EMBEDDING_BASE_URL: z.string().optional().default(''),
  /**
   * Inputs per embedding request. Gemini's free tier rejects batches much
   * above 32 with a 429 regardless of payload size; OpenAI tolerates far more.
   */
  EMBEDDING_BATCH_SIZE: intFromEnv(32),

  // Software composition analysis against OSV.dev. The API is public and
  // unauthenticated, so this needs no key; set SCA_ENABLED=false to opt out of
  // the outbound requests entirely.
  SCA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean()),
  OSV_API_URL: z.string().default('https://api.osv.dev'),

  // Dataflow analysis via semgrep. Enabled by default but skipped
  // automatically when the binary is absent, which is the case on hosts that
  // run the plain Node runtime rather than the project's Docker image.
  SEMGREP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean()),
  SEMGREP_PATH: z.string().default('semgrep'),
  /**
   * Comma-separated rulesets. The default unions the low-noise baseline with
   * the OWASP set and the infrastructure packs - Dockerfiles, CI workflows,
   * Terraform and Kubernetes manifests are all indexed already, and were
   * previously scanned by nothing. `p/security-audit` finds more again, at a
   * materially higher false-positive rate; add it when you have the appetite.
   */
  SEMGREP_CONFIG: z
    .string()
    .default('p/default,p/owasp-top-ten,p/secrets,p/dockerfile,p/github-actions,p/terraform,p/kubernetes'),
  SEMGREP_TIMEOUT_MS: intFromEnv(300_000),
  SEMGREP_RULE_TIMEOUT_SECONDS: intFromEnv(30),
  SEMGREP_JOBS: intFromEnv(1),
  SEMGREP_MAX_FILES: intFromEnv(3000),
  SEMGREP_MAX_TOTAL_BYTES: intFromEnv(50_000_000),

  /**
   * How many commits back to scan for secrets that were committed and later
   * removed. Costs one GitHub API call per commit, so it is bounded; 0
   * disables history scanning entirely.
   */
  SECRET_HISTORY_COMMITS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 100 : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(0).max(1000)),

  MAX_REPO_FILES: intFromEnv(6000),
  MAX_FILE_BYTES: intFromEnv(400_000),
  MAX_TOTAL_BYTES: intFromEnv(200_000_000),
  INDEX_CONCURRENCY: intFromEnv(8),
  CONTEXT_TOKEN_BUDGET: intFromEnv(12_000),

  REDIS_URL: z.string().optional().default(''),

  /**
   * Whether this process actually runs queued jobs. With the in-process queue
   * there is nowhere else for them to go, so the API must keep this on; it
   * exists for the day a shared queue backend lets a separate worker take over.
   */
  WORKER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false')
    .pipe(z.boolean()),
  /** Tries per job, including the first. 1 disables retries. */
  JOB_MAX_ATTEMPTS: intFromEnv(3),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';

/**
 * WEB_ORIGIN may hold a comma separated allow list for CORS (e.g. a Vercel
 * production domain plus preview domains). Redirects need a single origin,
 * so the first entry is treated as the canonical one.
 */
export const webOrigins = env.WEB_ORIGIN.split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
export const primaryWebOrigin = webOrigins[0] ?? 'http://localhost:5173';
export const githubOAuthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
export const githubAppConfigured = Boolean(
  env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_SLUG,
);
export const EMBEDDING_DIMENSIONS = 1536;
