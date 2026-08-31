import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/primitives';

interface Props {
  children: ReactNode;
  /**
   * Changing this resets the boundary. Route paths are passed in so navigating
   * away from a broken page recovers, instead of stranding the user on the
   * error screen until they reload.
   */
  resetKey?: string;
  /** Shown instead of the default screen, when a caller wants something smaller. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so one broken subtree does not blank the app.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * which turns a single bad value in one component into a white page with no
 * way back. That risk is concentrated here in the heavy third-party views -
 * Monaco and Mermaid both render content derived from indexed repositories, so
 * they see input this app did not produce.
 *
 * Error boundaries only catch render, lifecycle and constructor errors. Event
 * handlers and async rejections still need their own handling; TanStack Query
 * covers the data-fetching half.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    // A new resetKey means the user navigated; give the subtree a clean slate.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-danger/30 bg-danger/5 p-5">
          <p className="text-sm font-semibold text-danger">This view failed to render</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            The rest of the app is still running. Try again, or move to another page.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[11px] leading-relaxed text-ink-muted">
            {error.message}
          </pre>
          <div className="mt-3 flex gap-2">
            <Button onClick={this.reset}>Try again</Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
