import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatRelativeTime(input: string | null | undefined): string {
  if (!input) return 'never';
  const date = new Date(input);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** `src/very/long/path/File.ts` -> `src/…/path/File.ts` */
export function shortenPath(path: string, maxSegments = 4): string {
  const parts = path.split('/');
  if (parts.length <= maxSegments) return path;
  return `${parts[0]}/…/${parts.slice(-(maxSegments - 1)).join('/')}`;
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function monacoLanguage(language: string | null | undefined, path?: string): string {
  const byLanguage: Record<string, string> = {
    typescript: 'typescript',
    tsx: 'typescript',
    javascript: 'javascript',
    jsx: 'javascript',
    python: 'python',
    java: 'java',
    go: 'go',
    csharp: 'csharp',
    ruby: 'ruby',
    php: 'php',
    rust: 'rust',
    kotlin: 'kotlin',
    swift: 'swift',
    scala: 'scala',
    sql: 'sql',
    shell: 'shell',
    yaml: 'yaml',
    json: 'json',
    markdown: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    xml: 'xml',
    dockerfile: 'dockerfile',
    graphql: 'graphql',
  };
  if (language && byLanguage[language]) return byLanguage[language] as string;

  // Fall back to the file extension when the index did not record a language.
  const byExtension: Record<string, string> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    py: 'python',
    java: 'java',
    go: 'go',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    rs: 'rust',
    kt: 'kotlin',
    swift: 'swift',
    scala: 'scala',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    xml: 'xml',
    graphql: 'graphql',
  };
  const ext = path?.split('.').pop()?.toLowerCase();
  if (ext && byExtension[ext]) return byExtension[ext] as string;
  return 'plaintext';
}

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity as (typeof SEVERITY_ORDER)[number]);
  return index === -1 ? 99 : index;
}
