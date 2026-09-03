import { beforeAll, describe, expect, it } from 'vitest';
import { initTreeSitter, parseFile } from '../indexer/parsers';

let loaded: string[] = [];

beforeAll(async () => {
  loaded = await initTreeSitter();
});

describe('tree-sitter grammars', () => {
  it('loads the vendored grammars', () => {
    expect(loaded).toEqual(expect.arrayContaining(['python', 'go', 'java']));
  });
});

describe('python, parsed properly', () => {
  const source = [
    'import os',
    'from typing import List',
    'from .models import User',
    '',
    '@requires_auth',
    'def list_users(limit: int = 10) -> List[User]:',
    '    return []',
    '',
    'class UserRepository:',
    '    """A docstring containing def not_a_function(): to fool a regex."""',
    '    def find_by_email(self, email):',
    '        return None',
    '',
    '    async def save(self, user):',
    '        pass',
  ].join('\n');

  it('uses the grammar rather than the regular expressions', () => {
    expect(parseFile('app/repo.py', source, 'python').parser).toBe('tree-sitter:python');
  });

  it('knows a method from a function, and its class', () => {
    const { symbols } = parseFile('app/repo.py', source, 'python');
    const find = symbols.find((s) => s.name === 'find_by_email');
    expect(find?.kind).toBe('method');
    expect(find?.parentName).toBe('UserRepository');
    // The regex analyzer reported this as a bare function with no parent, which
    // is what the chunker uses to decide whether to split a class by members.
    expect(symbols.find((s) => s.name === 'list_users')?.kind).toBe('function');
  });

  it('sees async and the underscore convention for visibility', () => {
    const { symbols } = parseFile('app/repo.py', source, 'python');
    expect(symbols.find((s) => s.name === 'save')?.isAsync).toBe(true);
    expect(symbols.find((s) => s.name === 'find_by_email')?.exported).toBe(true);
    const priv = parseFile('a.py', 'def _helper():\n    pass\n', 'python').symbols[0];
    expect(priv?.exported).toBe(false);
  });

  it('is not fooled by a definition inside a docstring', () => {
    const { symbols } = parseFile('app/repo.py', source, 'python');
    expect(symbols.map((s) => s.name)).not.toContain('not_a_function');
  });

  it('records the modules it imports', () => {
    const { imports } = parseFile('app/repo.py', source, 'python');
    expect(imports.map((i) => i.specifier)).toEqual(expect.arrayContaining(['os', 'typing', '.models']));
    expect(imports.find((i) => i.specifier === '.models')?.isRelative).toBe(true);
  });
});

describe('go, parsed properly', () => {
  const source = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"github.com/gin-gonic/gin"',
    ')',
    '',
    'type Server struct {',
    '\tport int',
    '}',
    '',
    'func (s *Server) Start() error {',
    '\treturn nil',
    '}',
    '',
    'func unexported() {}',
  ].join('\n');

  it('reads a grouped import block, which a line-oriented rule cannot', () => {
    const { imports } = parseFile('main.go', source, 'go');
    expect(imports.map((i) => i.specifier)).toEqual(expect.arrayContaining(['fmt', 'github.com/gin-gonic/gin']));
  });

  it('uses the capital-letter convention for visibility', () => {
    const { symbols } = parseFile('main.go', source, 'go');
    expect(symbols.find((s) => s.name === 'Start')?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'unexported')?.exported).toBe(false);
  });
});

describe('java, parsed properly', () => {
  const source = [
    'package com.example.app;',
    '',
    'import java.util.List;',
    'import static org.junit.Assert.assertTrue;',
    '',
    'public interface Repo {',
    '    List<String> findAll();',
    '}',
    '',
    'public class UserRepo implements Repo {',
    '    public List<String> findAll() {',
    '        return null;',
    '    }',
    '}',
  ].join('\n');

  it('distinguishes an interface from a class', () => {
    const { symbols } = parseFile('Repo.java', source, 'java');
    expect(symbols.find((s) => s.name === 'Repo')?.kind).toBe('interface');
    expect(symbols.find((s) => s.name === 'UserRepo')?.kind).toBe('class');
  });

  it('attributes a method to the type that declares it', () => {
    const { symbols } = parseFile('Repo.java', source, 'java');
    const methods = symbols.filter((s) => s.name === 'findAll');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.map((m) => m.parentName)).toEqual(expect.arrayContaining(['UserRepo']));
  });

  it('strips the static modifier from an import', () => {
    const { imports } = parseFile('Repo.java', source, 'java');
    expect(imports.map((i) => i.specifier)).toEqual(
      expect.arrayContaining(['java.util.List', 'org.junit.Assert.assertTrue']),
    );
  });
});
