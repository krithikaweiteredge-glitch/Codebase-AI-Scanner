/** Rough token estimate: good enough for context budgeting without a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/** 1-indexed, inclusive line slice. */
export function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  const from = Math.max(1, startLine) - 1;
  const to = Math.min(lines.length, Math.max(startLine, endLine));
  return lines.slice(from, to).join('\n');
}

export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  const max = Math.min(offset, content.length);
  for (let i = 0; i < max; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} characters]`;
}

/** Heuristic binary detection based on NUL bytes / control character density. */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

/** Split an identifier into searchable words: getUserById -> [get, user, by, id] */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function tokenizeForLexical(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length > 1) words.push(lower);
    for (const part of splitIdentifier(raw)) if (part.length > 1 && part !== lower) words.push(part);
  }
  return words;
}
