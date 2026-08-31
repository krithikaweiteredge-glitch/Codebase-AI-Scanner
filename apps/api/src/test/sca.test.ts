import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupePackages, isVendoredPath, parseManifest } from '../analyzers/sca/manifests';
import {
  cweOf,
  fixedVersionsFor,
  primaryAlias,
  scoreCvssV3Vector,
  severityOf,
  type OsvVulnerability,
} from '../analyzers/sca/osv';
import { scanDependencies } from '../analyzers/sca';
import type { AnalyzableFile } from '../analyzers/types';

function file(path: string, content: string): AnalyzableFile {
  return {
    id: `id-${path}`,
    path,
    language: 'json',
    role: 'config',
    content,
    lineCount: content.split('\n').length,
    isTest: false,
    isConfig: true,
    isGenerated: false,
  };
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

describe('npm manifest parsing', () => {
  it('reads resolved versions from a lockfileVersion 3 package-lock', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/express/node_modules/qs': { version: '6.5.1' },
        'apps/api': { name: '@scope/api', version: '0.1.0' },
      },
    });

    const packages = parseManifest('package-lock.json', lock);

    expect(packages.find((p) => p.name === 'lodash')).toMatchObject({
      ecosystem: 'npm',
      version: '4.17.20',
      direct: true,
    });
    expect(packages.find((p) => p.name === 'qs')).toMatchObject({ version: '6.5.1', direct: false });
    // Workspace entries are the project's own code, not dependencies.
    expect(packages.find((p) => p.name === '@scope/api')).toBeUndefined();
  });

  it('does not call a hoisted transitive dependency direct', () => {
    // npm installs most of the tree at top level whoever asked for it, so the
    // install path alone would call every one of these a direct dependency.
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', dependencies: { express: '^4.18.0' } },
        'apps/web': { name: '@scope/web', devDependencies: { vitest: '^3.0.0' } },
        'node_modules/express': { version: '4.18.2' },
        'node_modules/vitest': { version: '3.0.5' },
        'node_modules/body-parser': { version: '1.20.1' },
      },
    });

    const packages = parseManifest('package-lock.json', lock);

    expect(packages.find((p) => p.name === 'express')?.direct).toBe(true);
    // Declared by a workspace rather than the root: still direct.
    expect(packages.find((p) => p.name === 'vitest')?.direct).toBe(true);
    // Hoisted to the top level, but nothing in the project declares it.
    expect(packages.find((p) => p.name === 'body-parser')?.direct).toBe(false);
  });

  it('walks the nested tree of a lockfileVersion 1 package-lock', () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        express: { version: '4.16.0', dependencies: { qs: { version: '6.5.1' } } },
      },
    });

    const packages = parseManifest('package-lock.json', lock);

    expect(packages.find((p) => p.name === 'express')).toMatchObject({ version: '4.16.0', direct: true });
    expect(packages.find((p) => p.name === 'qs')).toMatchObject({ version: '6.5.1', direct: false });
  });

  it('reads yarn classic and berry entries, including scoped names', () => {
    const yarn = [
      '# yarn lockfile v1',
      '',
      'lodash@^4.17.15:',
      '  version "4.17.20"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz"',
      '',
      '"@babel/core@npm:^7.0.0":',
      '  version: 7.20.0',
      '',
    ].join('\n');

    const packages = parseManifest('yarn.lock', yarn);

    expect(packages.find((p) => p.name === 'lodash')?.version).toBe('4.17.20');
    expect(packages.find((p) => p.name === '@babel/core')?.version).toBe('7.20.0');
  });

  it('reads pnpm v5 and v6 key formats and strips peer suffixes', () => {
    const pnpm = [
      'lockfileVersion: 6.0',
      '',
      'packages:',
      '',
      '  /lodash/4.17.20:',
      '    resolution: {integrity: sha512-abc}',
      '',
      '  /@babel/core@7.20.0:',
      '    resolution: {integrity: sha512-def}',
      '',
      '  /react-dom@18.2.0(react@18.2.0):',
      '    resolution: {integrity: sha512-ghi}',
      '',
    ].join('\n');

    const packages = parseManifest('pnpm-lock.yaml', pnpm);

    expect(packages.find((p) => p.name === 'lodash')?.version).toBe('4.17.20');
    expect(packages.find((p) => p.name === '@babel/core')?.version).toBe('7.20.0');
    expect(packages.find((p) => p.name === 'react-dom')?.version).toBe('18.2.0');
  });

  it('takes only exact pins from package.json, never ranges', () => {
    const pkg = JSON.stringify({
      dependencies: { lodash: '4.17.20', express: '^4.18.0', react: '~18.2.0' },
      devDependencies: { vitest: '3.0.5' },
    });

    const packages = parseManifest('package.json', pkg);
    const names = packages.map((p) => p.name).sort();

    // A range says nothing about what is actually installed.
    expect(names).toEqual(['lodash', 'vitest']);
  });
});

describe('other ecosystems', () => {
  it('takes == pins from requirements.txt and skips everything looser', () => {
    const requirements = [
      '# comment',
      'django==3.2.4',
      'requests>=2.0.0',
      'flask==2.0.*',
      'urllib3[secure]==1.26.4  # inline comment',
      '-r other.txt',
    ].join('\n');

    const packages = parseManifest('requirements.txt', requirements);

    expect(packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual(['django@3.2.4', 'urllib3@1.26.4']);
    expect(packages[0]?.ecosystem).toBe('PyPI');
  });

  it('reads go.mod require blocks and marks indirect dependencies', () => {
    const gomod = [
      'module example.com/app',
      '',
      'go 1.21',
      '',
      'require (',
      '\tgithub.com/gin-gonic/gin v1.7.0',
      '\tgolang.org/x/crypto v0.1.0 // indirect',
      ')',
      '',
      'require github.com/stretchr/testify v1.8.0',
    ].join('\n');

    const packages = parseManifest('go.mod', gomod);

    // OSV expects Go versions without the leading v.
    expect(packages.find((p) => p.name === 'github.com/gin-gonic/gin')).toMatchObject({
      version: '1.7.0',
      ecosystem: 'Go',
      direct: true,
    });
    expect(packages.find((p) => p.name === 'golang.org/x/crypto')?.direct).toBe(false);
    expect(packages.find((p) => p.name === 'github.com/stretchr/testify')?.version).toBe('1.8.0');
  });

  it('reads Cargo.lock and poetry.lock package blocks', () => {
    const cargo = [
      '[[package]]',
      'name = "serde"',
      'version = "1.0.130"',
      '',
      '[[package]]',
      'name = "tokio"',
      'version = "1.14.0"',
      '',
      '[metadata]',
      'name = "ignored"',
    ].join('\n');

    const packages = parseManifest('Cargo.lock', cargo);

    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(['serde@1.0.130', 'tokio@1.14.0']);
    expect(packages[0]?.ecosystem).toBe('crates.io');
  });

  it('reads the specs section of a Gemfile.lock', () => {
    const gemfile = [
      'GEM',
      '  remote: https://rubygems.org/',
      '  specs:',
      '    rails (6.1.4)',
      '    nokogiri (1.11.0)',
      '',
      'PLATFORMS',
      '  ruby',
    ].join('\n');

    const packages = parseManifest('Gemfile.lock', gemfile);

    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(['rails@6.1.4', 'nokogiri@1.11.0']);
    expect(packages[0]?.ecosystem).toBe('RubyGems');
  });

  it('returns nothing for malformed content instead of throwing', () => {
    expect(parseManifest('package-lock.json', '{ not json')).toEqual([]);
    expect(parseManifest('unknown.txt', 'whatever')).toEqual([]);
  });
});

describe('package collection', () => {
  it('records the line a package is declared on', () => {
    const lock = ['{', '  "lockfileVersion": 3,', '  "packages": {', '    "node_modules/lodash": {', '      "version": "4.17.20"', '    }', '  }', '}'].join('\n');

    expect(parseManifest('package-lock.json', lock).find((p) => p.name === 'lodash')?.line).toBe(4);
  });

  it('ignores vendored trees', () => {
    expect(isVendoredPath('node_modules/foo/package.json')).toBe(true);
    expect(isVendoredPath('vendor/bundle/Gemfile.lock')).toBe(true);
    expect(isVendoredPath('apps/api/package.json')).toBe(false);
  });

  it('prefers the direct declaration when a package appears in several manifests', () => {
    const deduped = dedupePackages([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.20', file: 'a/package-lock.json', direct: false },
      { ecosystem: 'npm', name: 'lodash', version: '4.17.20', file: 'package.json', direct: true },
      { ecosystem: 'npm', name: 'lodash', version: '4.17.21', file: 'b/package-lock.json', direct: false },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.find((p) => p.version === '4.17.20')).toMatchObject({ file: 'package.json', direct: true });
  });
});

// ---------------------------------------------------------------------------
// Advisory interpretation
// ---------------------------------------------------------------------------

describe('CVSS v3.1 base scoring', () => {
  it('matches the published scores for known vectors', () => {
    // Unauthenticated remote code execution.
    expect(scoreCvssV3Vector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    // Remote denial of service.
    expect(scoreCvssV3Vector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(7.5);
    // Reflected cross-site scripting, the canonical scope-changed example.
    expect(scoreCvssV3Vector('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
  });

  it('scores zero when nothing is impacted, and rejects incomplete vectors', () => {
    expect(scoreCvssV3Vector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    expect(scoreCvssV3Vector('CVSS:3.1/AV:N/AC:L')).toBeNull();
    expect(scoreCvssV3Vector('nonsense')).toBeNull();
  });
});

describe('severity resolution', () => {
  const base: OsvVulnerability = { id: 'GHSA-test' };

  it('trusts the publisher rating first', () => {
    expect(severityOf({ ...base, database_specific: { severity: 'CRITICAL' } })).toBe('critical');
    expect(severityOf({ ...base, database_specific: { severity: 'MODERATE' } })).toBe('medium');
  });

  it('falls back to the CVSS vector', () => {
    expect(severityOf({ ...base, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })).toBe(
      'critical',
    );
    expect(severityOf({ ...base, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }] })).toBe(
      'high',
    );
  });

  it('reports unrated advisories as medium rather than burying them', () => {
    expect(severityOf(base)).toBe('medium');
  });
});

describe('advisory details', () => {
  const vuln: OsvVulnerability = {
    id: 'GHSA-p6mc-m468-83gg',
    aliases: ['CVE-2020-8203'],
    database_specific: { cwe_ids: ['CWE-1321'] },
    affected: [
      {
        package: { name: 'lodash', ecosystem: 'npm' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.20' }] }],
      },
      {
        package: { name: 'other', ecosystem: 'npm' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ fixed: '9.9.9' }] }],
      },
    ],
  };

  it('extracts fixed versions for the matching package only', () => {
    expect(fixedVersionsFor(vuln, 'npm', 'lodash')).toEqual(['4.17.20']);
    expect(fixedVersionsFor(vuln, 'npm', 'missing')).toEqual([]);
    // The same name in a different ecosystem is a different package.
    expect(fixedVersionsFor(vuln, 'PyPI', 'lodash')).toEqual([]);
  });

  it('prefers the CVE alias and surfaces the CWE', () => {
    expect(primaryAlias(vuln)).toBe('CVE-2020-8203');
    expect(cweOf(vuln)).toBe('CWE-1321');
  });
});

// ---------------------------------------------------------------------------
// End to end, against a stubbed OSV API
// ---------------------------------------------------------------------------

describe('scanDependencies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answers the two-phase OSV protocol: querybatch, then per-id detail. */
  function stubOsv(vulnsByIndex: Record<number, string[]>, records: Record<string, OsvVulnerability>) {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();

      if (href.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { queries: unknown[] };
        const results = body.queries.map((_, i) => {
          const ids = vulnsByIndex[i];
          return ids ? { vulns: ids.map((id) => ({ id })) } : {};
        });
        return new Response(JSON.stringify({ results }), { status: 200 });
      }

      const id = href.split('/v1/vulns/')[1];
      const record = id ? records[decodeURIComponent(id)] : undefined;
      if (!record) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(record), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const ctx = { repositoryId: 'repo-1', userId: 'user-1', owner: 'acme', repo: 'app', commitSha: null };
  const options = { baseUrl: 'https://api.osv.dev', maxDetailFetches: 250 };

  const manifest = file('package.json', JSON.stringify({ dependencies: { lodash: '4.17.19' } }, null, 2));

  it('reports a vulnerable dependency with its upgrade target', async () => {
    stubOsv(
      { 0: ['GHSA-p6mc-m468-83gg'] },
      {
        'GHSA-p6mc-m468-83gg': {
          id: 'GHSA-p6mc-m468-83gg',
          aliases: ['CVE-2020-8203'],
          summary: 'Prototype pollution in lodash',
          database_specific: { severity: 'HIGH', cwe_ids: ['CWE-1321'] },
          affected: [
            {
              package: { name: 'lodash', ecosystem: 'npm' },
              ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.20' }] }],
            },
          ],
        },
      },
    );

    const result = await scanDependencies(ctx, [manifest], options);

    expect(result.packagesScanned).toBe(1);
    expect(result.vulnerablePackages).toBe(1);
    expect(result.drafts).toHaveLength(1);

    const finding = result.drafts[0]!;
    expect(finding.category).toBe('security');
    expect(finding.type).toBe('vulnerable-dependency');
    expect(finding.severity).toBe('high');
    expect(finding.source).toBe('sca');
    expect(finding.cwe).toBe('CWE-1321');
    expect(finding.filePath).toBe('package.json');
    expect(finding.title).toContain('CVE-2020-8203');
    expect(finding.recommendation).toContain('4.17.20');
    expect(finding.metadata).toMatchObject({ package: 'lodash', version: '4.17.19', upgradeTo: '4.17.20' });
  });

  it('collapses several advisories for one package into a single finding at the worst severity', async () => {
    stubOsv(
      { 0: ['GHSA-low', 'GHSA-crit'] },
      {
        'GHSA-low': {
          id: 'GHSA-low',
          summary: 'Minor issue',
          database_specific: { severity: 'LOW' },
          affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '4.17.20' }] }] }],
        },
        'GHSA-crit': {
          id: 'GHSA-crit',
          summary: 'Serious issue',
          database_specific: { severity: 'CRITICAL' },
          affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '4.17.21' }] }] }],
        },
      },
    );

    const result = await scanDependencies(ctx, [manifest], options);

    expect(result.drafts).toHaveLength(1);
    const finding = result.drafts[0]!;
    expect(finding.severity).toBe('critical');
    expect(finding.title).toContain('2 known vulnerabilities');
    // The newest fix across all advisories is the safe target.
    expect(finding.metadata).toMatchObject({ upgradeTo: '4.17.21' });
  });

  it('ignores withdrawn advisories', async () => {
    stubOsv(
      { 0: ['GHSA-withdrawn'] },
      {
        'GHSA-withdrawn': {
          id: 'GHSA-withdrawn',
          withdrawn: '2023-01-01T00:00:00Z',
          summary: 'Retracted',
          affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '4.17.20' }] }] }],
        },
      },
    );

    const result = await scanDependencies(ctx, [manifest], options);

    expect(result.drafts).toHaveLength(0);
  });

  it('says so when no advisory published a fix', async () => {
    stubOsv(
      { 0: ['GHSA-nofix'] },
      {
        'GHSA-nofix': {
          id: 'GHSA-nofix',
          summary: 'Unpatched',
          database_specific: { severity: 'HIGH' },
          affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }] }] }],
        },
      },
    );

    const finding = (await scanDependencies(ctx, [manifest], options)).drafts[0]!;

    expect(finding.metadata).toMatchObject({ upgradeTo: null });
    expect(finding.description).toContain('No fixed version');
    expect(finding.recommendation).toContain('No patched release');
  });

  it('does not call OSV when there is nothing to scan', async () => {
    const fetchMock = stubOsv({}, {});

    const result = await scanDependencies(ctx, [file('src/index.ts', 'export const x = 1;')], options);

    expect(result).toMatchObject({ packagesScanned: 0, vulnerablePackages: 0, manifests: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports clean when OSV knows of no vulnerabilities', async () => {
    stubOsv({}, {});

    const result = await scanDependencies(ctx, [manifest], options);

    expect(result.packagesScanned).toBe(1);
    expect(result.vulnerablePackages).toBe(0);
    expect(result.drafts).toEqual([]);
  });
});
