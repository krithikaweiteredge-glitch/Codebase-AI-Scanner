/**
 * Client for the OSV.dev vulnerability database (https://osv.dev).
 *
 * OSV is a free, unauthenticated aggregator over GHSA, the Go vulnerability
 * database, RustSec, PyPA and others. That matters here for two reasons: it
 * needs no API key to run in any deployment, and it is a plain HTTP JSON API,
 * so it works without a repository checkout on disk or a scanner binary in the
 * image - neither of which this platform has.
 *
 * The scan runs in two phases because the API is shaped that way:
 *   1. `querybatch` takes up to 1000 package/version pairs and answers with
 *      matching vulnerability *ids* only.
 *   2. `vulns/{id}` returns the full record. Only the handful of ids from
 *      phase 1 need this, so a repository with no vulnerable dependencies
 *      costs a couple of requests in total.
 */

import { chunkArray, mapPool, sleep } from '../../lib/pool';
import type { Severity } from '../types';
import type { Ecosystem, ResolvedPackage } from './manifests';

/** OSV caps a batch at 1000 queries; stay under it to leave room for retries. */
const BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20_000;
const DETAIL_CONCURRENCY = 6;

export interface OsvReference {
  type: string;
  url: string;
}

export interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: { type?: string; events?: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
  versions?: string[];
  database_specific?: { source?: string };
}

export interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  modified?: string;
  published?: string;
  /** Present once the advisory has been withdrawn; such records must be ignored. */
  withdrawn?: string;
  severity?: { type?: string; score?: string }[];
  affected?: OsvAffected[];
  references?: OsvReference[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
}

export interface OsvClientOptions {
  baseUrl: string;
  /** Hard ceiling on full-record fetches, so a pathological repo cannot stall a run. */
  maxDetailFetches: number;
}

/**
 * Phase 1. Returns vulnerability ids per package, keyed by `packageKey`.
 * Packages with no known vulnerabilities are absent from the map.
 */
export async function queryVulnerabilityIds(
  packages: readonly ResolvedPackage[],
  options: OsvClientOptions,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();

  for (const batch of chunkArray(packages, BATCH_SIZE)) {
    const body = {
      queries: batch.map((pkg) => ({
        package: { name: pkg.name, ecosystem: pkg.ecosystem },
        version: pkg.version,
      })),
    };

    const response = await osvFetch<{ results?: { vulns?: { id: string }[] }[] }>(
      `${options.baseUrl}/v1/querybatch`,
      { method: 'POST', body: JSON.stringify(body) },
    );

    // Results are positional: results[i] answers queries[i].
    const results = response?.results ?? [];
    for (let i = 0; i < batch.length; i++) {
      const pkg = batch[i];
      const vulns = results[i]?.vulns;
      if (!pkg || !vulns?.length) continue;
      found.set(packageKey(pkg), vulns.map((v) => v.id));
    }
  }

  return found;
}

/**
 * Phase 2. Fetches full records for the given ids. Individual failures are
 * dropped rather than thrown - a partial advisory list is far better than
 * losing the whole dependency scan to one flaky request.
 */
export async function fetchVulnerabilities(
  ids: readonly string[],
  options: OsvClientOptions,
): Promise<Map<string, OsvVulnerability>> {
  const capped = ids.slice(0, options.maxDetailFetches);

  const records = await mapPool(capped, DETAIL_CONCURRENCY, async (id) => {
    try {
      return await osvFetch<OsvVulnerability>(`${options.baseUrl}/v1/vulns/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  });

  const byId = new Map<string, OsvVulnerability>();
  for (const record of records) {
    // Withdrawn advisories were retracted by their publisher; reporting them
    // would be a false positive by definition.
    if (record?.id && !record.withdrawn) byId.set(record.id, record);
  }
  return byId;
}

export function packageKey(pkg: Pick<ResolvedPackage, 'ecosystem' | 'name' | 'version'>): string {
  return `${pkg.ecosystem}|${pkg.name}|${pkg.version}`;
}

// ---------------------------------------------------------------------------
// Advisory interpretation
// ---------------------------------------------------------------------------

/**
 * Advisory severity, in order of trustworthiness: the publisher's own rating,
 * then a CVSS vector we score ourselves. Unrated advisories are reported as
 * `medium` - they are real vulnerabilities, just unscored, and dropping them to
 * `low` would bury them under lint noise.
 */
export function severityOf(vuln: OsvVulnerability): Severity {
  const declared = vuln.database_specific?.severity?.toUpperCase();
  if (declared === 'CRITICAL') return 'critical';
  if (declared === 'HIGH') return 'high';
  if (declared === 'MODERATE' || declared === 'MEDIUM') return 'medium';
  if (declared === 'LOW') return 'low';

  const score = cvssBaseScore(vuln);
  if (score !== null) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    if (score > 0) return 'low';
  }

  return 'medium';
}

/** The numeric CVSS base score, when the advisory carries a v3.x vector. */
export function cvssBaseScore(vuln: OsvVulnerability): number | null {
  const vector = vuln.severity?.find((s) => s.type === 'CVSS_V3')?.score;
  return vector ? scoreCvssV3Vector(vector) : null;
}

/**
 * CVSS v3.1 base score from a vector string, per the published specification
 * (https://www.first.org/cvss/v3.1/specification-document, section 8.1).
 * Returns null for a vector missing any required metric.
 */
export function scoreCvssV3Vector(vector: string): number | null {
  const metrics = new Map<string, string>();
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key, value);
  }

  const scope = metrics.get('S');
  if (scope !== 'U' && scope !== 'C') return null;
  const changed = scope === 'C';

  const attackVector = pick(metrics, 'AV', { N: 0.85, A: 0.62, L: 0.55, P: 0.2 });
  const attackComplexity = pick(metrics, 'AC', { L: 0.77, H: 0.44 });
  const privileges = changed
    ? pick(metrics, 'PR', { N: 0.85, L: 0.68, H: 0.5 })
    : pick(metrics, 'PR', { N: 0.85, L: 0.62, H: 0.27 });
  const userInteraction = pick(metrics, 'UI', { N: 0.85, R: 0.62 });

  const impactWeights = { H: 0.56, L: 0.22, N: 0 };
  const confidentiality = pick(metrics, 'C', impactWeights);
  const integrity = pick(metrics, 'I', impactWeights);
  const availability = pick(metrics, 'A', impactWeights);

  if (
    attackVector === null ||
    attackComplexity === null ||
    privileges === null ||
    userInteraction === null ||
    confidentiality === null ||
    integrity === null ||
    availability === null
  ) {
    return null;
  }

  const iss = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const impact = changed
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;

  if (impact <= 0) return 0;

  const exploitability = 8.22 * attackVector * attackComplexity * privileges * userInteraction;
  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);

  return roundUp1(raw);
}

function pick(metrics: Map<string, string>, key: string, weights: Record<string, number>): number | null {
  const value = metrics.get(key);
  if (value === undefined) return null;
  return weights[value] ?? null;
}

/** CVSS "Roundup": the smallest one-decimal number >= the input. */
function roundUp1(value: number): number {
  const scaled = Math.round(value * 100000);
  if (scaled % 10000 === 0) return scaled / 100000;
  return (Math.floor(scaled / 10000) + 1) / 10;
}

/**
 * Versions this advisory says the problem is fixed in, for the given package.
 * An advisory can cover many packages across ecosystems, so both are matched.
 */
export function fixedVersionsFor(vuln: OsvVulnerability, ecosystem: Ecosystem, name: string): string[] {
  const out: string[] = [];

  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== name) continue;
    if (affected.package.ecosystem && affected.package.ecosystem !== ecosystem) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) out.push(event.fixed);
      }
    }
  }

  return [...new Set(out)];
}

/** The CVE alias is what people search for, so prefer it over the OSV id. */
export function primaryAlias(vuln: OsvVulnerability): string | null {
  return vuln.aliases?.find((alias) => alias.startsWith('CVE-')) ?? null;
}

export function cweOf(vuln: OsvVulnerability): string | undefined {
  return vuln.database_specific?.cwe_ids?.[0];
}

export function advisoryUrl(vuln: OsvVulnerability): string {
  const advisory = vuln.references?.find((ref) => ref.type === 'ADVISORY')?.url;
  return advisory ?? `https://osv.dev/vulnerability/${vuln.id}`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class OsvUnavailable extends Error {}

/** One retry on the failures that are plausibly transient: 5xx and throttling. */
async function osvFetch<T>(url: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'codebase-ai-platform',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    if (attempt < 1) {
      await sleep(750);
      return osvFetch<T>(url, init, attempt + 1);
    }
    throw new OsvUnavailable(`Could not reach the OSV API: ${(cause as Error).message}`);
  }

  if (response.ok) {
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  if ((response.status === 429 || response.status >= 500) && attempt < 1) {
    await sleep(1000);
    return osvFetch<T>(url, init, attempt + 1);
  }

  throw new OsvUnavailable(`OSV API error (${response.status})`);
}
