import * as path from 'node:path';
import { detectRoutes, type DetectedRoute } from './apiRoutes';
import { displayLanguage, type Language } from './languages';

export interface IndexedFileSummary {
  path: string;
  language: Language;
  role: string;
  lineCount: number;
  sizeBytes: number;
  isTest: boolean;
  isConfig: boolean;
  content: string;
  imports: string[];
}

export interface Evidence {
  file: string;
  line?: number;
  detail?: string;
}

export interface DetectedThing {
  name: string;
  evidence: Evidence[];
}

export interface LanguageStat {
  language: string;
  key: Language;
  files: number;
  lines: number;
  bytes: number;
  percent: number;
}

export interface DirectorySummary {
  path: string;
  fileCount: number;
  languages: string[];
  dominantRole: string;
  roles: Record<string, number>;
  importantFiles: string[];
  totalLines: number;
}

export interface StackProfile {
  projectTypes: string[];
  languages: LanguageStat[];
  frameworks: DetectedThing[];
  packageManagers: DetectedThing[];
  testFrameworks: DetectedThing[];
  databases: DetectedThing[];
  externalServices: DetectedThing[];
  authMechanisms: DetectedThing[];
  entryPoints: Evidence[];
  configFiles: string[];
  envVars: { name: string; files: string[] }[];
  routes: (DetectedRoute & { file: string })[];
  directories: DirectorySummary[];
  hasDocker: boolean;
  hasCI: boolean;
  hasTests: boolean;
  monorepo: boolean;
}

interface SignatureRule {
  name: string;
  /** npm/pypi/maven-style dependency names. */
  deps?: string[];
  /** Import specifiers seen in source. */
  imports?: string[];
  /** File path globs (simple substring / suffix match). */
  files?: string[];
  /** Content regex. */
  content?: RegExp;
}

const FRAMEWORKS: SignatureRule[] = [
  { name: 'React', deps: ['react'], imports: ['react'] },
  { name: 'Next.js', deps: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { name: 'Vue', deps: ['vue'], imports: ['vue'] },
  { name: 'Angular', deps: ['@angular/core'] },
  { name: 'Svelte', deps: ['svelte'] },
  { name: 'Express', deps: ['express'], imports: ['express'] },
  { name: 'Fastify', deps: ['fastify'], imports: ['fastify'] },
  { name: 'NestJS', deps: ['@nestjs/core'], imports: ['@nestjs/common'] },
  { name: 'Koa', deps: ['koa'], imports: ['koa'] },
  { name: 'Hapi', deps: ['@hapi/hapi'] },
  { name: 'Django', deps: ['django'], files: ['manage.py'], imports: ['django'] },
  { name: 'Flask', deps: ['flask'], imports: ['flask'] },
  { name: 'FastAPI', deps: ['fastapi'], imports: ['fastapi'] },
  { name: 'Spring Boot', deps: ['spring-boot'], content: /@SpringBootApplication/ },
  { name: 'Gin', imports: ['github.com/gin-gonic/gin'] },
  { name: 'Echo', imports: ['github.com/labstack/echo'] },
  { name: 'Chi', imports: ['github.com/go-chi/chi'] },
  { name: 'ASP.NET Core', content: /Microsoft\.AspNetCore/ },
  { name: 'Ruby on Rails', deps: ['rails'], files: ['config/routes.rb'] },
  { name: 'Laravel', deps: ['laravel/framework'] },
  { name: 'Vite', deps: ['vite'], files: ['vite.config.ts', 'vite.config.js'] },
  { name: 'Tailwind CSS', deps: ['tailwindcss'] },
];

const TEST_FRAMEWORKS: SignatureRule[] = [
  { name: 'Vitest', deps: ['vitest'], files: ['vitest.config.ts', 'vitest.config.js'], imports: ['vitest'] },
  { name: 'Jest', deps: ['jest'], files: ['jest.config.js', 'jest.config.ts'], imports: ['@jest/globals'] },
  { name: 'Mocha', deps: ['mocha'] },
  { name: 'Jasmine', deps: ['jasmine'] },
  { name: 'Playwright', deps: ['@playwright/test'] },
  { name: 'Cypress', deps: ['cypress'] },
  { name: 'Testing Library', deps: ['@testing-library/react'] },
  { name: 'pytest', deps: ['pytest'], imports: ['pytest'] },
  { name: 'unittest', imports: ['unittest'] },
  { name: 'JUnit', deps: ['junit'], imports: ['org.junit'] },
  { name: 'Go testing', imports: ['testing'] },
  { name: 'xUnit', deps: ['xunit'], imports: ['Xunit'] },
  { name: 'NUnit', deps: ['nunit'], imports: ['NUnit.Framework'] },
  { name: 'RSpec', deps: ['rspec'] },
  { name: 'PHPUnit', deps: ['phpunit/phpunit'] },
];

const DATABASES: SignatureRule[] = [
  { name: 'PostgreSQL', deps: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'asyncpg'], content: /postgres(?:ql)?:\/\// },
  { name: 'MySQL', deps: ['mysql', 'mysql2', 'pymysql'], content: /mysql:\/\// },
  { name: 'MongoDB', deps: ['mongodb', 'mongoose', 'pymongo'], content: /mongodb(?:\+srv)?:\/\// },
  { name: 'Redis', deps: ['redis', 'ioredis'], content: /redis:\/\// },
  { name: 'SQLite', deps: ['sqlite3', 'better-sqlite3'] },
  { name: 'Prisma ORM', deps: ['prisma', '@prisma/client'], files: ['schema.prisma'] },
  { name: 'TypeORM', deps: ['typeorm'] },
  { name: 'Sequelize', deps: ['sequelize'] },
  { name: 'Drizzle ORM', deps: ['drizzle-orm'] },
  { name: 'Knex', deps: ['knex'] },
  { name: 'SQLAlchemy', deps: ['sqlalchemy'], imports: ['sqlalchemy'] },
  { name: 'Django ORM', imports: ['django.db'] },
  { name: 'GORM', imports: ['gorm.io/gorm'] },
  { name: 'Hibernate/JPA', imports: ['javax.persistence', 'jakarta.persistence'] },
  { name: 'Entity Framework', imports: ['Microsoft.EntityFrameworkCore'] },
  { name: 'Elasticsearch', deps: ['@elastic/elasticsearch', 'elasticsearch'] },
];

const EXTERNAL_SERVICES: SignatureRule[] = [
  { name: 'AWS S3', deps: ['@aws-sdk/client-s3', 'aws-sdk', 'boto3'], content: /\bs3\.(?:upload|putObject|getObject)|S3Client/ },
  { name: 'AWS (general)', deps: ['aws-sdk', '@aws-sdk/client-sts'], imports: ['boto3'] },
  { name: 'Stripe', deps: ['stripe'], imports: ['stripe'] },
  { name: 'Twilio', deps: ['twilio'] },
  { name: 'SendGrid', deps: ['@sendgrid/mail'] },
  { name: 'Nodemailer', deps: ['nodemailer'] },
  { name: 'Firebase', deps: ['firebase', 'firebase-admin'] },
  { name: 'Kafka', deps: ['kafkajs', 'kafka-python'] },
  { name: 'RabbitMQ', deps: ['amqplib', 'pika'] },
  { name: 'BullMQ', deps: ['bullmq', 'bull'] },
  { name: 'OpenAI', deps: ['openai'], content: /api\.openai\.com/ },
  { name: 'Anthropic', deps: ['@anthropic-ai/sdk'], content: /api\.anthropic\.com/ },
  { name: 'Sentry', deps: ['@sentry/node', '@sentry/react', 'sentry-sdk'] },
  { name: 'Cloudinary', deps: ['cloudinary'] },
  { name: 'Algolia', deps: ['algoliasearch'] },
  { name: 'GitHub API', content: /api\.github\.com/ },
];

const AUTH_MECHANISMS: SignatureRule[] = [
  { name: 'JSON Web Tokens', deps: ['jsonwebtoken', 'jose', 'pyjwt', 'jjwt'], content: /\bjwt\.(sign|verify|decode)\b|JwtService|jsonwebtoken/ },
  { name: 'Passport.js', deps: ['passport'] },
  { name: 'bcrypt password hashing', deps: ['bcrypt', 'bcryptjs'], content: /bcrypt\.(hash|compare)/ },
  { name: 'argon2 password hashing', deps: ['argon2'] },
  { name: 'OAuth 2.0', content: /oauth2?[/_-]?(authorize|token)|login\/oauth\/access_token/i },
  { name: 'Session cookies', content: /express-session|cookie-session|fastify-secure-session|setCookie\(/ },
  { name: 'Auth0', deps: ['@auth0/auth0-react', 'auth0'] },
  { name: 'Clerk', deps: ['@clerk/nextjs', '@clerk/clerk-sdk-node'] },
  { name: 'NextAuth', deps: ['next-auth'] },
  { name: 'Django auth', imports: ['django.contrib.auth'] },
  { name: 'Spring Security', deps: ['spring-boot-starter-security'] },
  { name: 'ASP.NET Identity', imports: ['Microsoft.AspNetCore.Identity'] },
];

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /os\.environ(?:\.get)?\(?\[?['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /ENV\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
];

/** Build the deterministic project map that grounds every AI explanation. */
export function buildStackProfile(files: readonly IndexedFileSummary[]): StackProfile {
  const deps = collectDependencies(files);
  const importSet = new Map<string, string[]>();
  for (const file of files) {
    for (const specifier of file.imports) {
      const list = importSet.get(specifier) ?? [];
      if (list.length < 5) list.push(file.path);
      importSet.set(specifier, list);
    }
  }

  const match = (rules: SignatureRule[]): DetectedThing[] => {
    const out: DetectedThing[] = [];
    for (const rule of rules) {
      const evidence: Evidence[] = [];

      for (const dep of rule.deps ?? []) {
        const hit = deps.get(dep.toLowerCase());
        if (hit) evidence.push({ file: hit.file, detail: `declared dependency "${dep}"${hit.version ? ` (${hit.version})` : ''}` });
      }
      for (const spec of rule.imports ?? []) {
        for (const [specifier, paths] of importSet) {
          if (specifier === spec || specifier.startsWith(`${spec}/`) || specifier.startsWith(`${spec}.`)) {
            for (const p of paths.slice(0, 2)) evidence.push({ file: p, detail: `imports "${specifier}"` });
            break;
          }
        }
      }
      for (const wanted of rule.files ?? []) {
        const hit = files.find((f) => f.path === wanted || f.path.endsWith(`/${wanted}`));
        if (hit) evidence.push({ file: hit.path, detail: 'configuration file present' });
      }
      if (rule.content) {
        for (const file of files) {
          if (file.content.length > 500_000) continue;
          const m = rule.content.exec(file.content);
          rule.content.lastIndex = 0;
          if (m) {
            evidence.push({ file: file.path, line: lineAt(file.content, m.index), detail: 'matched source usage' });
            break;
          }
        }
      }

      if (evidence.length) out.push({ name: rule.name, evidence: evidence.slice(0, 4) });
    }
    return out;
  };

  const languages = languageStats(files);
  const routes: (DetectedRoute & { file: string })[] = [];
  for (const file of files) {
    if (file.isTest) continue;
    for (const route of detectRoutes(file.content, file.language)) {
      routes.push({ ...route, file: file.path });
      if (routes.length >= 500) break;
    }
  }

  const envVars = collectEnvVars(files);
  const frameworks = match(FRAMEWORKS);
  const hasDocker = files.some((f) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(f.path));
  const hasCI = files.some((f) => /^\.github\/workflows\//.test(f.path) || /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml)$/.test(f.path));
  const hasTests = files.some((f) => f.isTest);
  const monorepo =
    files.some((f) => /(^|\/)(pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json)$/.test(f.path)) ||
    files.filter((f) => path.basename(f.path) === 'package.json').length > 2;

  return {
    projectTypes: inferProjectTypes(files, frameworks, routes.length),
    languages,
    frameworks,
    packageManagers: detectPackageManagers(files),
    testFrameworks: match(TEST_FRAMEWORKS),
    databases: match(DATABASES),
    externalServices: match(EXTERNAL_SERVICES),
    authMechanisms: match(AUTH_MECHANISMS),
    entryPoints: detectEntryPoints(files),
    configFiles: files.filter((f) => f.isConfig).map((f) => f.path).slice(0, 80),
    envVars,
    routes,
    directories: summariseDirectories(files),
    hasDocker,
    hasCI,
    hasTests,
    monorepo,
  };
}

function collectDependencies(files: readonly IndexedFileSummary[]): Map<string, { file: string; version?: string }> {
  const out = new Map<string, { file: string; version?: string }>();

  for (const file of files) {
    const base = path.basename(file.path).toLowerCase();

    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(file.content) as Record<string, unknown>;
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
          const block = pkg[section] as Record<string, string> | undefined;
          if (!block) continue;
          for (const [name, version] of Object.entries(block)) {
            if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { file: file.path, version });
          }
        }
      } catch {
        /* malformed manifest - ignore */
      }
    } else if (base === 'requirements.txt' || base === 'pipfile') {
      for (const line of file.content.split('\n')) {
        const name = line.trim().split(/[=<>!~[; ]/)[0];
        if (name && !name.startsWith('#')) out.set(name.toLowerCase(), { file: file.path });
      }
    } else if (base === 'pyproject.toml' || base === 'cargo.toml') {
      for (const m of file.content.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["{]/gm)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
      for (const m of file.content.matchAll(/["']([A-Za-z0-9_.-]+)\s*[><=~^]/g)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
    } else if (base === 'go.mod') {
      for (const m of file.content.matchAll(/^\s+([\w./-]+)\s+v/gm)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
    } else if (base === 'pom.xml') {
      for (const m of file.content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
    } else if (base.startsWith('build.gradle')) {
      for (const m of file.content.matchAll(/['"]([\w.-]+):([\w.-]+):/g)) {
        if (m[2]) out.set(m[2].toLowerCase(), { file: file.path });
      }
    } else if (base === 'gemfile') {
      for (const m of file.content.matchAll(/gem\s+['"]([\w-]+)['"]/g)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
    } else if (base === 'composer.json') {
      try {
        const pkg = JSON.parse(file.content) as { require?: Record<string, string> };
        for (const name of Object.keys(pkg.require ?? {})) out.set(name.toLowerCase(), { file: file.path });
      } catch {
        /* ignore */
      }
    } else if (base.endsWith('.csproj')) {
      for (const m of file.content.matchAll(/PackageReference\s+Include="([^"]+)"/g)) {
        if (m[1]) out.set(m[1].toLowerCase(), { file: file.path });
      }
    }
  }
  return out;
}

function detectPackageManagers(files: readonly IndexedFileSummary[]): DetectedThing[] {
  const rules: { name: string; files: string[] }[] = [
    { name: 'npm', files: ['package-lock.json'] },
    { name: 'yarn', files: ['yarn.lock'] },
    { name: 'pnpm', files: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] },
    { name: 'bun', files: ['bun.lockb'] },
    { name: 'pip', files: ['requirements.txt'] },
    { name: 'poetry', files: ['pyproject.toml', 'poetry.lock'] },
    { name: 'go modules', files: ['go.mod'] },
    { name: 'maven', files: ['pom.xml'] },
    { name: 'gradle', files: ['build.gradle', 'build.gradle.kts'] },
    { name: 'cargo', files: ['Cargo.toml'] },
    { name: 'bundler', files: ['Gemfile'] },
    { name: 'composer', files: ['composer.json'] },
    { name: 'NuGet', files: ['packages.config'] },
  ];

  const out: DetectedThing[] = [];
  for (const rule of rules) {
    const evidence: Evidence[] = [];
    for (const wanted of rule.files) {
      const hit = files.find((f) => f.path === wanted || f.path.endsWith(`/${wanted}`));
      if (hit) evidence.push({ file: hit.path });
    }
    // package.json without a lockfile still implies npm.
    if (rule.name === 'npm' && !evidence.length) {
      const pkg = files.find((f) => f.path === 'package.json');
      if (pkg && !files.some((f) => /(yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(f.path))) {
        evidence.push({ file: pkg.path, detail: 'package.json present' });
      }
    }
    if (evidence.length) out.push({ name: rule.name, evidence });
  }
  return out;
}

function detectEntryPoints(files: readonly IndexedFileSummary[]): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();

  const add = (file: string, detail: string, line?: number) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, detail, ...(line ? { line } : {}) });
  };

  for (const file of files) {
    if (path.basename(file.path) !== 'package.json') continue;
    try {
      const pkg = JSON.parse(file.content) as { main?: string; scripts?: Record<string, string> };
      const dir = path.posix.dirname(file.path) === '.' ? '' : `${path.posix.dirname(file.path)}/`;
      if (pkg.main) {
        const target = files.find((f) => f.path === `${dir}${pkg.main!.replace(/^\.\//, '')}`);
        if (target) add(target.path, 'package.json "main"');
      }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!/^(start|dev|serve)$/.test(name)) continue;
        const m = command.match(/([\w./-]+\.(?:ts|js|mjs|cjs))/);
        const candidate = m?.[1];
        if (!candidate) continue;
        const target = files.find((f) => f.path === `${dir}${candidate.replace(/^\.\//, '')}` || f.path.endsWith(`/${candidate}`));
        if (target) add(target.path, `package.json script "${name}"`);
      }
    } catch {
      /* ignore */
    }
  }

  const CONVENTIONAL = [
    /^(src\/)?(index|main|server|app)\.(ts|js|mjs|tsx|jsx)$/,
    /^(src\/)?main\.py$/,
    /^manage\.py$/,
    /^(cmd\/[^/]+\/)?main\.go$/,
    /^(src\/)?Program\.cs$/,
    /Application\.java$/,
    /^(src\/)?main\.rs$/,
  ];
  for (const file of files) {
    if (CONVENTIONAL.some((re) => re.test(file.path))) add(file.path, 'conventional entry-point path');
  }

  for (const file of files) {
    if (/\b(app|server)\.listen\s*\(|\.listen\s*\(\s*(?:port|PORT|\d)/.test(file.content)) {
      const m = file.content.match(/\.listen\s*\(/);
      add(file.path, 'starts an HTTP server', m ? lineAt(file.content, file.content.indexOf('.listen(')) : undefined);
    }
    if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(file.content)) add(file.path, 'python __main__ guard');
    if (/^func\s+main\s*\(\s*\)/m.test(file.content)) add(file.path, 'go main()');
    if (/(public\s+)?static\s+void\s+[Mm]ain\s*\(/.test(file.content)) add(file.path, 'static main()');
  }

  return out.slice(0, 20);
}

function collectEnvVars(files: readonly IndexedFileSummary[]): { name: string; files: string[] }[] {
  const map = new Map<string, Set<string>>();
  for (const file of files) {
    if (file.content.length > 400_000) continue;
    for (const pattern of ENV_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        const name = match[1];
        if (!name || name.length < 2) continue;
        const set = map.get(name) ?? new Set<string>();
        if (set.size < 6) set.add(file.path);
        map.set(name, set);
      }
    }
    // .env.example files enumerate the contract explicitly.
    if (/(^|\/)\.env\.(example|sample|template)$/.test(file.path)) {
      for (const line of file.content.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
        if (m?.[1]) {
          const set = map.get(m[1]) ?? new Set<string>();
          set.add(file.path);
          map.set(m[1], set);
        }
      }
    }
  }
  return [...map.entries()]
    .map(([name, set]) => ({ name, files: [...set] }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

function languageStats(files: readonly IndexedFileSummary[]): LanguageStat[] {
  const map = new Map<Language, { files: number; lines: number; bytes: number }>();
  for (const file of files) {
    const entry = map.get(file.language) ?? { files: 0, lines: 0, bytes: 0 };
    entry.files++;
    entry.lines += file.lineCount;
    entry.bytes += file.sizeBytes;
    map.set(file.language, entry);
  }
  const totalBytes = [...map.values()].reduce((sum, v) => sum + v.bytes, 0) || 1;
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      language: displayLanguage(key),
      files: value.files,
      lines: value.lines,
      bytes: value.bytes,
      percent: Math.round((value.bytes / totalBytes) * 1000) / 10,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

function summariseDirectories(files: readonly IndexedFileSummary[]): DirectorySummary[] {
  const map = new Map<string, IndexedFileSummary[]>();
  for (const file of files) {
    const dir = path.posix.dirname(file.path);
    const key = dir === '.' ? '/' : dir;
    const list = map.get(key) ?? [];
    list.push(file);
    map.set(key, list);
  }

  const out: DirectorySummary[] = [];
  for (const [dir, contents] of map) {
    const roles: Record<string, number> = {};
    const languages = new Set<string>();
    let totalLines = 0;
    for (const file of contents) {
      roles[file.role] = (roles[file.role] ?? 0) + 1;
      languages.add(displayLanguage(file.language));
      totalLines += file.lineCount;
    }
    const dominantRole =
      Object.entries(roles)
        .filter(([role]) => role !== 'unknown')
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

    out.push({
      path: dir,
      fileCount: contents.length,
      languages: [...languages].slice(0, 6),
      dominantRole,
      roles,
      totalLines,
      importantFiles: [...contents]
        .sort((a, b) => b.lineCount - a.lineCount)
        .slice(0, 6)
        .map((f) => f.path),
    });
  }

  return out.sort((a, b) => b.fileCount - a.fileCount).slice(0, 120);
}

function inferProjectTypes(
  files: readonly IndexedFileSummary[],
  frameworks: DetectedThing[],
  routeCount: number,
): string[] {
  const names = new Set(frameworks.map((f) => f.name));
  const types: string[] = [];

  if (routeCount > 0 || names.has('Express') || names.has('Fastify') || names.has('NestJS') || names.has('FastAPI') || names.has('Flask') || names.has('Django') || names.has('Spring Boot') || names.has('ASP.NET Core')) {
    types.push('backend-api');
  }
  if (names.has('React') || names.has('Vue') || names.has('Angular') || names.has('Svelte') || names.has('Next.js')) {
    types.push('frontend-web');
  }
  if (files.some((f) => /(^|\/)(cli|bin)\//.test(f.path))) types.push('cli');
  if (files.some((f) => /(^|\/)(workers?|jobs?|consumers?)\//.test(f.path))) types.push('background-worker');
  if (files.some((f) => f.path === 'package.json' && /"private"\s*:\s*false/.test(f.content))) types.push('library');
  if (!types.length) types.push('unclassified');
  return types;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}
