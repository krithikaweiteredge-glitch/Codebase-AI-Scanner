import { describe, expect, it } from 'vitest';
import { formatBytes, formatNumber, monacoLanguage, severityRank, shortenPath } from '@/lib/utils';

describe('formatting helpers', () => {
  it('formats numbers and bytes', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5_242_880)).toBe('5.0 MB');
  });

  it('shortens long paths but keeps the filename', () => {
    expect(shortenPath('src/a/b/c/d/File.ts')).toBe('src/…/c/d/File.ts');
    expect(shortenPath('src/File.ts')).toBe('src/File.ts');
  });

  it('maps indexed languages to monaco language ids', () => {
    expect(monacoLanguage('tsx', 'src/App.tsx')).toBe('typescript');
    expect(monacoLanguage('python', 'main.py')).toBe('python');
    expect(monacoLanguage(null, 'notes.md')).toBe('markdown');
    expect(monacoLanguage(null, 'unknown.zzz')).toBe('plaintext');
  });

  it('orders severities by risk', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('low'));
    expect(severityRank('nonsense')).toBe(99);
  });
});
