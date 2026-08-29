import { describe, expect, it } from 'vitest';
import { chunkFile } from '../indexer/chunker';
import { buildIgnoreMatcher } from '../indexer/ignore';
import { detectRole, detectLanguage, isTestFile } from '../indexer/languages';
import { detectRoutes } from '../indexer/apiRoutes';
import { parseFile } from '../indexer/parsers';
import { detectSecrets, redactSecrets, shannonEntropy } from '../indexer/secrets';

const TS_SOURCE = `import { Router } from 'express';
import { UserRepository } from '../repositories/UserRepository';

export interface LoginInput {
  email: string;
  password: string;
}

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  async login(input: LoginInput): Promise<string> {
    const user = await this.users.findByEmail(input.email);
    if (!user) {
      throw new Error('Unknown user');
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new Error('Invalid password');
    }
    return signToken(user.id);
  }
}

export const buildRouter = () => {
  const router = Router();
  router.post('/auth/login', async (req, res) => {
    res.json(await service.login(req.body));
  });
  return router;
};
`;

describe('language + role detection', () => {
  it('maps extensions to languages', () => {
    expect(detectLanguage('src/AuthService.ts')).toBe('typescript');
    expect(detectLanguage('src/App.tsx')).toBe('tsx');
    expect(detectLanguage('api/main.py')).toBe('python');
    expect(detectLanguage('cmd/server/main.go')).toBe('go');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
  });

  it('recognises test files by path and by filename', () => {
    expect(isTestFile('src/__tests__/auth.ts')).toBe(true);
    expect(isTestFile('src/auth.test.ts')).toBe(true);
    expect(isTestFile('tests/test_login.py')).toBe(true);
    expect(isTestFile('src/auth.ts')).toBe(false);
  });

  it('assigns architectural roles from conventions', () => {
    expect(detectRole('src/services/AuthService.ts', TS_SOURCE).role).toBe('service');
    expect(detectRole('src/repositories/UserRepository.ts', '').role).toBe('repository');
    expect(detectRole('src/middleware/auth.ts', '').role).toBe('middleware');
    expect(detectRole('src/routes/authRoutes.ts', '').role).toBe('route');
  });
});

describe('ignore patterns', () => {
  const matcher = buildIgnoreMatcher(['docs/**']);

  it('ignores dependency, build and secret paths', () => {
    expect(matcher.ignores('node_modules/react/index.js')).toBe(true);
    expect(matcher.ignores('dist/main.js')).toBe(true);
    expect(matcher.ignores('.env')).toBe(true);
    expect(matcher.ignores('.env.production')).toBe(true);
    expect(matcher.ignores('package-lock.json')).toBe(true);
    expect(matcher.ignores('assets/logo.png')).toBe(true);
  });

  it('honours repository-specific overrides and keeps source files', () => {
    expect(matcher.ignores('docs/guide.md')).toBe(true);
    expect(matcher.ignores('src/auth/AuthService.ts')).toBe(false);
  });
});

describe('TypeScript AST parsing', () => {
  const parsed = parseFile('src/services/AuthService.ts', TS_SOURCE, 'typescript');

  it('extracts classes, methods, interfaces and arrow functions', () => {
    const names = parsed.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('class:AuthService');
    expect(names).toContain('method:login');
    expect(names).toContain('interface:LoginInput');
    expect(names).toContain('function:buildRouter');
  });

  it('records accurate line ranges', () => {
    const login = parsed.symbols.find((s) => s.name === 'login');
    expect(login).toBeDefined();
    const lines = TS_SOURCE.split('\n');
    expect(lines[login!.startLine - 1]).toContain('async login');
    expect(login!.endLine).toBeGreaterThan(login!.startLine);
    expect(login!.isAsync).toBe(true);
  });

  it('captures imports with relative/external classification', () => {
    const specifiers = parsed.imports.map((i) => i.specifier);
    expect(specifiers).toContain('express');
    expect(specifiers).toContain('../repositories/UserRepository');
    expect(parsed.imports.find((i) => i.specifier === 'express')?.isRelative).toBe(false);
    expect(parsed.imports.find((i) => i.specifier.startsWith('..'))?.isRelative).toBe(true);
  });
});

describe('non-TypeScript language adapters', () => {
  it('parses python classes and functions with indentation-based ranges', () => {
    const source = [
      'import os',
      'from flask import Flask',
      '',
      'class UserService:',
      '    def __init__(self, repo):',
      '        self.repo = repo',
      '',
      '    async def create_user(self, email):',
      '        if not email:',
      '            raise ValueError("email required")',
      '        return self.repo.save(email)',
      '',
      'def helper():',
      '    return 1',
    ].join('\n');

    const parsed = parseFile('app/services.py', source, 'python');
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('create_user');
    expect(names).toContain('helper');

    const createUser = parsed.symbols.find((s) => s.name === 'create_user')!;
    expect(createUser.startLine).toBe(8);
    expect(createUser.endLine).toBe(11);
    expect(createUser.isAsync).toBe(true);
    expect(parsed.imports.map((i) => i.specifier)).toContain('flask');
  });

  it('parses go functions and structs', () => {
    const source = [
      'package main',
      '',
      'import "net/http"',
      '',
      'type Server struct {',
      '\tport int',
      '}',
      '',
      'func NewServer(port int) *Server {',
      '\treturn &Server{port: port}',
      '}',
    ].join('\n');

    const parsed = parseFile('main.go', source, 'go');
    expect(parsed.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['Server', 'NewServer']));
    expect(parsed.imports.map((i) => i.specifier)).toContain('net/http');
  });
});

describe('semantic chunking', () => {
  it('produces one chunk per symbol and covers module-level code', () => {
    const parsed = parseFile('src/services/AuthService.ts', TS_SOURCE, 'typescript');
    const chunks = chunkFile({ filePath: 'src/services/AuthService.ts', content: TS_SOURCE, symbols: parsed.symbols });

    expect(chunks.length).toBeGreaterThan(1);
    // The import header is not covered by any symbol; it must still be indexed.
    expect(chunks.some((chunk) => chunk.startLine === 1)).toBe(true);
  });

  it('keeps chunk content byte-identical to the cited line range', () => {
    const parsed = parseFile('src/services/AuthService.ts', TS_SOURCE, 'typescript');
    const chunks = chunkFile({ filePath: 'src/services/AuthService.ts', content: TS_SOURCE, symbols: parsed.symbols });
    const lines = TS_SOURCE.split('\n');

    for (const chunk of chunks) {
      const expected = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
      expect(chunk.content).toBe(expected);
    }
  });

  it('splits oversized symbols into overlapping windows', () => {
    const body = Array.from({ length: 500 }, (_, i) => `  const value${i} = ${i};`).join('\n');
    const source = `export function huge() {\n${body}\n}\n`;
    const chunks = chunkFile({
      filePath: 'src/huge.ts',
      content: source,
      symbols: [
        { name: 'huge', kind: 'function', startLine: 1, endLine: 502, exported: true, isAsync: false, complexity: 1 },
      ],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.endLine - chunk.startLine + 1 <= 220)).toBe(true);
  });
});

describe('route detection', () => {
  it('finds express routes with auth hints', () => {
    const source = [
      "router.post('/auth/login', async (req, res) => {});",
      "router.get('/users/:id', requireAuth, async (req, res) => {});",
      "router.delete('/users/:id', async (req, res) => {});",
    ].join('\n');

    const routes = detectRoutes(source, 'typescript');
    expect(routes).toHaveLength(3);
    expect(routes[0]).toMatchObject({ method: 'POST', path: '/auth/login' });
    expect(routes[1]?.protectedHint).toBe(true);
  });

  it('finds FastAPI routes', () => {
    const source = ['@app.get("/orders")', 'async def list_orders():', '    return []'].join('\n');
    const routes = detectRoutes(source, 'python');
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/orders', handler: 'list_orders' });
  });
});

describe('secret detection and redaction', () => {
  it('detects real-looking credentials and ignores placeholders', () => {
    const source = [
      'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
      'const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";',
      'const password = "changeme";',
      'const apiKey = process.env.API_KEY;',
    ].join('\n');

    const found = detectSecrets(source);
    const rules = found.map((f) => f.ruleId);
    expect(rules).toContain('secret.aws_access_key_id');
    expect(rules).toContain('secret.github_token');
    // Placeholders and env lookups are not credentials.
    expect(found.every((f) => !f.preview.includes('changeme'))).toBe(true);
  });

  it('never exposes the raw secret in the match preview', () => {
    const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const found = detectSecrets(`const t = "${secret}";`);
    expect(found).toHaveLength(1);
    expect(found[0]!.preview).not.toContain(secret);
    expect(found[0]!.preview).toContain('*');
  });

  it('redacts secrets before any content can be sent to a model', () => {
    const source = 'const key = "AKIAIOSFODNN7EXAMPLE";\nconst db = "postgres://user:hunter2@db:5432/app";';
    const { content, redactions } = redactSecrets(source);
    expect(redactions).toBeGreaterThanOrEqual(2);
    expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(content).not.toContain('hunter2');
    expect(content).toContain('[REDACTED_SECRET]');
  });

  it('computes entropy used to suppress low-entropy false positives', () => {
    expect(shannonEntropy('aaaaaaaa')).toBeLessThan(1);
    expect(shannonEntropy('A1b2C3d4E5f6G7h8')).toBeGreaterThan(3);
  });
});
