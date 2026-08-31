import type { Language } from '../languages';
import {
  estimateComplexity,
  type LanguageAnalyzer,
  type ParseResult,
  type ParsedImport,
  type ParsedSymbol,
  type SymbolKind,
} from './types';

interface SymbolRule {
  pattern: RegExp;
  kind: SymbolKind;
  nameGroup: number;
  asyncGroup?: number;
  exportedTest?: (line: string) => boolean;
}

interface ImportRule {
  pattern: RegExp;
  group: number;
  kind: ParsedImport['kind'];
}

interface LanguageSpec {
  languages: Language[];
  blockStyle: 'brace' | 'indent' | 'ruby';
  symbols: SymbolRule[];
  imports: ImportRule[];
}

const SPECS: LanguageSpec[] = [
  {
    languages: ['python'],
    blockStyle: 'indent',
    symbols: [
      { pattern: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
      {
        pattern: /^[ \t]*(async\s+)?def\s+([A-Za-z_]\w*)/gm,
        kind: 'function',
        nameGroup: 2,
        asyncGroup: 1,
        exportedTest: (line) => !/^\s*(async\s+)?def\s+_/.test(line),
      },
    ],
    imports: [
      { pattern: /^\s*import\s+([A-Za-z_][\w.]*)/gm, group: 1, kind: 'import' },
      { pattern: /^\s*from\s+([.\w]+)\s+import\s+/gm, group: 1, kind: 'import' },
    ],
  },
  {
    languages: ['java', 'kotlin', 'scala'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^[ \t]*(?:public|private|protected|internal|open|abstract|final|sealed|data|static|\s)*\b(?:class|interface|enum|object|record)\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
      {
        pattern:
          /^[ \t]*(?:@\w+[^\n]*\n[ \t]*)*(?:public|private|protected|internal|static|final|override|suspend|abstract|synchronized|\s)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:throws [\w., ]+)?\{/gm,
        kind: 'method',
        nameGroup: 1,
      },
      { pattern: /^[ \t]*(?:public|private|protected|internal|override|suspend|\s)*fun\s+([A-Za-z_]\w*)/gm, kind: 'function', nameGroup: 1 },
    ],
    imports: [{ pattern: /^\s*import\s+(?:static\s+)?([\w.*]+)/gm, group: 1, kind: 'import' }],
  },
  {
    languages: ['go'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, kind: 'function', nameGroup: 1, exportedTest: (l) => /func\s+(?:\([^)]*\)\s*)?[A-Z]/.test(l) },
      { pattern: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm, kind: 'struct', nameGroup: 1 },
      { pattern: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm, kind: 'interface', nameGroup: 1 },
    ],
    imports: [
      { pattern: /^\s*import\s+"([^"]+)"/gm, group: 1, kind: 'import' },
      { pattern: /^\s+(?:[\w.]+\s+)?"([\w./-]+)"$/gm, group: 1, kind: 'import' },
    ],
  },
  {
    languages: ['csharp'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^[ \t]*(?:public|internal|private|protected|abstract|sealed|static|partial|\s)*\b(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
      {
        pattern:
          /^[ \t]*(?:\[[^\]]+\]\s*\n[ \t]*)*(?:public|internal|private|protected|static|virtual|override|async|sealed|\s)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;)]*\)\s*\{?/gm,
        kind: 'method',
        nameGroup: 1,
      },
    ],
    imports: [{ pattern: /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm, group: 1, kind: 'import' }],
  },
  {
    languages: ['ruby'],
    blockStyle: 'ruby',
    symbols: [
      { pattern: /^[ \t]*class\s+([A-Za-z_][\w:]*)/gm, kind: 'class', nameGroup: 1 },
      { pattern: /^[ \t]*module\s+([A-Za-z_][\w:]*)/gm, kind: 'module', nameGroup: 1 },
      { pattern: /^[ \t]*def\s+((?:self\.)?[A-Za-z_]\w*[?!=]?)/gm, kind: 'method', nameGroup: 1 },
    ],
    imports: [{ pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm, group: 1, kind: 'require' }],
  },
  {
    languages: ['php'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^[ \t]*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
      { pattern: /^[ \t]*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)\s*\(/gm, kind: 'function', nameGroup: 1 },
    ],
    imports: [
      { pattern: /^\s*use\s+([\w\\]+)\s*;/gm, group: 1, kind: 'import' },
      { pattern: /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/gm, group: 1, kind: 'include' },
    ],
  },
  {
    languages: ['rust'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: 'function', nameGroup: 1, exportedTest: (l) => /\bpub\b/.test(l) },
      { pattern: /^[ \t]*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm, kind: 'struct', nameGroup: 1 },
      { pattern: /^[ \t]*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm, kind: 'interface', nameGroup: 1 },
      { pattern: /^[ \t]*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm, kind: 'enum', nameGroup: 1 },
    ],
    imports: [{ pattern: /^\s*use\s+([\w:{}, *]+);/gm, group: 1, kind: 'import' }],
  },
  {
    languages: ['swift'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^[ \t]*(?:public|private|internal|open|final|\s)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
      { pattern: /^[ \t]*(?:public|private|internal|static|override|\s)*func\s+([A-Za-z_]\w*)/gm, kind: 'function', nameGroup: 1 },
    ],
    imports: [{ pattern: /^\s*import\s+([\w.]+)/gm, group: 1, kind: 'import' }],
  },
  {
    languages: ['sql'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?/gim, kind: 'type', nameGroup: 1 },
      { pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+["`]?([\w.]+)["`]?/gim, kind: 'function', nameGroup: 1 },
    ],
    imports: [],
  },
  {
    languages: ['vue', 'svelte'],
    blockStyle: 'brace',
    symbols: [
      { pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/gm, kind: 'function', nameGroup: 1 },
      { pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/gm, kind: 'function', nameGroup: 1 },
    ],
    imports: [{ pattern: /import\s+[^'"]*['"]([^'"]+)['"]/gm, group: 1, kind: 'import' }],
  },
];

/**
 * Pattern-based analyzer used for languages where a full parser would mean a
 * native dependency. Symbol boundaries are resolved structurally (brace
 * matching / indentation), so line ranges stay accurate enough to cite.
 */
export class RegexLanguageAnalyzer implements LanguageAnalyzer {
  readonly name: string;

  constructor(private readonly spec: LanguageSpec) {
    this.name = `regex:${spec.languages.join(',')}`;
  }

  supports(language: Language): boolean {
    return this.spec.languages.includes(language);
  }

  parse(_filePath: string, content: string): ParseResult {
    const lines = content.split('\n');
    const symbols: ParsedSymbol[] = [];

    for (const rule of this.spec.symbols) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const name = match[rule.nameGroup];
        if (!name) continue;
        const startLine = lineAt(content, match.index);
        const declLine = lines[startLine - 1] ?? '';
        if (isCommentLine(declLine)) continue;

        const endLine = this.findEnd(content, lines, match.index, startLine);
        const body = lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
          name,
          kind: rule.kind,
          startLine,
          endLine,
          signature: declLine.trim().slice(0, 200),
          exported: rule.exportedTest ? rule.exportedTest(declLine) : !declLine.trim().startsWith('private'),
          isAsync: rule.asyncGroup ? Boolean(match[rule.asyncGroup]) : /\basync\b|\bsuspend\b/.test(declLine),
          complexity: estimateComplexity(body),
        });
        if (symbols.length > 2000) break;
      }
    }

    const imports: ParsedImport[] = [];
    const seen = new Set<string>();
    for (const rule of this.spec.imports) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const specifier = match[rule.group]?.trim();
        if (!specifier || seen.has(specifier)) continue;
        seen.add(specifier);
        imports.push({
          specifier,
          kind: rule.kind,
          isRelative: specifier.startsWith('.') || specifier.startsWith('/'),
        });
      }
    }

    symbols.sort((a, b) => a.startLine - b.startLine);
    return { symbols, imports, complexity: estimateComplexity(content), parser: this.name };
  }

  private findEnd(content: string, lines: string[], matchIndex: number, startLine: number): number {
    if (this.spec.blockStyle === 'indent') return endByIndent(lines, startLine);
    if (this.spec.blockStyle === 'ruby') return endByKeyword(lines, startLine);
    return endByBraces(content, lines, matchIndex, startLine);
  }
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
}

function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? (match[0] as string).replace(/\t/g, '    ').length : 0;
}

function endByIndent(lines: string[], startLine: number): number {
  const baseIndent = indentOf(lines[startLine - 1] ?? '');
  let lastContent = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) continue;
    // Dedent back to (or past) the declaration ends the block; trailing blank
    // lines belong to the file, not to the symbol.
    if (indentOf(line) <= baseIndent) return lastContent;
    lastContent = i + 1;
  }
  return lastContent;
}

function endByKeyword(lines: string[], startLine: number): number {
  const baseIndent = indentOf(lines[startLine - 1] ?? '');
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === 'end' && indentOf(line) === baseIndent) return i + 1;
  }
  return Math.min(lines.length, startLine + 60);
}

function endByBraces(content: string, lines: string[], matchIndex: number, startLine: number): number {
  const open = content.indexOf('{', matchIndex);
  if (open === -1) return startLine;
  // Bail out if the opening brace is far away - the match was probably not a block.
  if (lineAt(content, open) > startLine + 3) return startLine;

  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = open; i < content.length; i++) {
    const ch = content[i] as string;
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return lineAt(content, i);
    }
  }
  return lines.length;
}

export const REGEX_ANALYZERS: RegexLanguageAnalyzer[] = SPECS.map((spec) => new RegexLanguageAnalyzer(spec));
