import ts from 'typescript';
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

const SUPPORTED: ReadonlySet<Language> = new Set<Language>(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * Real AST parsing for the TypeScript/JavaScript family via the TypeScript
 * compiler API (single-file parse - no program/type-checker, which keeps
 * indexing fast and side-effect free).
 */
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly name = 'typescript-compiler-api';

  supports(language: Language): boolean {
    return SUPPORTED.has(language);
  }

  parse(filePath: string, content: string): ParseResult {
    let source: ts.SourceFile;
    try {
      source = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        scriptKind(filePath),
      );
    } catch {
      return EMPTY_PARSE(this.name);
    }

    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];

    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

    const push = (
      node: ts.Node,
      name: string,
      kind: SymbolKind,
      opts: { exported?: boolean; isAsync?: boolean; parentName?: string; signature?: string } = {},
    ): void => {
      if (!name) return;
      const text = node.getText(source);
      symbols.push({
        name,
        kind,
        startLine: lineOf(node.getStart(source)),
        endLine: lineOf(node.getEnd()),
        exported: opts.exported ?? hasExportModifier(node),
        isAsync: opts.isAsync ?? hasAsyncModifier(node),
        complexity: estimateComplexity(text),
        ...(opts.parentName ? { parentName: opts.parentName } : {}),
        ...(opts.signature ? { signature: opts.signature } : { signature: firstLine(text) }),
      });
    };

    const visit = (node: ts.Node, parentName?: string): void => {
      // ---- imports -------------------------------------------------------
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(toImport(node.moduleSpecifier.text, 'import'));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(toImport(node.moduleSpecifier.text, 'import'));
      } else if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (expr.kind === ts.SyntaxKind.ImportKeyword) imports.push(toImport(arg.text, 'dynamic-import'));
          else if (ts.isIdentifier(expr) && expr.text === 'require') imports.push(toImport(arg.text, 'require'));
        }
      }

      // ---- declarations --------------------------------------------------
      if (ts.isFunctionDeclaration(node) && node.name) {
        push(node, node.name.text, isReactComponent(node.name.text, node, source) ? 'component' : 'function');
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        push(node, className, 'class');
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
            const memberName = ts.isConstructorDeclaration(member)
              ? 'constructor'
              : memberNameOf(member.name);
            if (memberName) push(member, memberName, 'method', { parentName: className, exported: false });
          } else if (
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ) {
            const memberName = memberNameOf(member.name);
            if (memberName) push(member, memberName, 'method', { parentName: className, exported: false });
          }
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        push(node, node.name.text, 'interface');
      } else if (ts.isTypeAliasDeclaration(node)) {
        push(node, node.name.text, 'type');
      } else if (ts.isEnumDeclaration(node)) {
        push(node, node.name.text, 'enum');
      } else if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        push(node, node.name.text, 'module');
      } else if (ts.isVariableStatement(node)) {
        const exported = hasExportModifier(node);
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            const kind: SymbolKind = isReactComponent(name, init, source) ? 'component' : 'function';
            symbols.push({
              name,
              kind,
              startLine: lineOf(node.getStart(source)),
              endLine: lineOf(node.getEnd()),
              exported,
              isAsync: Boolean(init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
              complexity: estimateComplexity(node.getText(source)),
              signature: firstLine(node.getText(source)),
            });
          } else if (exported && init && !ts.isLiteralExpression(init)) {
            push(node, name, 'constant', { exported: true });
          }
        }
      }

      const nextParent =
        ts.isClassDeclaration(node) && node.name ? node.name.text : parentName;
      ts.forEachChild(node, (child) => visit(child, nextParent));
    };

    visit(source);

    return {
      symbols: dedupe(symbols),
      imports: dedupeImports(imports),
      complexity: estimateComplexity(content),
      parser: this.name,
    };
  }
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword));
}

function hasAsyncModifier(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function memberNameOf(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

function isReactComponent(name: string, node: ts.Node, source: ts.SourceFile): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  const text = node.getText(source);
  return /<[A-Za-z][^>]*>/.test(text) || /React\.createElement|jsx\(/.test(text);
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.trim().slice(0, 200);
}

function toImport(specifier: string, kind: ParsedImport['kind']): ParsedImport {
  return { specifier, kind, isRelative: specifier.startsWith('.') || specifier.startsWith('/') };
}

function dedupe(symbols: ParsedSymbol[]): ParsedSymbol[] {
  const seen = new Set<string>();
  const out: ParsedSymbol[] = [];
  for (const s of symbols) {
    const key = `${s.parentName ?? ''}#${s.name}#${s.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function dedupeImports(imports: ParsedImport[]): ParsedImport[] {
  const seen = new Set<string>();
  return imports.filter((i) => {
    const key = `${i.kind}:${i.specifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
