import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, fetchWithRetry, isRetryableStatus, retryAfterMs, type RetryPolicy } from '../ai/retry';
import { OpenAIProvider } from '../ai/providers/openai';

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseMs: 1000,
  capMs: 8000,
  timeoutMs: 5000,
  // Never actually wait; record what the delay would have been.
  sleepFn: async () => undefined,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Returns the queued responses in order; throws the queued errors. */
function stubFetch(...outcomes: (Response | Error)[]) {
  let call = 0;
  const mock = vi.fn(async () => {
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('retryable status classification', () => {
  it('retries throttling, provider timeouts and 5xx', () => {
    // These clear on their own; asking again is the correct response.
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it('does not retry a request that is simply wrong', () => {
    // A bad key or an unknown model answers identically however often it is
    // asked; retrying only delays the error the caller needs to see.
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially and stops at the cap', () => {
    const noJitter = () => 1;
    expect(backoffMs(1, POLICY, noJitter)).toBe(1000);
    expect(backoffMs(2, POLICY, noJitter)).toBe(2000);
    expect(backoffMs(3, POLICY, noJitter)).toBe(4000);
    expect(backoffMs(9, POLICY, noJitter)).toBe(8000);
  });

  it('jitters between half and full, so parallel requests do not sync up', () => {
    expect(backoffMs(1, POLICY, () => 0)).toBe(500);
    expect(backoffMs(1, POLICY, () => 1)).toBe(1000);
  });
});

describe('Retry-After', () => {
  it('prefers the provider’s own advice over our curve', () => {
    expect(retryAfterMs('2', 30_000)).toBe(2000);
  });

  it('accepts the HTTP-date form', () => {
    const soon = new Date(Date.now() + 3000).toUTCString();
    const delay = retryAfterMs(soon, 30_000)!;
    expect(delay).toBeGreaterThan(1000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  it('never waits longer than the cap, whatever the header claims', () => {
    expect(retryAfterMs('99999', 20_000)).toBe(20_000);
  });

  it('ignores an absent or nonsensical header', () => {
    expect(retryAfterMs(null, 30_000)).toBeNull();
    expect(retryAfterMs('soon-ish', 30_000)).toBeNull();
  });
});

describe('fetchWithRetry', () => {
  it('returns immediately on success', async () => {
    const mock = stubFetch(jsonResponse(200, { ok: true }));

    const result = await fetchWithRetry('https://x.test', {}, POLICY);

    expect(result.attempts).toBe(1);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and returns the eventual success', async () => {
    const mock = stubFetch(jsonResponse(503, { error: 'overloaded' }), jsonResponse(200, { ok: true }));

    const result = await fetchWithRetry('https://x.test', {}, POLICY);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.response?.status).toBe(200);
  });

  it('gives up after maxAttempts and hands back the last response', async () => {
    const mock = stubFetch(jsonResponse(503, { error: 'overloaded' }));

    const result = await fetchWithRetry('https://x.test', {}, POLICY);

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.response?.status).toBe(503);
    expect(result.attempts).toBe(3);
  });

  it('does not retry a 401', async () => {
    const mock = stubFetch(jsonResponse(401, { error: 'bad key' }));

    await fetchWithRetry('https://x.test', {}, POLICY);

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and reports it if it persists', async () => {
    const mock = stubFetch(new Error('ECONNRESET'));

    const result = await fetchWithRetry('https://x.test', {}, POLICY);

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.response).toBeNull();
    expect(result.networkError?.message).toBe('ECONNRESET');
  });

  it('honours maxAttempts of 1 as "do not retry"', async () => {
    const mock = stubFetch(jsonResponse(503, {}));

    await fetchWithRetry('https://x.test', {}, { ...POLICY, maxAttempts: 1 });

    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The failure this exists to prevent
// ---------------------------------------------------------------------------

describe('provider behaviour under load', () => {
  const provider = () =>
    new OpenAIProvider('gemini-3.6-flash', 'test-key', 'https://x.test', 4096, 'gemini', POLICY);

  it('survives the 503 that used to discard a whole review category', async () => {
    // Exactly what happened on the last real run: Gemini answered 503 with
    // "model is currently experiencing high demand", the error propagated out
    // of generateStructured, and the bug review was lost for the entire run.
    stubFetch(
      jsonResponse(503, { error: { message: 'This model is currently experiencing high demand' } }),
      jsonResponse(200, { choices: [{ message: { content: '{"findings":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    );

    const result = await provider().complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('{"findings":[]}');
  });

  it('reports how many attempts it made when it finally fails', async () => {
    stubFetch(jsonResponse(503, { error: { message: 'overloaded' } }));

    await expect(provider().complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /after 3 attempts/,
    );
  });

  it('fails fast on an unrecoverable error rather than burning attempts', async () => {
    const mock = stubFetch(jsonResponse(401, { error: { message: 'invalid api key' } }));

    await expect(provider().complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/401/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
