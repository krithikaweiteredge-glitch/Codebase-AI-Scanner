import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function Boom({ explode = true }: { explode?: boolean }): JSX.Element {
  if (explode) throw new Error('component exploded');
  return <p>recovered content</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors, and the boundary logs its own. Neither
    // is a test failure, so keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('catches a render error instead of unmounting the tree', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('This view failed to render')).toBeInTheDocument();
    // The actual message is surfaced so the user can report something useful.
    expect(screen.getByText(/component exploded/)).toBeInTheDocument();
  });

  it('leaves everything outside the boundary mounted', () => {
    render(
      <div>
        <nav>navigation still here</nav>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </div>,
    );

    // The whole point: a broken page must not take the shell down with it.
    expect(screen.getByText('navigation still here')).toBeInTheDocument();
  });

  it('retries the subtree when the user asks', async () => {
    function Flaky() {
      // Throws on first render, succeeds after the module-level flag flips.
      if (!recovered) throw new Error('component exploded');
      return <p>recovered content</p>;
    }
    let recovered = false;

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This view failed to render')).toBeInTheDocument();

    recovered = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('recovered content')).toBeInTheDocument();
  });

  it('resets itself when the route changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/repositories/1/explorer">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This view failed to render')).toBeInTheDocument();

    // Navigating away must recover without a reload.
    rerender(
      <ErrorBoundary resetKey="/settings">
        <Boom explode={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('recovered content')).toBeInTheDocument();
  });

  it('uses a caller-supplied fallback when given one', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('custom: component exploded')).toBeInTheDocument();
    expect(screen.queryByText('This view failed to render')).not.toBeInTheDocument();
  });
});
