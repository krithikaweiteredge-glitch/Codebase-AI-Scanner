import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Github, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, Input, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { del, get, post } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { formatRelativeTime } from '@/lib/utils';

interface GitHubStatus {
  oauthConfigured: boolean;
  appConfigured: boolean;
  appSlug: string | null;
  connected: boolean;
  login: string | null;
  scopes: string[];
  linkedAt: string | null;
  installationsCount: number;
  installations: {
    id: string;
    installationId: string;
    accountLogin: string;
    accountType: string;
    accountAvatar: string | null;
    repositorySelection: string;
  }[];
}

export function SettingsPage() {
  const { user, config, refresh } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState('');

  const status = useQuery({
    queryKey: ['github-status'],
    queryFn: () => get<GitHubStatus>('/api/github/status'),
  });

  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () =>
      get<{ sessions: { id: string; userAgent: string | null; createdAt: string; expiresAt: string }[] }>(
        '/api/auth/sessions',
      ),
  });

  const installUrlQuery = useQuery({
    queryKey: ['github-app-install-url'],
    queryFn: () => get<{ installUrl: string | null; configured: boolean }>('/api/github/app/install-url'),
    enabled: status.data?.appConfigured === true,
  });

  const saveToken = useMutation({
    mutationFn: () => post<{ login: string }>('/api/github/token', { token: token.trim() }),
    onSuccess: async (data) => {
      toast.success(`GitHub connected as ${data.login}`);
      setToken('');
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
      await refresh();
    },
    onError: (error: Error) => toast.error('GitHub rejected that token', error.message),
  });

  const disconnect = useMutation({
    mutationFn: () => del('/api/github/token'),
    onSuccess: async () => {
      toast.info('GitHub disconnected');
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
      await refresh();
    },
  });

  const deleteInstallation = useMutation({
    mutationFn: (installationId: string) => del(`/api/github/installations/${installationId}`),
    onSuccess: async () => {
      toast.info('Installation unlinked');
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
      await refresh();
    },
  });

  const startOAuth = useMutation({
    mutationFn: () => get<{ authorizeUrl: string }>('/api/github/connect'),
    onSuccess: (data) => {
      window.location.href = data.authorizeUrl;
    },
    onError: (error: Error) => toast.error('Could not start GitHub OAuth', error.message),
  });

  return (
    <div className="h-full overflow-y-auto">
      <header className="border-b border-line px-5 py-4">
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="mt-0.5 text-xs text-ink-muted">Account, GitHub connection and deployment configuration.</p>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 p-5">
        {searchParams.get('github') === 'error' ? (
          <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            GitHub authorization failed. Check the OAuth app configuration, or connect a personal access token instead.
          </div>
        ) : null}

        <Card>
          <CardHeader title="Account" />
          <dl className="space-y-2 p-4 text-xs">
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Email</dt>
              <dd className="font-mono">{user?.email}</dd>
            </div>
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Name</dt>
              <dd>{user?.name ?? '—'}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="GitHub Integration"
            description="Production-grade connection using GitHub App, OAuth, or encrypted Personal Access Tokens."
            actions={
              status.data?.connected ? (
                <Badge tone="ok">connected as {status.data.login}</Badge>
              ) : (
                <Badge tone="warn">not connected</Badge>
              )
            }
          />
          <div className="space-y-4 p-4">
            {status.isLoading ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                {/* Installed GitHub Apps */}
                {status.data?.installations && status.data.installations.length > 0 ? (
                  <div>
                    <p className="mb-2 text-2xs uppercase tracking-wider text-ink-faint">
                      Active GitHub App Installations ({status.data.installations.length})
                    </p>
                    <div className="space-y-2">
                      {status.data.installations.map((inst) => (
                        <div
                          key={inst.id}
                          className="flex items-center justify-between rounded border border-line bg-surface-raised px-3 py-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4 text-accent" />
                            <span className="font-medium text-ink">{inst.accountLogin}</span>
                            <span className="text-2xs text-ink-faint">({inst.accountType})</span>
                            <Badge tone="ok">{inst.repositorySelection === 'all' ? 'All Repos' : 'Selected Repos'}</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href={`https://github.com/settings/installations/${inst.installationId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-2xs text-accent hover:underline"
                            >
                              Configure <ExternalLink className="h-3 w-3" />
                            </a>
                            <Button
                              variant="danger"
                              size="sm"
                              loading={deleteInstallation.isPending}
                              onClick={() => deleteInstallation.mutate(inst.installationId)}
                            >
                              <Trash2 className="h-3 w-3" /> Unlink
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Add new GitHub App installation */}
                {status.data?.appConfigured ? (
                  <div className="rounded border border-line/80 bg-surface-overlay/50 p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-semibold text-ink">GitHub App ({status.data.appSlug})</p>
                        <p className="text-2xs text-ink-muted">
                          Install on personal accounts or organizations with fine-grained access.
                        </p>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={installUrlQuery.isLoading}
                        onClick={() => {
                          if (installUrlQuery.data?.installUrl) {
                            window.open(installUrlQuery.data.installUrl, '_blank');
                          }
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Install App
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Personal Token / OAuth Section */}
                {status.data?.connected && !status.data.installationsCount ? (
                  <>
                    <dl className="space-y-2 text-xs">
                      <div className="flex justify-between border-b border-line/60 pb-1.5">
                        <dt className="text-ink-muted">Scopes</dt>
                        <dd className="font-mono">{status.data.scopes.join(', ') || 'personal token'}</dd>
                      </div>
                      <div className="flex justify-between border-b border-line/60 pb-1.5">
                        <dt className="text-ink-muted">Linked</dt>
                        <dd>{formatRelativeTime(status.data.linkedAt)}</dd>
                      </div>
                    </dl>
                    <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                      <Trash2 className="h-3.5 w-3.5" /> Disconnect GitHub
                    </Button>
                  </>
                ) : null}

                {/* Connect Token or OAuth if not using App */}
                {!status.data?.connected && (
                  <div className="space-y-3 pt-2">
                    {status.data?.oauthConfigured ? (
                      <Button variant="secondary" onClick={() => startOAuth.mutate()} loading={startOAuth.isPending}>
                        <Github className="h-3.5 w-3.5" /> Authorize with GitHub OAuth
                      </Button>
                    ) : null}

                    <div className="border-t border-line pt-3">
                      <p className="text-2xs uppercase tracking-wider text-ink-faint">Personal access token (Alternative)</p>
                      <Input
                        type="password"
                        className="mt-1.5"
                        placeholder="ghp_… or github_pat_…"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                      <Button
                        className="mt-2"
                        loading={saveToken.isPending}
                        disabled={token.trim().length < 20}
                        onClick={() => saveToken.mutate()}
                      >
                        Verify and save token
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="AI configuration" description="Set through environment variables on the API server" />
          <dl className="space-y-2 p-4 text-xs">
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Provider</dt>
              <dd className="font-mono">{config?.aiProvider}</dd>
            </div>
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Model</dt>
              <dd className="font-mono">{config?.aiModel}</dd>
            </div>
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Generation</dt>
              <dd>
                {config?.aiGeneration ? (
                  <Badge tone="ok">enabled</Badge>
                ) : (
                  <Badge tone="warn">disabled (deterministic mode)</Badge>
                )}
              </dd>
            </div>
            <div className="flex justify-between border-b border-line/60 pb-1.5">
              <dt className="text-ink-muted">Embeddings</dt>
              <dd className="font-mono">{config?.embeddingProvider}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Context budget</dt>
              <dd className="font-mono">{config?.contextTokenBudget} tokens</dd>
            </div>
          </dl>
          <p className="border-t border-line px-4 py-2 text-2xs leading-relaxed text-ink-faint">
            Change these with <span className="font-mono">AI_PROVIDER</span>, <span className="font-mono">AI_API_KEY</span>{' '}
            and <span className="font-mono">AI_MODEL</span> in the API environment, then restart the API.
          </p>
        </Card>

        <Card>
          <CardHeader title="Active sessions" />
          <div className="divide-y divide-line">
            {sessions.data?.sessions.map((session) => (
              <div key={session.id} className="px-4 py-2 text-2xs">
                <p className="truncate text-ink-muted">{session.userAgent ?? 'Unknown client'}</p>
                <p className="text-ink-faint">
                  started {formatRelativeTime(session.createdAt)} · expires{' '}
                  {new Date(session.expiresAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
