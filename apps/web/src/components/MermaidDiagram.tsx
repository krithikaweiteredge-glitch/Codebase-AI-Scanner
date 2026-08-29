import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { cn } from '@/lib/utils';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  themeVariables: {
    background: '#0a0c10',
    primaryColor: '#161a22',
    primaryTextColor: '#e6e9ef',
    primaryBorderColor: '#31384a',
    lineColor: '#4f8cff',
    secondaryColor: '#1c212b',
    tertiaryColor: '#101319',
  },
});

let counter = 0;

/** Renders a mermaid diagram, surfacing syntax errors instead of blanking out. */
export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++counter}`;

    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setError(null);
      })
      .catch((renderError: unknown) => {
        if (cancelled) return;
        setError(renderError instanceof Error ? renderError.message : 'Diagram could not be rendered');
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="rounded-md border border-warn/30 bg-warn/5 p-3">
        <p className="text-xs font-medium text-warn">The diagram could not be rendered</p>
        <p className="mt-1 text-2xs text-ink-muted">{error}</p>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-canvas p-2 font-mono text-2xs text-ink-muted">{chart}</pre>
      </div>
    );
  }

  return <div ref={containerRef} className={cn('overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full', className)} />;
}
