/**
 * Retry and timeout for AI provider requests.
 *
 * Model endpoints are the flakiest dependency this service has - far more so
 * than GitHub or the database - and until now they were the only one with no
 * retry at all. A single 503 from a busy model propagated out of
 * `generateStructured`, and the engine discarded that entire review category
 * while still reporting the run as completed. A third of the AI coverage could
 * vanish silently whenever the provider was under load.
 *
 * There was no timeout either, so a hung connection blocked an analysis
 * indefinitely.
 */

import { env } from '../env';
import { sleep } from '../lib/pool';

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  timeoutMs: number;
  /** Test seam, so the suite never waits on real backoff. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Statuses worth trying again.
 *
 * 429 and 5xx are transient by nature: rate limiting clears, and an overloaded
 * model recovers. 408 is the provider's own timeout. Everything else - a bad
 * key, a malformed request, an unknown model - returns identically no matter
 * how often it is asked, so retrying only delays the error.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Honours `Retry-After` when the provider sends one, since it knows better
 * than our backoff curve does. Both the seconds form and the HTTP-date form
 * are accepted; anything absurd is ignored rather than trusted.
 */
export function retryAfterMs(header: string | null, capMs: number): number | null {
  if (!header) return null;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, capMs);
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    if (delta > 0) return Math.min(delta, capMs);
  }

  return null;
}

/**
 * Exponential backoff with jitter. Jitter matters here because a repository
 * scan fires several requests in quick succession: without it they all back
 * off in lockstep and hit the recovering model together.
 */
export function backoffMs(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const exponential = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export interface AttemptOutcome {
  response: Response | null;
  /** Set when the request never produced a response at all. */
  networkError: Error | null;
  attempts: number;
}

/**
 * Issues the request, retrying transient failures. Returns the final outcome
 * rather than throwing, so each provider keeps its own error wording.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  policy: RetryPolicy,
): Promise<AttemptOutcome> {
  const pause = policy.sleepFn ?? sleep;
  const attemptsAllowed = Math.max(1, policy.maxAttempts);

  let lastNetworkError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) });
      lastNetworkError = null;
    } catch (error) {
      lastNetworkError = error as Error;
    }

    if (response) {
      lastResponse = response;
      if (!isRetryableStatus(response.status)) {
        return { response, networkError: null, attempts: attempt };
      }
    }

    if (attempt === attemptsAllowed) break;

    const suggested = response ? retryAfterMs(response.headers.get('retry-after'), policy.capMs) : null;
    await pause(suggested ?? backoffMs(attempt, policy));
  }

  return { response: lastResponse, networkError: lastNetworkError, attempts: attemptsAllowed };
}

/** Policy assembled from configuration, used unless a caller overrides it. */
export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: env.AI_MAX_ATTEMPTS,
    baseMs: env.AI_RETRY_BASE_MS,
    capMs: env.AI_RETRY_CAP_MS,
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  };
}
