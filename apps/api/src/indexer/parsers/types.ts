import type { Language } from '../languages';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'component'
  | 'constant'
  | 'module'
  | 'struct';

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  parentName?: string;
  exported: boolean;
  isAsync: boolean;
  complexity: number;
}

export interface ParsedImport {
  specifier: string;
  kind: 'import' | 'require' | 'dynamic-import' | 'include';
  isRelative: boolean;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** Cyclomatic-ish complexity for the whole file. */
  complexity: number;
  parser: string;
}

export interface LanguageAnalyzer {
  readonly name: string;
  supports(language: Language): boolean;
  parse(filePath: string, content: string): ParseResult;
}

export const EMPTY_PARSE = (parser: string): ParseResult => ({
  symbols: [],
  imports: [],
  complexity: 0,
  parser,
});

/** Branch keywords contribute one point each - language agnostic approximation. */
const BRANCH_PATTERN =
  /\b(if|else if|elif|for|foreach|while|case|catch|switch\s*\(|\?\?|&&|\|\||\?[^.]|=>\s*\{)/g;

export function estimateComplexity(source: string): number {
  const matches = source.match(BRANCH_PATTERN);
  return 1 + (matches ? matches.length : 0);
}
