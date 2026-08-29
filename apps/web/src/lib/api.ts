export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/**
 * Thin API client. The session lives in an httpOnly cookie, so every request
 * just needs `credentials: 'include'` - no token ever reaches JavaScript.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (options.raw) {
    if (!response.ok) throw await toError(response);
    return (await response.text()) as unknown as T;
  }

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.details,
    );
  }

  return payload as T;
}

async function toError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  const payload = text ? safeParse(text) : null;
  const error = (payload as { error?: { message?: string; code?: string } } | null)?.error;
  return new ApiError(error?.message ?? `Request failed (${response.status})`, response.status, error?.code ?? 'UNKNOWN');
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
