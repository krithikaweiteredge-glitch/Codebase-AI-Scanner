import type { Language } from '../languages';
import { REGEX_ANALYZERS } from './generic';
import { TypeScriptAnalyzer } from './typescript';
import { EMPTY_PARSE, type LanguageAnalyzer, type ParseResult } from './types';

/**
 * Language adapter registry. Adding a language means adding one analyzer here;
 * everything downstream (chunking, symbols, dependencies, retrieval) is generic.
 */
const ANALYZERS: LanguageAnalyzer[] = [new TypeScriptAnalyzer(), ...REGEX_ANALYZERS];

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
export { RegexLanguageAnalyzer } from './generic';
export * from './types';
