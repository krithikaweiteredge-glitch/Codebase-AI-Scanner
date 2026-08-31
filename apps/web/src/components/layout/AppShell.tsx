import { useQuery } from '@tanstack/react-query';
import {
  Boxes,
  Bug,
  Command,
  Copy,
  FileText,
  FlaskConical,
  Gauge,
  GitPullRequest,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Network,
  Search,
  Settings,
  ShieldAlert,
  Code2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette } from '@/components/CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Badge, Button } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { get } from '@/lib/api';
import type { Repository } from '@/lib/types';
import { cn, formatRelativeTime } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  requiresRepository?: boolean;
}

export function AppShell() {
  const location = useLocation();
  // Derived from the URL rather than useParams so the shell works as a layout
  // route regardless of where the :repositoryId segment is matched.
  const repositoryId = location.pathname.match(/^\/repositories\/([0-9a-fA-F-]{36})/)?.[1] ?? undefined;
  const navigate = useNavigate();
  const { user, config, logout } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: () => get<{ repositories: Repository[] }>('/api/repositories'),
  });

  const active = repositories.data?.repositories.find((repository) => repository.id === repositoryId) ?? null;

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const base = repositoryId ? `/repositories/${repositoryId}` : '';
  const items: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
    { to: '/repositories', label: 'Repositories', icon: <Boxes className="h-4 w-4" /> },
    { to: `${base}/explorer`, label: 'Code Explorer', icon: <Code2 className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/chat`, label: 'AI Chat', icon: <MessagesSquare className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/search`, label: 'Search', icon: <Search className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/security`, label: 'Security', icon: <ShieldAlert className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/bugs`, label: 'Bug Analysis', icon: <Bug className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/performance`, label: 'Performance', icon: <Gauge className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/duplicates`, label: 'Duplicates', icon: <Copy className="h-4 w-4" />, requiresRepository: true },
    {
      to: `${base}/pull-requests`,
      label: 'Pull Requests',
      icon: <GitPullRequest className="h-4 w-4" />,
      requiresRepository: true,
    },
    { to: `${base}/tests`, label: 'Tests', icon: <FlaskConical className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/docs`, label: 'Documentation', icon: <FileText className="h-4 w-4" />, requiresRepository: true },
    { to: `${base}/architecture`, label: 'Architecture', icon: <Network className="h-4 w-4" />, requiresRepository: true },
    { to: '/settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-12 items-center gap-2 border-b border-line px-3">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-accent/15 text-accent">
            <Network className="h-3.5 w-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Codebase&nbsp;AI</span>
        </div>

        <button
          onClick={() => navigate('/repositories')}
          className="mx-2 mt-2 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-left transition-colors hover:border-accent/40"
        >
          <p className="text-2xs uppercase tracking-wider text-ink-faint">Repository</p>
          <p className="mt-0.5 truncate text-xs font-medium text-ink">{active?.fullName ?? 'None selected'}</p>
          {active ? (
            <p className="mt-0.5 truncate text-2xs text-ink-faint">
              {active.indexedBranch ?? active.defaultBranch} · indexed {formatRelativeTime(active.indexedAt ?? active.lastAnalyzedAt)}
            </p>
          ) : null}
        </button>

        <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {items.map((item) => {
            const disabled = item.requiresRepository && !repositoryId;
            if (disabled) {
              return (
                <span
                  key={item.label}
                  className="flex cursor-not-allowed items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-ink-faint/60"
                  title="Select a repository first"
                >
                  {item.icon}
                  {item.label}
                </span>
              );
            }
            return (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                    isActive ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
                  )
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-line p-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center justify-between rounded-md border border-line bg-surface-raised px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink"
          >
            <span className="flex items-center gap-2">
              <Command className="h-3.5 w-3.5" /> Command palette
            </span>
            <span className="kbd">⌘K</span>
          </button>

          <div className="mt-2 flex items-center justify-between px-1">
            <div className="min-w-0">
              <p className="truncate text-2xs text-ink-muted">{user?.email}</p>
              <p className="truncate text-2xs text-ink-faint">
                {config ? `${config.aiProvider}/${config.aiModel}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="xs" onClick={() => void logout()} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>

          {config && !config.aiGeneration ? (
            <div className="mt-2 rounded border border-warn/30 bg-warn/5 px-2 py-1.5">
              <Badge tone="warn">offline mode</Badge>
              <p className="mt-1 text-2xs leading-snug text-ink-muted">
                No generative provider configured. Deterministic analysis and retrieval only.
              </p>
            </div>
          ) : null}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        {/*
          Scoped to the routed page so a crash in one view leaves the shell and
          navigation usable. Keying on the path resets the boundary on
          navigation, so moving to another page recovers without a reload.
        */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        repositoryId={repositoryId ?? null}
        repositories={repositories.data?.repositories ?? []}
      />
    </div>
  );
}
