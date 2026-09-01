import { describe, expect, it } from 'vitest';
import { deterministicMermaid, deterministicNarrative, type DependencyGraph } from '../analyzers/architecture';
import { deterministicSection } from '../analyzers/documentation';
import { detectRoutes, routeGroup } from '../indexer/apiRoutes';
import { buildIgnoreMatcher } from '../indexer/ignore';
import { detectRole } from '../indexer/languages';
import { buildStackProfile, normaliseStackProfile, pickDominantRole, type IndexedFileSummary } from '../indexer/projectMap';
import { buildRepositoryOverview } from '../search/context';

function file(path: string, content: string, extra: Partial<IndexedFileSummary> = {}): IndexedFileSummary {
  return {
    path,
    language: path.endsWith('.json') ? 'json' : path.endsWith('.yml') ? 'yaml' : 'typescript',
    role: 'unknown',
    lineCount: content.split('\n').length,
    sizeBytes: content.length,
    isTest: false,
    isConfig: /\.(json|ya?ml|toml)$|(^|\/)\.env\./.test(path),
    content,
    imports: [],
    ...extra,
  };
}

const ROOT_PACKAGE = JSON.stringify({
  name: 'demo',
  engines: { node: '>=20.11' },
  scripts: { dev: 'vite', build: 'tsc -b', test: 'vitest run' },
});

describe('role detection', () => {
  it('does not treat an "api" workspace directory as a routing directory', () => {
    // apps/api is a package name; labelling every file under it "route"
    // collapsed the whole architecture view into a single layer.
    expect(detectRole('apps/api/src/analyzers/engine.ts', 'export const x = 1;').role).not.toBe('route');
    expect(detectRole('packages/api/src/lib/text.ts', 'export const x = 1;').role).toBe('util');
    expect(detectRole('services/api/src/github/client.ts', 'export const x = 1;').role).toBe('service');
  });

  it('still recognises genuine routing directories', () => {
    expect(detectRole('apps/api/src/routes/chat.ts', 'export const x = 1;').role).toBe('route');
    expect(detectRole('src/pages/api/login.ts', 'export const x = 1;').role).toBe('route');
    expect(detectRole('src/controllers/UserController.ts', 'export const x = 1;').role).toBe('controller');
  });

  it('separates process entry points from re-export barrels', () => {
    expect(detectRole('src/index.ts', 'app.listen({ port: 3000 });').role).toBe('entrypoint');
    expect(detectRole('src/main.tsx', 'ReactDOM.createRoot(el).render(<App />);').role).toBe('entrypoint');
    expect(detectRole('src/parsers/index.ts', "export { a } from './a';\nexport { b } from './b';").role).toBe('barrel');
  });
});

describe('ignore rules', () => {
  const matcher = buildIgnoreMatcher();

  it('never indexes a real dotenv file', () => {
    for (const path of ['.env', '.env.local', '.env.production', 'apps/api/.env', '.env.backup-123']) {
      expect(matcher.ignores(path)).toBe(true);
    }
  });

  it('does index the committed dotenv templates, which hold names and no values', () => {
    for (const path of ['.env.example', '.env.sample', 'config/.env.template', 'apps/api/.env.example']) {
      expect(matcher.ignores(path)).toBe(false);
    }
  });
});

describe('build facts', () => {
  const files = [
    file('package.json', ROOT_PACKAGE),
    file('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n"),
    file('Dockerfile', 'FROM node:20\n'),
    file('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n'),
    file('.github/workflows/ci.yml', 'name: ci\n'),
    file('.env.example', 'DATABASE_URL=\nAPI_PORT=4000\n'),
    file('src/index.ts', 'app.listen({ port: 4000 });'),
  ];
  const stack = buildStackProfile(files);

  it('reads the pinned runtime out of the manifest', () => {
    expect(stack.runtimes).toContainEqual({ name: 'Node.js', version: '>=20.11', file: 'package.json' });
  });

  it('reads the declared scripts, not just the manifest name', () => {
    expect(stack.scripts.map((s) => s.name).sort()).toEqual(['build', 'dev', 'test']);
    expect(stack.scripts.find((s) => s.name === 'build')?.command).toBe('tsc -b');
  });

  it('picks the package manager the repository actually declares', () => {
    // Lockfiles are never indexed, so pnpm must be inferred from the workspace
    // file; matching on pnpm-lock.yaml always missed and reported npm.
    expect(stack.packageManagers.map((p) => p.name)).toContain('pnpm');
    expect(stack.scripts.every((s) => s.runner === 'pnpm run')).toBe(true);
  });

  it('lists docker and CI files rather than only a boolean', () => {
    expect(stack.dockerFiles).toEqual(['Dockerfile', 'docker-compose.yml']);
    expect(stack.ciFiles).toEqual(['.github/workflows/ci.yml']);
    expect(stack.hasDocker).toBe(true);
    expect(stack.hasCI).toBe(true);
  });

  it('writes an installation section a newcomer can follow without an AI provider', () => {
    const section = deterministicSection('installation', stack, 'demo/repo');
    expect(section.contentMd).toContain('pnpm install');
    expect(section.contentMd).toContain('Node.js');
    expect(section.contentMd).toContain('>=20.11');
    expect(section.contentMd).toContain('cp .env.example .env');
    expect(section.contentMd).toContain('pnpm run build');
    expect(section.contentMd).toContain('docker compose -f docker-compose.yml up --build');
  });

  it('reports the absence of a manifest instead of inventing commands', () => {
    const empty = buildStackProfile([file('notes.md', '# hello')]);
    expect(deterministicSection('installation', empty, 'demo/repo').contentMd).toContain('No dependency manifest');
  });
});

describe('stored stack profiles', () => {
  // Profiles are persisted as JSON and read back with a cast, so one written
  // before a field existed arrives without it. Consumers reach straight for
  // .length, so an un-normalised profile crashed chat, docs and PR review for
  // every repository indexed before the field was added.
  const legacy = {
    projectTypes: ['backend-api'],
    languages: [],
    frameworks: [],
    packageManagers: [],
    testFrameworks: [],
    databases: [],
    externalServices: [],
    authMechanisms: [],
    entryPoints: [],
    configFiles: [],
    envVars: [],
    routes: [],
    directories: [],
    hasDocker: true,
    hasCI: false,
    hasTests: true,
    monorepo: false,
  };

  it('fills in fields a profile predates', () => {
    const stack = normaliseStackProfile(legacy);
    expect(stack.manifestFiles).toEqual([]);
    expect(stack.runtimes).toEqual([]);
    expect(stack.scripts).toEqual([]);
    expect(stack.dockerFiles).toEqual([]);
    expect(stack.ciFiles).toEqual([]);
    // Values that were stored must survive untouched.
    expect(stack.projectTypes).toEqual(['backend-api']);
    expect(stack.hasDocker).toBe(true);
  });

  it('survives a profile that is empty, null or the wrong shape', () => {
    for (const raw of [null, undefined, {}, { routes: 'not-an-array' }]) {
      const stack = normaliseStackProfile(raw);
      expect(Array.isArray(stack.routes)).toBe(true);
      expect(Array.isArray(stack.scripts)).toBe(true);
    }
  });

  it('lets every consumer of a legacy profile run without throwing', () => {
    const stack = normaliseStackProfile(legacy);
    expect(() => buildRepositoryOverview(stack)).not.toThrow();
    for (const section of ['installation', 'deployment', 'testing', 'overview'] as const) {
      expect(() => deterministicSection(section, stack, 'demo/repo')).not.toThrow();
    }
  });
});

describe('route grouping and handlers', () => {
  it('skips prefixes every endpoint shares', () => {
    expect(routeGroup('/api/repositories/:id')).toBe('repositories');
    expect(routeGroup('/api/v1/users')).toBe('users');
    expect(routeGroup('/health')).toBe('health');
  });

  it('does not report a callback parameter as the handler name', () => {
    const inline = detectRoutes("app.post('/auth/login', async (request, reply) => { return 1; })", 'typescript');
    expect(inline[0]?.handler).toBeUndefined();

    const named = detectRoutes("app.get('/users', listUsers)", 'typescript');
    expect(named[0]?.handler).toBe('listUsers');
  });
});

describe('architecture fallback', () => {
  const stack = buildStackProfile([
    file('package.json', ROOT_PACKAGE),
    file('src/routes/users.ts', "app.get('/api/users', listUsers)"),
    file('src/routes/orders.ts', "app.get('/api/orders', listOrders)"),
    file('src/lib/text.ts', 'export const slug = (s: string) => s;'),
  ]);

  const graph: DependencyGraph = {
    nodes: [
      { id: 'a', path: 'src/routes/users.ts', role: 'route', language: 'typescript', loc: 1, fanIn: 0, fanOut: 1 },
      { id: 'b', path: 'src/routes/orders.ts', role: 'route', language: 'typescript', loc: 1, fanIn: 0, fanOut: 1 },
      { id: 'c', path: 'src/lib/text.ts', role: 'util', language: 'typescript', loc: 1, fanIn: 2, fanOut: 0 },
    ],
    edges: [
      { from: 'a', to: 'c', specifier: '../lib/text' },
      { from: 'b', to: 'c', specifier: '../lib/text' },
    ],
    externals: [],
    cycles: [],
    hotspots: [],
  };

  it('produces a parseable diagram even when no directory holds two files', () => {
    const flat: DependencyGraph = {
      ...graph,
      nodes: [{ id: 'a', path: 'main.ts', role: 'entrypoint', language: 'typescript', loc: 1, fanIn: 0, fanOut: 0 }],
      edges: [],
    };
    const diagram = deterministicMermaid(buildStackProfile([file('main.ts', 'app.listen(3000);')]), flat);
    expect(diagram.startsWith('flowchart TD')).toBe(true);
    // A header with no nodes is what mermaid rejects outright.
    expect(diagram.split('\n').length).toBeGreaterThan(1);
  });

  it('describes layers and flows with no AI provider configured', () => {
    const narrative = deterministicNarrative(stack, graph);
    expect(narrative.layers?.length).toBeGreaterThan(0);
    expect(narrative.directoryPurposes?.length).toBeGreaterThan(0);
    expect(narrative.flows?.length).toBeGreaterThan(0);
    expect(narrative.summary).toContain('indexed files');
    // The schema rejects a flow shorter than two steps.
    expect(narrative.flows?.every((f) => f.steps.length >= 2)).toBe(true);
  });
});

describe('directory role voting', () => {
  it('does not let one incidental file name a directory full of code', () => {
    // A React src/ is one index.js, one App.js and a pile of stylesheets. The
    // old rule dropped "unknown" and took the maximum, so the single entry
    // point named the whole directory.
    expect(pickDominantRole({ entrypoint: 1, component: 1, style: 2, unknown: 2 })).toBe('component');
  });

  it('lets scaffolding name a directory only when there is nothing else', () => {
    expect(pickDominantRole({ config: 3, markup: 1, unknown: 1 })).toBe('config');
    expect(pickDominantRole({ entrypoint: 1, config: 1 })).toBe('entrypoint');
    expect(pickDominantRole({ route: 1, config: 4 })).toBe('route');
  });

  it('breaks ties by what describes a directory, not by indexing order', () => {
    const forwards = pickDominantRole({ component: 2, route: 2 });
    const backwards = pickDominantRole({ route: 2, component: 2 });
    expect(forwards).toBe(backwards);
    expect(forwards).toBe('route');
  });

  it('falls back to unknown only when nothing at all matched', () => {
    expect(pickDominantRole({ unknown: 4 })).toBe('unknown');
    expect(pickDominantRole({})).toBe('unknown');
  });
});

describe('static assets and stylesheets', () => {
  it('treats a public directory as assets rather than an entry point', () => {
    expect(detectRole('frontend/public/index.html', '<!doctype html>').role).toBe('asset');
    expect(detectRole('frontend/public/manifest.json', '{}').role).toBe('asset');
    expect(detectRole('web/static/logo.svg', '<svg/>').role).toBe('asset');
  });

  it('labels stylesheets and markup instead of leaving them unknown', () => {
    expect(detectRole('frontend/src/App.css', '.app {}').role).toBe('style');
    expect(detectRole('frontend/src/theme.scss', '$c: red;').role).toBe('style');
    expect(detectRole('frontend/index.html', '<!doctype html>').role).toBe('markup');
  });

  it('still prefers a directory convention over the file extension', () => {
    expect(detectRole('src/components/Button.css', '.b {}').role).toBe('component');
  });
});
