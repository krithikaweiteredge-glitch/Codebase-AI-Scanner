import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CitationList } from '@/components/CitationList';
import { Markdown } from '@/components/Markdown';
import { SeverityBadge, StatusBadge } from '@/components/ui/primitives';

describe('Markdown', () => {
  it('renders markdown and makes file references clickable', async () => {
    const onOpen = vi.fn();
    render(
      <Markdown
        content={'Authentication starts in `src/auth/AuthService.ts:42` and continues in the middleware.'}
        onOpenReference={onOpen}
      />,
    );

    const reference = screen.getByRole('button', { name: 'src/auth/AuthService.ts:42' });
    await userEvent.click(reference);
    expect(onOpen).toHaveBeenCalledWith('src/auth/AuthService.ts', 42);
  });

  it('renders line ranges as a single reference', async () => {
    const onOpen = vi.fn();
    render(<Markdown content={'See `src/middleware/auth.ts:10-45`.'} onOpenReference={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'src/middleware/auth.ts:10-45' }));
    expect(onOpen).toHaveBeenCalledWith('src/middleware/auth.ts', 10);
  });

  it('strips script tags from model output', () => {
    const { container } = render(<Markdown content={'Hello <script>window.__pwned = true;</script> world'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('Hello');
  });
});

describe('CitationList', () => {
  const citations = [
    { filePath: 'src/auth/AuthService.ts', startLine: 31, endLine: 72, valid: true },
    { filePath: 'src/middleware/auth.ts', startLine: 10, endLine: 45, valid: true },
  ];

  it('lists verified sources and opens them', async () => {
    const onOpen = vi.fn();
    render(<CitationList citations={citations} onOpen={onOpen} />);

    expect(screen.getByText(/Sources · verified against the index/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText('src/auth/AuthService.ts:31-72'));
    expect(onOpen).toHaveBeenCalledWith('src/auth/AuthService.ts', 31);
  });

  it('surfaces references that were discarded as ungrounded', () => {
    render(
      <CitationList
        citations={citations}
        invalid={[{ filePath: 'src/does/not/Exist.ts', startLine: 12, valid: false, reason: 'not indexed' }]}
      />,
    );
    expect(screen.getByText(/did not resolve to indexed files/i)).toBeInTheDocument();
    expect(screen.getByText('src/does/not/Exist.ts')).toBeInTheDocument();
  });
});

describe('finding badges', () => {
  it('labels the provenance of a finding', () => {
    render(
      <div>
        <SeverityBadge severity="critical" />
        <StatusBadge status="confirmed" source="static" />
        <StatusBadge status="potential" source="ai" />
        <StatusBadge status="likely" source="hybrid" />
      </div>,
    );

    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('confirmed · static')).toBeInTheDocument();
    expect(screen.getByText('potential · AI')).toBeInTheDocument();
    expect(screen.getByText('likely · static+AI')).toBeInTheDocument();
  });
});
