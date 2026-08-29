import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { useEffect, useRef } from 'react';
import { monacoLanguage } from '@/lib/utils';

// Monaco is bundled locally rather than fetched from a CDN: the tool must work
// on an isolated network and must not ship third-party script tags.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

let themeDefined = false;
function defineTheme(instance: typeof monaco): void {
  if (themeDefined) return;
  instance.editor.defineTheme('codebase-ai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7488', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7aa2ff' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'e5b447' },
      { token: 'type', foreground: '7dcfff' },
    ],
    colors: {
      'editor.background': '#0a0c10',
      'editor.foreground': '#e6e9ef',
      'editorLineNumber.foreground': '#3a4152',
      'editorLineNumber.activeForeground': '#9aa4b8',
      'editor.lineHighlightBackground': '#12161e',
      'editor.selectionBackground': '#284169',
      'editorGutter.background': '#0a0c10',
      'editorWidget.background': '#161a22',
      'editorIndentGuide.background1': '#1a1f29',
      'scrollbarSlider.background': '#262c3880',
    },
  });
  themeDefined = true;
}

export interface CodeHighlight {
  startLine: number;
  endLine?: number;
  /** Rendered as a coloured gutter marker + line background. */
  tone?: 'accent' | 'danger' | 'warn';
  message?: string;
}

export interface CodeViewerProps {
  value: string;
  path: string;
  language?: string | null;
  highlights?: CodeHighlight[];
  revealLine?: number | null;
  onSelectionChange?: (selection: { startLine: number; endLine: number; text: string } | null) => void;
  readOnly?: boolean;
  height?: string;
}

export function CodeViewer({
  value,
  path,
  language,
  highlights = [],
  revealLine,
  onSelectionChange,
  readOnly = true,
  height = '100%',
}: CodeViewerProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const handleMount: OnMount = (editor, instance) => {
    editorRef.current = editor;
    defineTheme(instance as unknown as typeof monaco);
    instance.editor.setTheme('codebase-ai');
    decorationsRef.current = editor.createDecorationsCollection();

    editor.onDidChangeCursorSelection(() => {
      if (!onSelectionChange) return;
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model || selection.isEmpty()) {
        onSelectionChange(null);
        return;
      }
      onSelectionChange({
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        text: model.getValueInRange(selection),
      });
    });
  };

  // Apply finding/citation highlights.
  useEffect(() => {
    const collection = decorationsRef.current;
    if (!collection) return;
    collection.set(
      highlights.map((highlight) => ({
        range: new monaco.Range(highlight.startLine, 1, highlight.endLine ?? highlight.startLine, 1),
        options: {
          isWholeLine: true,
          className:
            highlight.tone === 'danger'
              ? 'bg-severity-critical/10'
              : highlight.tone === 'warn'
                ? 'bg-severity-medium/10'
                : 'bg-accent/10',
          linesDecorationsClassName:
            highlight.tone === 'danger'
              ? 'border-l-2 border-severity-critical'
              : highlight.tone === 'warn'
                ? 'border-l-2 border-severity-medium'
                : 'border-l-2 border-accent',
          hoverMessage: highlight.message ? { value: highlight.message } : undefined,
        },
      })),
    );
  }, [highlights, value]);

  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    editorRef.current.revealLineInCenter(revealLine);
    editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
  }, [revealLine, value]);

  return (
    <Editor
      height={height}
      path={path}
      language={monacoLanguage(language, path)}
      value={value}
      onMount={handleMount}
      theme="codebase-ai"
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: true, maxColumn: 80 },
        fontSize: 12.5,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
        lineHeight: 1.6,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        smoothScrolling: true,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 12, bottom: 32 },
        bracketPairColorization: { enabled: true },
        stickyScroll: { enabled: true },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}
