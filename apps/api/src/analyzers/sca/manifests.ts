/**
 * Lockfile and manifest parsing for software composition analysis.
 *
 * Every parser here is pure: content in, resolved packages out. Composition
 * analysis needs *concrete* versions - an advisory says "fixed in 4.17.21",
 * which only means something against a resolved `4.17.20`, never against a
 * range like `^4.17.0`. Lockfiles are therefore the primary source, and
 * manifests are a fallback used only where they pin an exact version.
 *
 * Lockfiles are deliberately excluded from indexing (see indexer/ignore.ts)
 * because they are enormous and would pollute the embedding space, so the
 * scanner fetches them from GitHub on demand instead of reading the database.
 */

/** OSV ecosystem identifiers - these strings are part of the OSV API contract. */
export type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems' | 'Packagist';

export interface ResolvedPackage {
  ecosystem: Ecosystem;
  name: string;
  /** A single concrete version - never a range. */
  version: string;
  /** Path of the file the version was read from. */
  file: string;
  /** False for transitive dependencies pulled in by something else. */
  direct: boolean;
  /** 1-based line in `file` where the package is declared, when known. */
  line?: number;
}

/**
 * Basenames the scanner looks for in the repository tree, lowercased.
 * Ordering does not matter; every match is parsed and the results merged.
 */
export const MANIFEST_BASENAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'package.json',
  'requirements.txt',
  'pipfile.lock',
  'poetry.lock',
  'go.mod',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
];

/** Directories whose lockfiles describe vendored code, not this project's tree. */
const VENDOR_SEGMENTS = ['node_modules/', 'vendor/', 'bower_components/', '.git/', 'third_party/'];

export function isVendoredPath(path: string): boolean {
  const normalised = path.toLowerCase().replace(/\\/g, '/');
  return VENDOR_SEGMENTS.some((segment) => normalised.includes(segment));
}

/**
 * Dispatch on basename. Returns an empty array for anything unrecognised or
 * malformed - a broken lockfile must never fail the surrounding analysis run.
 */
export function parseManifest(path: string, content: string): ResolvedPackage[] {
  const base = path.toLowerCase().split('/').pop() ?? '';
  try {
    switch (base) {
      case 'package-lock.json':
      case 'npm-shrinkwrap.json':
        return withLines(parsePackageLock(path, content), content);
      case 'yarn.lock':
        return withLines(parseYarnLock(path, content), content);
      case 'pnpm-lock.yaml':
        return withLines(parsePnpmLock(path, content), content);
      case 'package.json':
        return withLines(parsePackageJson(path, content), content);
      case 'requirements.txt':
        return withLines(parseRequirementsTxt(path, content), content);
      case 'pipfile.lock':
        return withLines(parsePipfileLock(path, content), content);
      case 'poetry.lock':
        return withLines(parsePoetryLock(path, content), content);
      case 'go.mod':
        return withLines(parseGoMod(path, content), content);
      case 'cargo.lock':
        return withLines(parseCargoLock(path, content), content);
      case 'gemfile.lock':
        return withLines(parseGemfileLock(path, content), content);
      case 'composer.lock':
        return withLines(parseComposerLock(path, content), content);
      default:
        return [];
    }
  } catch {
    // Malformed manifest - report nothing rather than breaking the run.
    return [];
  }
}

/**
 * Collapse duplicates across manifests. The same package can appear in several
 * lockfiles of a monorepo; a direct declaration wins over a transitive one so
 * the finding points at a file a developer can actually edit.
 */
export function dedupePackages(packages: readonly ResolvedPackage[]): ResolvedPackage[] {
  const byKey = new Map<string, ResolvedPackage>();
  for (const pkg of packages) {
    if (!pkg.name || !pkg.version) continue;
    const key = `${pkg.ecosystem}|${pkg.name}|${pkg.version}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.direct && pkg.direct)) byKey.set(key, pkg);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

interface PackageLockV2Entry {
  version?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLockV1Entry {
  version?: string;
  dependencies?: Record<string, PackageLockV1Entry>;
}

function parsePackageLock(file: string, content: string): ResolvedPackage[] {
  const lock = JSON.parse(content) as {
    packages?: Record<string, PackageLockV2Entry>;
    dependencies?: Record<string, PackageLockV1Entry>;
  };
  const out: ResolvedPackage[] = [];
  const NODE_MODULES = 'node_modules/';

  // lockfileVersion 2/3: a flat map keyed by install path.
  if (lock.packages) {
    // Install path cannot tell direct from transitive: npm hoists most of the
    // tree to top-level node_modules regardless of who asked for it. What is
    // actually declared lives on the project entries - "" for the root, plus
    // one per workspace.
    const declared = new Set<string>();
    for (const [installPath, entry] of Object.entries(lock.packages)) {
      if (installPath.includes(NODE_MODULES)) continue;
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        for (const name of Object.keys(entry[section] ?? {})) declared.add(name);
      }
    }

    for (const [installPath, entry] of Object.entries(lock.packages)) {
      // "" is the root project itself; links point at workspace source.
      if (!installPath || entry.link) continue;
      const marker = installPath.lastIndexOf(NODE_MODULES);
      if (marker === -1) continue; // a workspace package, not a dependency
      const name = installPath.slice(marker + NODE_MODULES.length);
      if (!name || !entry.version) continue;
      out.push({
        ecosystem: 'npm',
        name,
        version: entry.version,
        file,
        direct: declared.has(name),
      });
    }
    return out;
  }

  // lockfileVersion 1: a nested tree. It records no declaration list, so
  // top-level placement is the only signal available - hoisting makes that an
  // over-estimate of what is direct, which the finding text stays vague about.
  const walk = (deps: Record<string, PackageLockV1Entry> | undefined, depth: number): void => {
    if (!deps) return;
    for (const [name, entry] of Object.entries(deps)) {
      if (entry.version) out.push({ ecosystem: 'npm', name, version: entry.version, file, direct: depth === 0 });
      walk(entry.dependencies, depth + 1);
    }
  };
  walk(lock.dependencies, 0);
  return out;
}

/**
 * Handles yarn classic (`  version "1.2.3"`) and berry (`  version: 1.2.3`).
 * Descriptor keys carry the name; the entry body carries the resolution.
 */
function parseYarnLock(file: string, content: string): ResolvedPackage[] {
  const out: ResolvedPackage[] = [];
  const blocks = content.split(/\n(?=[^\s#])/);

  for (const block of blocks) {
    const newline = block.indexOf('\n');
    if (newline === -1) continue;
    const header = block.slice(0, newline).trim().replace(/:$/, '');
    if (!header || header.startsWith('#') || header.startsWith('__metadata')) continue;

    const versionMatch = /^\s+version:?\s+"?([^"\s]+)"?\s*$/m.exec(block);
    if (!versionMatch?.[1]) continue;

    // A header is a comma-separated list of descriptors for one resolution.
    const first = header.split(',')[0]?.trim().replace(/^"|"$/g, '');
    if (!first) continue;

    const name = npmNameFromDescriptor(first);
    if (name) out.push({ ecosystem: 'npm', name, version: versionMatch[1], file, direct: false });
  }
  return out;
}

/** `foo@^1.0.0`, `@scope/foo@^1.0.0`, `@scope/foo@npm:^1.0.0` -> package name. */
function npmNameFromDescriptor(descriptor: string): string | null {
  const at = descriptor.lastIndexOf('@');
  if (at <= 0) return descriptor || null;
  return descriptor.slice(0, at) || null;
}

/** pnpm v5 keys look like `/foo/1.2.3:`, v6+ like `/foo@1.2.3:` or `foo@1.2.3:`. */
function parsePnpmLock(file: string, content: string): ResolvedPackage[] {
  const out: ResolvedPackage[] = [];
  let inPackages = false;

  for (const raw of content.split('\n')) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(raw)) inPackages = false;
    if (!inPackages) continue;

    // The trailing `(...)` is a peer-dependency suffix: `1.2.3(react@18.0.0)`.
    const keyMatch = /^ {2}'?\/?((?:@[^/@\s']+\/)?[^/@\s':]+)[/@]([^\s'():]+)(?:\([^)]*\))*'?:\s*$/.exec(raw);
    const name = keyMatch?.[1];
    const version = keyMatch?.[2];
    if (!name || !version) continue;
    out.push({ ecosystem: 'npm', name, version, file, direct: false });
  }
  return out;
}

/**
 * A manifest, not a lockfile: only exact pins are usable. `^1.2.3` says nothing
 * about what is installed, so those entries are skipped rather than guessed at.
 */
function parsePackageJson(file: string, content: string): ResolvedPackage[] {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  const out: ResolvedPackage[] = [];

  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const block = pkg[section] as Record<string, string> | undefined;
    if (!block) continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range !== 'string') continue;
      const exact = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(range.trim());
      if (!exact?.[0]) continue;
      out.push({ ecosystem: 'npm', name, version: exact[0], file, direct: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------

function parseRequirementsTxt(file: string, content: string): ResolvedPackage[] {
  const out: ResolvedPackage[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0]?.trim();
    if (!line || line.startsWith('-')) continue;
    // Only `==` pins a version; `>=` and friends leave the install unresolved.
    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9._*+!-]+)/.exec(line);
    const name = match?.[1];
    const version = match?.[2];
    if (!name || !version || version.includes('*')) continue;
    out.push({ ecosystem: 'PyPI', name, version, file, direct: true });
  }
  return out;
}

function parsePipfileLock(file: string, content: string): ResolvedPackage[] {
  const lock = JSON.parse(content) as Record<string, Record<string, { version?: string }>>;
  const out: ResolvedPackage[] = [];

  for (const section of ['default', 'develop'] as const) {
    const block = lock[section];
    if (!block) continue;
    for (const [name, entry] of Object.entries(block)) {
      const version = entry?.version?.replace(/^==/, '').trim();
      if (!version) continue;
      out.push({ ecosystem: 'PyPI', name, version, file, direct: true });
    }
  }
  return out;
}

/** poetry.lock is TOML; the `[[package]]` blocks are simple enough to read directly. */
function parsePoetryLock(file: string, content: string): ResolvedPackage[] {
  return parseTomlPackageBlocks(content).map(({ name, version }) => ({
    ecosystem: 'PyPI' as const,
    name,
    version,
    file,
    direct: false,
  }));
}

// ---------------------------------------------------------------------------
// Go / Rust / Ruby / PHP
// ---------------------------------------------------------------------------

/**
 * go.mod carries resolved versions already (the module graph is pinned), so it
 * is a valid source without go.sum. OSV expects Go versions without the
 * leading `v`.
 */
function parseGoMod(file: string, content: string): ResolvedPackage[] {
  const out: ResolvedPackage[] = [];
  let inRequireBlock = false;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    const body = inRequireBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    if (!body || body.startsWith('//')) continue;

    const match = /^([\w.\-~/]+)\s+v([0-9][^\s/]*)/.exec(body);
    const name = match?.[1];
    const version = match?.[2];
    if (!name || !version) continue;
    out.push({ ecosystem: 'Go', name, version, file, direct: !body.includes('// indirect') });
  }
  return out;
}

function parseCargoLock(file: string, content: string): ResolvedPackage[] {
  return parseTomlPackageBlocks(content).map(({ name, version }) => ({
    ecosystem: 'crates.io' as const,
    name,
    version,
    file,
    direct: false,
  }));
}

/** The `GEM > specs:` section lists `name (1.2.3)`, indented by four spaces. */
function parseGemfileLock(file: string, content: string): ResolvedPackage[] {
  const out: ResolvedPackage[] = [];
  let inSpecs = false;

  for (const raw of content.split('\n')) {
    if (/^ {2}specs:\s*$/.test(raw)) {
      inSpecs = true;
      continue;
    }
    if (inSpecs && /^\S/.test(raw)) inSpecs = false;
    if (!inSpecs) continue;

    const match = /^ {4}([A-Za-z0-9._-]+) \(([^)]+)\)\s*$/.exec(raw);
    const name = match?.[1];
    const version = match?.[2];
    if (!name || !version) continue;
    out.push({ ecosystem: 'RubyGems', name, version, file, direct: true });
  }
  return out;
}

function parseComposerLock(file: string, content: string): ResolvedPackage[] {
  const lock = JSON.parse(content) as Record<string, { name?: string; version?: string }[]>;
  const out: ResolvedPackage[] = [];

  for (const section of ['packages', 'packages-dev'] as const) {
    for (const entry of lock[section] ?? []) {
      const name = entry?.name;
      const version = entry?.version?.replace(/^v/, '');
      if (!name || !version) continue;
      out.push({ ecosystem: 'Packagist', name, version, file, direct: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Both poetry.lock and Cargo.lock use `[[package]]` blocks with `name` and
 * `version` keys, which is little enough TOML to read without a parser.
 */
function parseTomlPackageBlocks(content: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  let name: string | null = null;
  let version: string | null = null;

  const flush = () => {
    if (name && version) out.push({ name, version });
    name = null;
    version = null;
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '[[package]]') {
      flush();
      continue;
    }
    // Any other table header also ends the current block.
    if (line.startsWith('[')) {
      flush();
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (nameMatch?.[1]) name = nameMatch[1];
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch?.[1]) version = versionMatch[1];
  }
  flush();
  return out;
}

/**
 * Attach the line where each package name first appears so findings can link to
 * a precise location. Lockfiles repeat names many times; the first mention is
 * close enough to be useful and is cheap to compute for every package at once.
 */
function withLines(packages: ResolvedPackage[], content: string): ResolvedPackage[] {
  if (!packages.length) return packages;

  const lines = content.split('\n');
  const pending = new Map<string, ResolvedPackage[]>();
  for (const pkg of packages) {
    const bucket = pending.get(pkg.name);
    if (bucket) bucket.push(pkg);
    else pending.set(pkg.name, [pkg]);
  }

  for (let i = 0; i < lines.length && pending.size; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const [name, bucket] of pending) {
      if (!line.includes(name)) continue;
      for (const pkg of bucket) pkg.line = i + 1;
      pending.delete(name);
    }
  }

  return packages;
}
