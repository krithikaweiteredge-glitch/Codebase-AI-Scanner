import { env, isProd } from './env';

/**
 * Structured logging config shared by the HTTP server and the worker.
 * Redaction keys make it impossible to accidentally log GitHub tokens,
 * cookies, API keys or passwords.
 */
export const loggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'githubToken',
      'token',
      'accessToken',
      'password',
      'apiKey',
      'AI_API_KEY',
      'GITHUB_CLIENT_SECRET',
      '*.password',
      '*.token',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
};
