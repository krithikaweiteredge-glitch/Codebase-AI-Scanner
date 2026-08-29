/** Application error taxonomy. Messages here are safe to show to users. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, details?: unknown) => new AppError(m, 400, 'BAD_REQUEST', details);
export const unauthorized = (m = 'Authentication required') => new AppError(m, 401, 'UNAUTHORIZED');
export const forbidden = (m = 'You do not have access to this resource') => new AppError(m, 403, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new AppError(m, 404, 'NOT_FOUND');
export const conflict = (m: string) => new AppError(m, 409, 'CONFLICT');
export const tooLarge = (m: string) => new AppError(m, 413, 'PAYLOAD_TOO_LARGE');
export const rateLimited = (m = 'Too many requests') => new AppError(m, 429, 'RATE_LIMITED');

export const githubAuthFailed = (m = 'GitHub authentication failed. Reconnect your GitHub account.') =>
  new AppError(m, 401, 'GITHUB_AUTH_FAILED');
export const githubUnavailable = (m: string) => new AppError(m, 502, 'GITHUB_UNAVAILABLE');
export const repositoryInaccessible = (m: string) => new AppError(m, 404, 'REPOSITORY_INACCESSIBLE');
export const repositoryTooLarge = (m: string) => new AppError(m, 413, 'REPOSITORY_TOO_LARGE');
export const aiUnavailable = (m: string) => new AppError(m, 503, 'AI_PROVIDER_UNAVAILABLE');
export const invalidAiResponse = (m: string, details?: unknown) =>
  new AppError(m, 502, 'INVALID_AI_RESPONSE', details);
export const embeddingFailed = (m: string) => new AppError(m, 503, 'EMBEDDING_FAILED');
export const analysisTimeout = (m = 'Analysis timed out') => new AppError(m, 504, 'ANALYSIS_TIMEOUT');
export const notIndexed = (m = 'This repository has not been indexed yet. Run an analysis first.') =>
  new AppError(m, 409, 'NOT_INDEXED');
