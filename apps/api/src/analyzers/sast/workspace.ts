/**
 * Materialises indexed files into a throwaway directory so a file-based
 * scanner can run over them.
 *
 * The platform never clones repositories - files are fetched through the
 * GitHub API into Postgres - so anything that expects a working tree has to be
 * given one. That makes this module the single point where database rows turn
 * into real paths on disk, and therefore the place where path handling has to
 * be airtight: the paths originate from a third-party API, and a name like
 * `../../../../etc/cron.d/x` must never escape the scratch directory.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AnalyzableFile } from '../types';

export interface WorkspaceLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface Workspace {
  /** Absolute path of the scratch directory. */
  root: string;
  /** Repository-relative paths actually written. */
  files: string[];
  bytesWritten: number;
  skipped: { path: string; reason: string }[];
  /** Removes the directory and everything in it. Safe to call twice. */
  cleanup: () => Promise<void>;
}

/**
 * Writes `files` into a fresh temporary directory. The caller must always call
 * `cleanup()`, including on the error path.
 */
export async function materialize(
  files: readonly AnalyzableFile[],
  limits: WorkspaceLimits,
): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-ai-scan-'));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  };

  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let bytesWritten = 0;

  try {
    for (const file of files) {
      if (written.length >= limits.maxFiles) {
        skipped.push({ path: file.path, reason: 'file limit reached' });
        continue;
      }

      const target = safeJoin(root, file.path);
      if (!target) {
        skipped.push({ path: file.path, reason: 'unsafe path' });
        continue;
      }

      const bytes = Buffer.byteLength(file.content, 'utf8');
      if (bytes > limits.maxFileBytes) {
        skipped.push({ path: file.path, reason: 'file too large' });
        continue;
      }
      if (bytesWritten + bytes > limits.maxTotalBytes) {
        skipped.push({ path: file.path, reason: 'total size limit reached' });
        continue;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');

      written.push(file.path);
      bytesWritten += bytes;
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { root, files: written, bytesWritten, skipped, cleanup };
}

/**
 * Resolves a repository-relative path inside `root`, or returns null if the
 * result would land anywhere else.
 *
 * Rejecting `..` textually is not enough on its own - the check that actually
 * matters is that the fully resolved path is still under the root, which also
 * covers absolute paths, drive letters and UNC prefixes on Windows.
 */
export function safeJoin(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\0')) return null;

  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.startsWith('/')) return null;
  // A Windows drive or UNC prefix would make path.resolve ignore the root.
  if (/^[a-zA-Z]:/.test(normalised)) return null;
  if (normalised.split('/').some((segment) => segment === '..')) return null;

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalised);

  // The trailing separator stops `/tmp/scan-evil` passing as inside `/tmp/scan`.
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;

  return target;
}
