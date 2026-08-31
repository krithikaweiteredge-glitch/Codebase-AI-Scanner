/**
 * Software composition analysis: which of this repository's declared
 * dependencies have known published vulnerabilities.
 *
 * This is the one class of finding the rest of the engine cannot reach. Static
 * rules read the code you wrote; a vulnerable `lodash` pin is invisible to them
 * no matter how many patterns they match. It is also the cheapest class to get
 * right, because there is nothing to infer - a resolved version either falls in
 * an advisory's affected range or it does not.
 */

import * as path from 'node:path';
import { githubClientForRepository } from '../../github/service';
import type { GitHubClient } from '../../github/client';
import { confidenceLabel, findingStatus } from '../../prompts/shared';
import { mapPool } from '../../lib/pool';
import type { AnalysisFindingDraft, AnalyzableFile, Severity } from '../types';
import {
  dedupePackages,
  isVendoredPath,
  MANIFEST_BASENAMES,
  parseManifest,
  type Ecosystem,
  type ResolvedPackage,
} from './manifests';
import {
  advisoryUrl,
  cweOf,
  fetchVulnerabilities,
  fixedVersionsFor,
  packageKey,
  primaryAlias,
  queryVulnerabilityIds,
  severityOf,
  type OsvClientOptions,
  type OsvVulnerability,
} from './osv';

/** Bounds, so one enormous monorepo cannot stall an analysis run. */
const MAX_MANIFESTS = 40;
const MAX_MANIFEST_BYTES = 8_000_000;
const MAX_PACKAGES = 5_000;
/** Ceiling on full-record fetches, so a pathological repo cannot stall a run. */
export const MAX_ADVISORY_FETCHES = 250;
const MANIFEST_CONCURRENCY = 5;

/** Files that pin a full resolved tree, as opposed to declaring intent. */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pipfile.lock',
  'poetry.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
]);

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export interface ScaContext {
  repositoryId: string;
  userId: string;
  owner: string;
  repo: string;
  /** Commit the run indexed, so the scan matches the analysed tree exactly. */
  commitSha: string | null;
}

export interface ScaResult {
  drafts: AnalysisFindingDraft[];
  manifests: string[];
  packagesScanned: number;
  vulnerablePackages: number;
  advisories: number;
}

export type ScaOptions = OsvClientOptions;

/**
 * Runs the scan and returns findings. Throws only when the OSV API itself is
 * unreachable - every lesser problem (an unreadable lockfile, a repository we
 * cannot re-fetch from GitHub) degrades to scanning less rather than failing.
 */
export async function scanDependencies(
  ctx: ScaContext,
  indexedFiles: readonly AnalyzableFile[],
  options: ScaOptions,
): Promise<ScaResult> {
  const sources = await collectManifests(ctx, indexedFiles);

  const parsed = sources.flatMap((source) => parseManifest(source.path, source.content));
  const packages = dedupePackages(parsed).slice(0, MAX_PACKAGES);

  const manifests = [...new Set(sources.map((s) => s.path))];
  if (!packages.length) {
    return { drafts: [], manifests, packagesScanned: 0, vulnerablePackages: 0, advisories: 0 };
  }

  const vulnIdsByPackage = await queryVulnerabilityIds(packages, options);
  if (!vulnIdsByPackage.size) {
    return { drafts: [], manifests, packagesScanned: packages.length, vulnerablePackages: 0, advisories: 0 };
  }

  const distinctIds = [...new Set([...vulnIdsByPackage.values()].flat())];
  const advisories = await fetchVulnerabilities(distinctIds, options);

  const drafts: AnalysisFindingDraft[] = [];
  for (const pkg of packages) {
    const ids = vulnIdsByPackage.get(packageKey(pkg));
    if (!ids?.length) continue;

    // Withdrawn and unfetchable advisories drop out here.
    const matched = ids.map((id) => advisories.get(id)).filter((v): v is OsvVulnerability => Boolean(v));
    if (!matched.length) continue;

    drafts.push(buildFinding(pkg, matched));
  }

  return {
    drafts,
    manifests,
    packagesScanned: packages.length,
    vulnerablePackages: drafts.length,
    advisories: advisories.size,
  };
}

// ---------------------------------------------------------------------------
// Gathering manifests
// ---------------------------------------------------------------------------

interface ManifestSource {
  path: string;
  content: string;
}

/**
 * Manifests come from two places. Files like package.json are already indexed,
 * so they are free. Lockfiles are excluded from indexing by design, so they are
 * fetched from GitHub at the analysed commit - and if that fetch fails we
 * simply scan what was indexed, which still catches exact pins.
 */
async function collectManifests(ctx: ScaContext, indexedFiles: readonly AnalyzableFile[]): Promise<ManifestSource[]> {
  const sources: ManifestSource[] = [];
  const seen = new Set<string>();

  for (const file of indexedFiles) {
    if (!isManifestPath(file.path)) continue;
    seen.add(file.path);
    sources.push({ path: file.path, content: file.content });
  }

  try {
    for (const fetched of await fetchLockfilesFromGitHub(ctx)) {
      if (seen.has(fetched.path)) continue;
      seen.add(fetched.path);
      sources.push(fetched);
    }
  } catch {
    // No GitHub access, rate limited, or the commit is gone. Indexed manifests
    // alone still produce a useful (if less complete) scan.
  }

  return sources;
}

function isManifestPath(filePath: string): boolean {
  if (isVendoredPath(filePath)) return false;
  return MANIFEST_BASENAMES.includes(path.basename(filePath).toLowerCase());
}

async function fetchLockfilesFromGitHub(ctx: ScaContext): Promise<ManifestSource[]> {
  if (!ctx.commitSha) return [];

  const client: GitHubClient = await githubClientForRepository(ctx.repositoryId, ctx.userId);
  const tree = await client.getTree(ctx.owner, ctx.repo, ctx.commitSha);

  const targets = tree.tree
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => LOCKFILE_BASENAMES.has(path.basename(entry.path).toLowerCase()))
    .filter((entry) => !isVendoredPath(entry.path))
    .filter((entry) => (entry.size ?? 0) <= MAX_MANIFEST_BYTES)
    .slice(0, MAX_MANIFESTS);

  const fetched = await mapPool(targets, MANIFEST_CONCURRENCY, async (entry) => {
    try {
      const blob = await client.getBlob(ctx.owner, ctx.repo, entry.sha);
      return { path: entry.path, content: blob.toString('utf8') };
    } catch {
      return null;
    }
  });

  return fetched.filter((source): source is ManifestSource => source !== null);
}

// ---------------------------------------------------------------------------
// Finding construction
// ---------------------------------------------------------------------------

/**
 * One finding per vulnerable package rather than per advisory. A package with
 * six CVEs is one upgrade decision, not six, and reporting it six times buries
 * everything else on the findings page.
 */
function buildFinding(pkg: ResolvedPackage, advisories: OsvVulnerability[]): AnalysisFindingDraft {
  const ranked = [...advisories].sort(
    (a, b) => SEVERITY_ORDER[severityOf(b)] - SEVERITY_ORDER[severityOf(a)],
  );
  const worst = ranked[0] as OsvVulnerability;
  const severity = severityOf(worst);

  const fixes = [...new Set(ranked.flatMap((v) => fixedVersionsFor(v, pkg.ecosystem, pkg.name)))];
  const upgradeTarget = highestVersion(fixes);
  const isLockfile = LOCKFILE_BASENAMES.has(path.basename(pkg.file).toLowerCase());

  // An exact version either falls inside an advisory's affected range or it
  // does not, so the only real uncertainty is whether this resolved version is
  // the one that ships - which a lockfile answers and a manifest pin does not.
  const confidence = isLockfile ? 0.95 : 0.85;

  const title =
    advisories.length === 1
      ? `${pkg.name}@${pkg.version} is affected by ${primaryAlias(worst) ?? worst.id}`
      : `${pkg.name}@${pkg.version} is affected by ${advisories.length} known vulnerabilities`;

  return {
    category: 'security',
    // Package-scoped and stable across runs, so the same dependency keeps one
    // identity as advisories are added to or withdrawn from the database.
    ruleId: `sca.${pkg.ecosystem}.${pkg.name}`.slice(0, 80),
    type: 'vulnerable-dependency',
    severity,
    title,
    description: describe(pkg, ranked, upgradeTarget),
    evidence: `${pkg.file}${pkg.line ? `:${pkg.line}` : ''} resolves ${pkg.name} to ${pkg.version} (${pkg.ecosystem}).`,
    recommendation: recommend(pkg, upgradeTarget),
    filePath: pkg.file,
    startLine: pkg.line ?? 1,
    endLine: pkg.line ?? 1,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    status: findingStatus('sca', confidence),
    source: 'sca',
    ...(cweOf(worst) ? { cwe: cweOf(worst) } : {}),
    metadata: {
      detector: 'osv',
      ecosystem: pkg.ecosystem,
      package: pkg.name,
      version: pkg.version,
      direct: pkg.direct,
      manifest: pkg.file,
      fixedVersions: fixes,
      upgradeTo: upgradeTarget,
      advisories: ranked.map((vuln) => ({
        id: vuln.id,
        alias: primaryAlias(vuln),
        severity: severityOf(vuln),
        summary: vuln.summary ?? null,
        url: advisoryUrl(vuln),
        fixed: fixedVersionsFor(vuln, pkg.ecosystem, pkg.name),
      })),
    },
  };
}

function describe(pkg: ResolvedPackage, advisories: OsvVulnerability[], upgradeTarget: string | null): string {
  const relation = pkg.direct
    ? 'a direct dependency'
    : 'a transitive dependency, pulled in by another package rather than declared here';

  const lines = [
    `\`${pkg.name}\` is pinned to ${pkg.version} in \`${pkg.file}\` as ${relation}. ` +
      `That version is listed as affected by ${advisories.length} published ` +
      `${advisories.length === 1 ? 'advisory' : 'advisories'}:`,
    '',
  ];

  for (const vuln of advisories.slice(0, 8)) {
    const id = primaryAlias(vuln) ?? vuln.id;
    const fixed = fixedVersionsFor(vuln, pkg.ecosystem, pkg.name);
    const summary = (vuln.summary ?? vuln.details ?? 'No summary published.').split('\n')[0]?.trim() ?? '';
    lines.push(
      `- **[${severityOf(vuln)}] ${id}** - ${summary.slice(0, 300)}` +
        (fixed.length ? ` (fixed in ${fixed.join(', ')})` : ' (no fixed version published)') +
        ` ${advisoryUrl(vuln)}`,
    );
  }
  if (advisories.length > 8) lines.push(`- ...and ${advisories.length - 8} more.`);

  if (!upgradeTarget) {
    lines.push(
      '',
      'No fixed version has been published for this package yet, so upgrading will not resolve it.',
    );
  }

  return lines.join('\n').slice(0, 4000);
}

function recommend(pkg: ResolvedPackage, upgradeTarget: string | null): string {
  if (!upgradeTarget) {
    return (
      `No patched release exists yet. Check whether the vulnerable code path is reachable from your usage of ` +
      `\`${pkg.name}\`, and consider a replacement package or a temporary workaround until a fix ships.`
    );
  }

  if (pkg.direct) {
    return `Upgrade \`${pkg.name}\` to ${upgradeTarget} or later, then re-run the lockfile install and the test suite.`;
  }

  return (
    `\`${pkg.name}\` is transitive, so bump whichever dependency pulls it in. If no parent release uses ` +
    `${upgradeTarget} or later yet, pin it directly with an npm \`overrides\` entry (or your ecosystem's equivalent).`
  );
}

/** Advisories list fixes per affected range; the newest is the safe target. */
function highestVersion(versions: readonly string[]): string | null {
  if (!versions.length) return null;
  return [...versions].sort(compareVersions).pop() ?? null;
}

/** Numeric-segment comparison. Good enough to order fixes from one advisory. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[.\-+]/);
  const partsB = b.split(/[.\-+]/);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const rawA = partsA[i] ?? '0';
    const rawB = partsB[i] ?? '0';
    const numA = Number.parseInt(rawA, 10);
    const numB = Number.parseInt(rawB, 10);

    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      if (rawA !== rawB) return rawA < rawB ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

export type { Ecosystem, ResolvedPackage };
