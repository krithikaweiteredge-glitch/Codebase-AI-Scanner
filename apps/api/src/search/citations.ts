import { prisma } from '../db';

export interface RawCitation {
  filePath: string;
  startLine?: number | null;
  endLine?: number | null;
  symbolName?: string | null;
  note?: string | null;
}

export interface ValidatedCitation extends RawCitation {
  valid: boolean;
  reason?: string;
  fileId?: string;
  lineCount?: number;
}

export interface GroundingResult {
  citations: ValidatedCitation[];
  invalid: ValidatedCitation[];
  /** Share of citations that resolve to real indexed locations (1 = fully grounded). */
  groundingScore: number;
  warning?: string;
}

/** `path/to/file.ts:42`, `path/to/file.ts:42-88`, `path/to/file.ts(42)` */
const INLINE_REFERENCE =
  /\b((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:\s*[-–]\s*(\d+))?|\((\d+)\))?/g;

/** Pull file references out of free-form model prose. */
export function extractCitationsFromText(text: string): RawCitation[] {
  const out: RawCitation[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(INLINE_REFERENCE)) {
    const filePath = match[1];
    if (!filePath || !filePath.includes('.')) continue;
    // Skip obvious prose like "e.g." or version strings.
    if (/^\d+\.\d+/.test(filePath)) continue;
    if (/^(e\.g|i\.e|etc|vs)\./i.test(filePath)) continue;

    const start = match[2] ?? match[4];
    const end = match[3];
    const key = `${filePath}:${start ?? ''}-${end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      filePath,
      startLine: start ? Number(start) : null,
      endLine: end ? Number(end) : start ? Number(start) : null,
    });
  }
  return out;
}

/**
 * Validate citations against the actual index.
 *
 * A citation is valid only when the file exists on the indexed branch and any
 * line numbers fall inside the file. Paths are matched exactly first, then by
 * unique suffix (models often shorten `apps/api/src/x.ts` to `src/x.ts`).
 */
export async function validateCitations(
  repositoryId: string,
  branchId: string,
  citations: readonly RawCitation[],
): Promise<GroundingResult> {
  if (!citations.length) {
    return { citations: [], invalid: [], groundingScore: 0 };
  }

  const files = await prisma.repositoryFile.findMany({
    where: { repositoryId, branchId },
    select: { id: true, path: true, lineCount: true },
  });

  const byPath = new Map(files.map((f) => [f.path, f]));
  const bySuffix = new Map<string, { id: string; path: string; lineCount: number }[]>();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      const list = bySuffix.get(suffix) ?? [];
      list.push(file);
      bySuffix.set(suffix, list);
    }
  }

  const validated: ValidatedCitation[] = citations.map((citation) => {
    const normalised = citation.filePath.replace(/^\.\//, '').replace(/^\//, '');
    let file = byPath.get(normalised);

    if (!file) {
      const candidates = bySuffix.get(normalised);
      if (candidates?.length === 1) file = candidates[0];
      else if (candidates && candidates.length > 1) {
        return {
          ...citation,
          valid: false,
          reason: `"${citation.filePath}" is ambiguous - ${candidates.length} indexed files end with that path`,
        };
      }
    }

    if (!file) {
      return { ...citation, valid: false, reason: `"${citation.filePath}" is not present in the indexed branch` };
    }

    if (citation.startLine != null && (citation.startLine < 1 || citation.startLine > file.lineCount)) {
      return {
        ...citation,
        filePath: file.path,
        fileId: file.id,
        lineCount: file.lineCount,
        valid: false,
        reason: `line ${citation.startLine} is outside ${file.path} (${file.lineCount} lines)`,
      };
    }

    return {
      ...citation,
      filePath: file.path,
      fileId: file.id,
      lineCount: file.lineCount,
      endLine:
        citation.endLine != null ? Math.min(citation.endLine, file.lineCount) : (citation.startLine ?? null),
      valid: true,
    };
  });

  const valid = validated.filter((c) => c.valid);
  const invalid = validated.filter((c) => !c.valid);

  return {
    citations: valid,
    invalid,
    groundingScore: validated.length ? valid.length / validated.length : 0,
    warning: invalid.length
      ? `${invalid.length} reference(s) in the answer could not be matched to indexed files and were removed: ` +
        invalid.map((c) => c.filePath).join(', ')
      : undefined,
  };
}

/**
 * Drop findings whose file/line does not exist. Used for every AI-produced
 * finding before it is written to the database.
 */
export async function filterGroundedFindings<T extends { filePath?: string | null; startLine?: number | null }>(
  repositoryId: string,
  branchId: string,
  findings: readonly T[],
): Promise<{ kept: (T & { fileId: string })[]; rejected: { finding: T; reason: string }[] }> {
  const files = await prisma.repositoryFile.findMany({
    where: { repositoryId, branchId },
    select: { id: true, path: true, lineCount: true },
  });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const bySuffix = new Map<string, { id: string; path: string; lineCount: number }[]>();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      const list = bySuffix.get(suffix) ?? [];
      list.push(file);
      bySuffix.set(suffix, list);
    }
  }

  const kept: (T & { fileId: string })[] = [];
  const rejected: { finding: T; reason: string }[] = [];

  for (const finding of findings) {
    const rawPath = finding.filePath?.replace(/^\.\//, '').replace(/^\//, '');
    if (!rawPath) {
      rejected.push({ finding, reason: 'finding has no file path' });
      continue;
    }
    let file = byPath.get(rawPath);
    if (!file) {
      const candidates = bySuffix.get(rawPath);
      if (candidates?.length === 1) file = candidates[0];
    }
    if (!file) {
      rejected.push({ finding, reason: `file "${rawPath}" is not indexed` });
      continue;
    }
    if (finding.startLine != null && (finding.startLine < 1 || finding.startLine > file.lineCount)) {
      rejected.push({ finding, reason: `line ${finding.startLine} outside ${file.path}` });
      continue;
    }
    kept.push({ ...finding, filePath: file.path, fileId: file.id } as T & { fileId: string });
  }

  return { kept, rejected };
}
