/**
 * Secret scanning across git history.
 *
 * The indexer only ever sees the current tree, so a credential that was
 * committed and later deleted scans perfectly clean - while remaining fully
 * readable to anyone who can clone the repository. Deleting a secret from the
 * working tree does nothing; only rotating it does.
 *
 * This walks recent commits, runs the existing detectors over the lines each
 * commit *added*, and reports what is no longer visible at HEAD. Secrets that
 * are still present are left to the normal scan, so the same credential is not
 * reported twice.
 */

import { detectSecrets } from '../indexer/secrets';
import { mapPool } from '../lib/pool';
import { confidenceLabel, findingStatus } from '../prompts/shared';
import type { GitHubClient } from '../github/client';
import type { AnalysisFindingDraft } from './types';

/** Bounds: history scanning is one API call per commit. */
const COMMIT_CONCURRENCY = 4;
const MAX_PATCH_BYTES = 400_000;

export interface SecretHistoryContext {
  owner: string;
  repo: string;
  /** Branch head to walk back from. */
  commitSha: string;
  /** How many commits back to look. */
  maxCommits: number;
}

export interface SecretHistoryResult {
  drafts: AnalysisFindingDraft[];
  commitsScanned: number;
}

interface HistoricalHit {
  ruleId: string;
  label: string;
  preview: string;
  severity: 'critical' | 'high' | 'medium';
  confidence: number;
  filePath: string;
  commitSha: string;
  commitUrl: string;
  authoredAt: string | null;
  author: string | null;
}

/**
 * `currentSecrets` is the set of rule+file pairs the normal scan already
 * reports at HEAD, so this only surfaces what has since been removed.
 */
export async function scanSecretHistory(
  client: GitHubClient,
  ctx: SecretHistoryContext,
  currentSecrets: ReadonlySet<string>,
): Promise<SecretHistoryResult> {
  const commits = await client.listCommits(ctx.owner, ctx.repo, ctx.commitSha, Math.min(ctx.maxCommits, 100));
  if (!commits.length) return { drafts: [], commitsScanned: 0 };

  const perCommit = await mapPool(commits.slice(0, ctx.maxCommits), COMMIT_CONCURRENCY, async (commit) => {
    try {
      const full = await client.getCommit(ctx.owner, ctx.repo, commit.sha);
      return hitsInCommit(full);
    } catch {
      // One unreachable commit must not lose the rest of the history.
      return [];
    }
  });

  const hits = perCommit.flat().filter((hit) => !currentSecrets.has(`${hit.ruleId}|${hit.filePath}`));

  return { drafts: dedupeHits(hits).map(toDraft), commitsScanned: commits.length };
}

/** Runs the secret rules over the added lines of every file in one commit. */
function hitsInCommit(commit: Awaited<ReturnType<GitHubClient['getCommit']>>): HistoricalHit[] {
  const out: HistoricalHit[] = [];

  for (const file of commit.files ?? []) {
    if (!file.patch || file.patch.length > MAX_PATCH_BYTES) continue;

    const added = addedLines(file.patch);
    if (!added) continue;

    for (const secret of detectSecrets(added)) {
      out.push({
        ruleId: secret.ruleId,
        label: secret.label,
        preview: secret.preview,
        severity: secret.severity,
        confidence: secret.confidence,
        filePath: file.filename,
        commitSha: commit.sha,
        commitUrl: commit.html_url,
        authoredAt: commit.commit.author?.date ?? null,
        author: commit.author?.login ?? commit.commit.author?.name ?? null,
      });
    }
  }

  return out;
}

/**
 * Only added lines matter. A `-` line is the secret being removed, which is
 * the very event that hides it from the current-tree scan - counting it would
 * double-report every removal.
 */
export function addedLines(patch: string): string {
  const lines: string[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    lines.push(line.slice(1));
  }
  return lines.join('\n');
}

/**
 * One finding per credential per file, attributed to the earliest commit that
 * introduced it. A secret rewritten across ten commits is still one leak.
 */
function dedupeHits(hits: readonly HistoricalHit[]): HistoricalHit[] {
  const byKey = new Map<string, HistoricalHit>();

  for (const hit of hits) {
    const key = `${hit.ruleId}|${hit.filePath}|${hit.preview}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, hit);
      continue;
    }
    const earlier = (hit.authoredAt ?? '') < (existing.authoredAt ?? '') ? hit : existing;
    byKey.set(key, earlier);
  }

  return [...byKey.values()];
}

function toDraft(hit: HistoricalHit): AnalysisFindingDraft {
  const when = hit.authoredAt ? new Date(hit.authoredAt).toISOString().slice(0, 10) : 'an earlier commit';

  return {
    category: 'security',
    ruleId: `history.${hit.ruleId}`,
    type: 'historical-secret',
    severity: hit.severity,
    title: `${hit.label} was committed to git history`,
    description:
      `A value matching ${hit.label} was added to \`${hit.filePath}\` in commit ` +
      `${hit.commitSha.slice(0, 8)} (${when}) and is no longer present at HEAD.\n\n` +
      'Removing a secret in a later commit does not remove it from history - anyone who can clone ' +
      'the repository, or who already has a copy, can still read it. It must be treated as compromised.\n\n' +
      hit.commitUrl,
    // Never store or transmit the secret itself.
    evidence: `Pattern ${hit.ruleId} matched in the diff of ${hit.commitSha.slice(0, 8)} (value masked as ${hit.preview}).`,
    recommendation:
      'Rotate the credential now - that is the only step that actually revokes it. Purging history ' +
      '(git filter-repo, or a fresh repository) limits further exposure but does not undo it, since ' +
      'existing clones and forks keep the old objects.',
    filePath: hit.filePath,
    // History findings are not anchored to a line in the current file.
    startLine: 1,
    endLine: 1,
    confidence: hit.confidence,
    confidenceLabel: confidenceLabel(hit.confidence),
    status: findingStatus('static', hit.confidence),
    source: 'static',
    cwe: 'CWE-798',
    metadata: {
      detector: 'secret-history',
      rule: hit.ruleId,
      commit: hit.commitSha,
      commitUrl: hit.commitUrl,
      authoredAt: hit.authoredAt,
      author: hit.author,
      removedAtHead: true,
    },
  };
}
