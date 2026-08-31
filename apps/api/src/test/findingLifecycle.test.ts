import { describe, expect, it } from 'vitest';
import { previousFindingsFilter } from '../jobs/analysisJob';

const REPO = 'repo-1';
const BRANCH = 'branch-1';

describe('replacing the previous run findings', () => {
  const filter = previousFindingsFilter(REPO, BRANCH);
  const clauses = filter.OR as { file?: unknown; fileId?: unknown; run?: unknown }[];

  it('is scoped to this repository and excludes pull-request reviews', () => {
    expect(filter.repositoryId).toBe(REPO);
    // PR review findings belong to the review, not to a branch analysis.
    expect(filter.reviewId).toBeNull();
  });

  it('covers findings that point at an indexed file', () => {
    expect(clauses).toContainEqual({ file: { branchId: BRANCH } });
  });

  it('also covers findings with no indexed file at all', () => {
    // The bug this fixes: a dependency finding cites package-lock.json, which
    // the indexer excludes, so fileId is null - and a null-file row can never
    // match `file: { branchId }`. They survived every delete and accumulated,
    // turning 7 vulnerable dependencies into 14 after a second run.
    expect(clauses).toContainEqual({ fileId: null, run: { branchId: BRANCH } });
  });

  it('scopes file-less findings by the run branch, not globally', () => {
    // Without the run condition this would delete another branch's dependency
    // findings too, since they are equally file-less.
    const fileless = clauses.find((c) => c.fileId === null);
    expect(fileless?.run).toEqual({ branchId: BRANCH });
  });
});
