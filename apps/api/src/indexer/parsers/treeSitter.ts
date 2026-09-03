/**
 * Real syntax trees for the languages that had none.
 *
 * TypeScript and JavaScript are parsed by the TypeScript compiler, so their
 * symbols and imports are exact. Everything else fell back to line-oriented
 * regular expressions, which miss a decorated Python function, a method inside
 * a class, a multi-line Java signature, and a grouped Go import block - and
 * every downstream feature is built on those symbols. Chunking splits on them,
 * the architecture view counts them, retrieval cites them.
 *
 * Grammars are WebAssembly, so there is no native module to compile and the
 * image builds the same way on every platform. `web-tree-sitter` is pinned:
 * grammar binaries are built against a specific runtime ABI and a newer runtime
 * rejects them outright.
 */

import * as path from 'node:path';
import type { Language } from '../languages';
import {
  EMPTY_PARSE,
  estimateComplexity,
  type LanguageAnalyzer,
  type ParseResult,
  type ParsedImport,
  type ParsedSymbol,
  type SymbolKind,
} from './types';

/** Minimal shape of the tree-sitter nodes this file touches. */
interface TsNode {
  type: string;
  text: string;
  childCount: number;
  startPosition: { row: number };
  endPosition: { row: number };
  child(index: number): TsNode | null;
  childForFieldName(field: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree;
}

/** Languages with a grammar vendored next to this file. */
const GRAMMARS: Partial<Record<Language, string>> = {
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
};

const parsers = new Map<Language, TsParser>();
let initialised = false;

/**
 * Loads the grammars once.
 *
 * Never throws: a missing or incompatible grammar leaves the language on its
 * regular-expression analyzer, which is worse but not broken. Callers that skip
 * this get exactly the behaviour they had before.
 */
export async function initTreeSitter(): Promise<string[]> {
  if (initialised) return [...parsers.keys()];
  initialised = true;

  const loaded: string[] = [];
  try {
    const mod = (await import('web-tree-sitter')) as unknown as Record<string, unknown>;
    const runtime = (mod.Parser ?? mod.default ?? mod) as {
      init(): Promise<void>;
      new (): TsParser;
      Language?: { load(p: string): Promise<unknown> };
    };
    await runtime.init();
    const LanguageLoader = (mod.Language ?? runtime.Language) as { load(p: string): Promise<unknown> };

    for (const [language, file] of Object.entries(GRAMMARS)) {
      try {
        const grammar = await LanguageLoader.load(path.join(__dirname, 'wasm', file));
        const parser = new runtime();
        parser.setLanguage(grammar);
        parsers.set(language as Language, parser);
        loaded.push(language);
      } catch {
        // One bad grammar must not cost the others.
      }
    }
  } catch {
    // web-tree-sitter unavailable; every language keeps its regex analyzer.
  }
  return loaded;
}

/** Test seam: forget the loaded grammars so a later call re-initialises. */
export function resetTreeSitter(): void {
  parsers.clear();
  initialised = false;
}

function walk(node: TsNode, visit: (node: TsNode, parent: TsNode | null) => void, parent: TsNode | null = null): void {
  visit(node, parent);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, visit, node);
  }
}

const nameOf = (node: TsNode): string => node.childForFieldName('name')?.text ?? '';
const lines = (node: TsNode): { startLine: number; endLine: number } => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + 1,
});

/**
 * Node types that carry a symbol, per language. The `kind` is what the rest of
 * the platform reasons about, so a Go struct is a struct and a Java interface
 * is an interface rather than everything collapsing to "function".
 */
const SYMBOL_NODES: Record<string, Record<string, SymbolKind>> = {
  python: { function_definition: 'function', class_definition: 'class' },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  java: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    method_declaration: 'method',
    record_declaration: 'class',
  },
};

const CONTAINER_NODES = new Set(['class_definition', 'class_declaration', 'interface_declaration', 'enum_declaration']);

function extractSymbols(root: TsNode, language: Language, source: string): ParsedSymbol[] {
  const table = SYMBOL_NODES[language] ?? {};
  const symbols: ParsedSymbol[] = [];
  const stack: string[] = [];

  const visit = (node: TsNode): void => {
    const kind = table[node.type];
    if (!kind) return;
    const name = nameOf(node);
    if (!name) return;

    const parentName = stack[stack.length - 1];
    const { startLine, endLine } = lines(node);
    // A function nested in a class is a method, whatever the grammar calls it.
    const effective: SymbolKind = kind === 'function' && parentName ? 'method' : kind;
    const body = source.split('\n').slice(startLine - 1, endLine).join('\n');

    symbols.push({
      name,
      kind: effective,
      startLine,
      endLine,
      exported: isExported(name, language),
      isAsync: /(^|\s)async\s/.test(node.text.slice(0, 120)),
      complexity: estimateComplexity(body),
      ...(parentName ? { parentName } : {}),
    });
  };

  const descend = (node: TsNode, parent: TsNode | null): void => {
    visit(node);
    if (CONTAINER_NODES.has(node.type)) {
      const name = nameOf(node);
      if (name) stack.push(name);
    }
    void parent;
  };

  // The stack has to unwind, so containers are walked explicitly rather than
  // through the generic walker.
  const recurse = (node: TsNode): void => {
    const isContainer = CONTAINER_NODES.has(node.type);
    descend(node, null);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) recurse(child);
    }
    if (isContainer && nameOf(node)) stack.pop();
  };
  recurse(root);

  return symbols;
}

/** Python has no export keyword; a leading underscore is the convention. */
function isExported(name: string, language: Language): boolean {
  if (language === 'python') return !name.startsWith('_');
  if (language === 'go') return /^[A-Z]/.test(name);
  return true;
}

const IMPORT_NODES: Record<string, string[]> = {
  python: ['import_statement', 'import_from_statement'],
  go: ['import_spec'],
  java: ['import_declaration'],
};

function extractImports(root: TsNode, language: Language): ParsedImport[] {
  const wanted = new Set(IMPORT_NODES[language] ?? []);
  const imports: ParsedImport[] = [];
  const seen = new Set<string>();

  walk(root, (node) => {
    if (!wanted.has(node.type)) return;
    for (const specifier of specifiersOf(node, language)) {
      if (!specifier || seen.has(specifier)) continue;
      seen.add(specifier);
      imports.push({
        specifier,
        kind: 'import',
        isRelative: specifier.startsWith('.'),
      });
    }
  });
  return imports;
}

function specifiersOf(node: TsNode, language: Language): string[] {
  if (language === 'go') {
    // `import "fmt"` and the grouped form both land here as a quoted path.
    return [node.text.replace(/^[\w.]*\s*/, '').replace(/^["`]|["`]$/g, '')];
  }
  if (language === 'java') {
    return [node.text.replace(/^import\s+(?:static\s+)?/, '').replace(/;$/, '').trim()];
  }
  // Python: `from a.b import c` names module a.b; `import a, b` names both.
  const moduleName = node.childForFieldName('module_name')?.text;
  if (moduleName) return [moduleName];
  return node.text
    .replace(/^import\s+/, '')
    .split(',')
    .map((part) => (part.split(/\s+as\s+/)[0] ?? '').trim())
    .filter(Boolean);
}

/**
 * One analyzer per language, so the registry's `supports` check stays a simple
 * equality and the parse call knows which grammar it holds.
 */
export class TreeSitterAnalyzer implements LanguageAnalyzer {
  readonly name: string;

  constructor(private readonly language: Language) {
    this.name = `tree-sitter:${language}`;
  }

  /**
   * False until the grammar is loaded, so before initTreeSitter runs the
   * registry falls through to the regular-expression analyzer rather than this
   * one claiming the language and returning nothing.
   */
  supports(language: Language): boolean {
    return language === this.language && parsers.has(this.language);
  }

  parse(_filePath: string, content: string): ParseResult {
    const parser = parsers.get(this.language);
    if (!parser) return EMPTY_PARSE('tree-sitter:unavailable');
    const tree = parser.parse(content);
    return {
      symbols: extractSymbols(tree.rootNode, this.language, content),
      imports: extractImports(tree.rootNode, this.language),
      complexity: estimateComplexity(content),
      parser: this.name,
    };
  }
}

/** An analyzer for every grammar this build ships. */
export const TREE_SITTER_ANALYZERS: LanguageAnalyzer[] = Object.keys(GRAMMARS).map(
  (language) => new TreeSitterAnalyzer(language as Language),
);
