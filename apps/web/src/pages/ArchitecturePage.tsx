import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Network } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, Tabs } from '@/components/ui/primitives';
import { get } from '@/lib/api';
import type { ArchitectureInsight, DependencyGraph } from '@/lib/types';
import { formatNumber } from '@/lib/utils';

export function ArchitecturePage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const [tab, setTab] = useState<'diagram' | 'layers' | 'graph'>('diagram');

  const architecture = useQuery({
    queryKey: ['architecture', repositoryId],
    queryFn: () => get<{ architecture: ArchitectureInsight }>(`/api/repositories/${repositoryId}/architecture`),
    enabled: Boolean(repositoryId),
    retry: false,
  });

  const graph = useQuery({
    queryKey: ['dependencies', repositoryId],
    queryFn: () => get<{ branch: string; graph: DependencyGraph }>(`/api/repositories/${repositoryId}/dependencies`),
    enabled: Boolean(repositoryId),
  });

  if (architecture.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (architecture.isError) {
    return (
      <Card className="m-5">
        <EmptyState
          icon={<Network className="h-8 w-8" />}
          title="Architecture analysis has not run yet"
          description="Run a full analysis on this repository. The diagram is built from the real import graph; the narrative needs an AI provider."
        />
      </Card>
    );
  }

  const insight = architecture.data?.architecture;
  if (!insight) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">Architecture</h1>
            <p className="mt-0.5 text-xs text-ink-muted">
              {formatNumber(insight.graphSummary.files)} files · {formatNumber(insight.graphSummary.edges)} internal
              imports · {insight.graphSummary.externalPackages} external packages · {insight.graphSummary.cycles} import
              cycles
            </p>
          </div>
          <Badge tone={insight.generatedBy === 'ai' ? 'accent' : 'neutral'}>
            {insight.generatedBy === 'ai' ? 'AI narrative + real graph' : 'derived from the import graph'}
          </Badge>
        </div>
        <Tabs
          className="mt-3 border-b-0"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'diagram', label: 'Diagram' },
            { value: 'layers', label: 'Layers & flows' },
            { value: 'graph', label: 'Dependency graph' },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'diagram' ? (
          <div className="space-y-4">
            {insight.summary ? (
              <Card className="p-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{insight.summary}</p>
              </Card>
            ) : null}
            <Card className="p-4">
              <MermaidDiagram chart={insight.mermaid} />
            </Card>
          </div>
        ) : tab === 'layers' ? (
          <div className="space-y-4">
            {insight.layers?.length ? (
              <Card>
                <CardHeader title="Layers" />
                <div className="divide-y divide-line">
                  {insight.layers.map((layer) => (
                    <div key={layer.name} className="px-4 py-3">
                      <p className="text-sm font-medium text-ink">{layer.name}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{layer.purpose}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {layer.directories.map((directory) => (
                          <Badge key={directory} tone="neutral">
                            {directory}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {insight.flows?.length ? (
              <Card>
                <CardHeader title="Key flows" description="Each step is a real function in the indexed code" />
                <div className="space-y-4 p-4">
                  {insight.flows.map((flow) => (
                    <div key={flow.name}>
                      <p className="text-xs font-semibold text-ink">{flow.name}</p>
                      <ol className="mt-1.5 space-y-1">
                        {flow.steps.map((step, index) => (
                          <li key={index} className="flex items-start gap-2 text-xs">
                            <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
                            <span className="min-w-0">
                              <span className="text-ink">{step.label}</span>
                              {step.filePath ? (
                                <Link
                                  to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(step.filePath)}${
                                    step.startLine ? `&line=${step.startLine}` : ''
                                  }`}
                                  className="ml-2 font-mono text-2xs text-accent hover:underline"
                                >
                                  {step.filePath}
                                  {step.startLine ? `:${step.startLine}` : ''}
                                </Link>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {insight.directoryPurposes?.length ? (
              <Card>
                <CardHeader title="Directory purposes" />
                <div className="divide-y divide-line">
                  {insight.directoryPurposes.map((directory) => (
                    <div key={directory.path} className="px-4 py-3">
                      <p className="font-mono text-xs text-accent">{directory.path}</p>
                      <p className="mt-1 text-xs text-ink-muted">{directory.purpose}</p>
                      {directory.responsibilities.length ? (
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-2xs text-ink-muted">
                          {directory.responsibilities.map((responsibility) => (
                            <li key={responsibility}>{responsibility}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {insight.risks?.length ? (
              <Card>
                <CardHeader title="Architectural risks" />
                <div className="divide-y divide-line">
                  {insight.risks.map((risk) => (
                    <div key={risk.title} className="flex items-start gap-2 px-4 py-3">
                      <AlertTriangle
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                          risk.severity === 'high' ? 'text-danger' : risk.severity === 'medium' ? 'text-warn' : 'text-ink-faint'
                        }`}
                      />
                      <div>
                        <p className="text-xs font-medium text-ink">{risk.title}</p>
                        <p className="mt-0.5 text-xs text-ink-muted">{risk.detail}</p>
                        {risk.filePath ? (
                          <Link
                            to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(risk.filePath)}`}
                            className="mt-1 block font-mono text-2xs text-accent hover:underline"
                          >
                            {risk.filePath}
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {!insight.layers?.length && !insight.flows?.length ? (
              <Card>
                <EmptyState
                  title="No narrative available"
                  description="No directories or endpoints were found to describe. Re-run the analysis, or check the Dependency graph tab for the raw import data."
                />
              </Card>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {graph.isError ? <ErrorState error={graph.error} retry={() => void graph.refetch()} /> : null}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Most connected files" description="Fan-in / fan-out from real import edges" />
                <ul className="divide-y divide-line">
                  {graph.data?.graph.hotspots.slice(0, 15).map((hotspot) => (
                    <li key={hotspot.path} className="flex items-center justify-between gap-3 px-4 py-2">
                      <Link
                        to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(hotspot.path)}`}
                        className="truncate font-mono text-2xs text-accent hover:underline"
                      >
                        {hotspot.path}
                      </Link>
                      <span className="shrink-0 font-mono text-2xs text-ink-faint">
                        in {hotspot.fanIn} · out {hotspot.fanOut}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card>
                <CardHeader title="External packages" description="Ranked by number of importing files" />
                <ul className="divide-y divide-line">
                  {graph.data?.graph.externals.slice(0, 15).map((external) => (
                    <li key={external.specifier} className="flex items-center justify-between gap-3 px-4 py-2">
                      <span className="truncate font-mono text-2xs text-ink">{external.specifier}</span>
                      <span className="shrink-0 font-mono text-2xs text-ink-faint">{external.importers}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            {graph.data?.graph.cycles.length ? (
              <Card>
                <CardHeader
                  title={`Import cycles (${graph.data.graph.cycles.length})`}
                  description="Circular imports make modules impossible to load or test independently"
                />
                <ul className="divide-y divide-line">
                  {graph.data.graph.cycles.map((cycle, index) => (
                    <li key={index} className="px-4 py-2 font-mono text-2xs text-ink-muted">
                      {cycle.join(' → ')}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
