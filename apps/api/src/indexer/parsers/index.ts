import type { Language } from '../languages';
import { REGEX_ANALYZERS } from './generic';
import { TREE_SITTER_ANALYZERS } from './treeSitter';
import { TypeScriptAnalyzer } from './typescript';
import { EMPTY_PARSE, type LanguageAnalyzer, type ParseResult } from './types';

/**
 * Language adapter registry. Adding a language means adding one analyzer here;
 * everything downstream (chunking, symbols, dependencies, retrieval) is generic.
 */
// Order matters: the first analyzer that claims a language wins. A tree-sitter
// analyzer only claims one once its grammar is loaded, so before
// initTreeSitter runs - and if a grammar fails to load at all - the language
// keeps the regular-expression analyzer it had.
const ANALYZERS: LanguageAnalyzer[] = [new TypeScriptAnalyzer(), ...TREE_SITTER_ANALYZERS, ...REGEX_ANALYZERS];

export function analyzerFor(language: Language): LanguageAnalyzer | null {
  return ANALYZERS.find((a) => a.supports(language)) ?? null;
}

export function parseFile(filePath: string, content: string, language: Language): ParseResult {
  const analyzer = analyzerFor(language);
  if (!analyzer) return EMPTY_PARSE('none');
  try {
    return analyzer.parse(filePath, content);
  } catch {
    return EMPTY_PARSE(`${analyzer.name}:failed`);
  }
}

export { TypeScriptAnalyzer } from './typescript';
export { initTreeSitter, resetTreeSitter, TreeSitterAnalyzer } from './treeSitter';
export { RegexLanguageAnalyzer } from './generic';
export * from './types';
