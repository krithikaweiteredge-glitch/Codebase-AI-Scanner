import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';

marked.setOptions({ gfm: true, breaks: false });

/** `src/auth/AuthService.ts:31-72` inside an inline code span. */
const CODE_REFERENCE = /<code>((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?<\/code>/g;

export interface MarkdownProps {
  content: string;
  className?: string;
  /** Called when the reader clicks a `path:line` reference in the text. */
  onOpenReference?: (filePath: string, line?: number) => void;
}

/**
 * Renders model- and generator-produced markdown.
 *
 * The HTML is sanitised before it reaches the DOM, and file references written
 * as `path:line` become clickable so an answer can be traced straight to code.
 */
export function Markdown({ content, className, onOpenReference }: MarkdownProps) {
  const html = useMemo(() => {
    const parsed = marked.parse(content ?? '', { async: false }) as string;
    const withReferences = onOpenReference
      ? parsed.replace(CODE_REFERENCE, (_match, path: string, start: string, end?: string) => {
          const range = end ? `${start}-${end}` : start;
          return `<button type="button" class="code-ref" data-file="${escapeAttribute(path)}" data-line="${start}">${escapeHtml(
            `${path}:${range}`,
          )}</button>`;
        })
      : parsed;

    return DOMPurify.sanitize(withReferences, {
      ADD_ATTR: ['data-file', 'data-line', 'type'],
      FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
  }, [content, onOpenReference]);

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onOpenReference) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
    if (!target) return;
    event.preventDefault();
    const file = target.dataset.file;
    const line = Number(target.dataset.line);
    if (file) onOpenReference(file, Number.isFinite(line) ? line : undefined);
  };

  return (
    <div
      className={cn('prose-code', className)}
      onClick={handleClick}
      // Sanitised immediately above; markdown is the only supported rich format.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
