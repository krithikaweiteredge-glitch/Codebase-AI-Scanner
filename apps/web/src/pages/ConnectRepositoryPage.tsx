import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Github, Lock, Plus, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, post } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

interface GitHubRepoSummary {
  githubId: string;
  name: string;
  owner: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  sizeKb: number;
  language: string | null;
  stars: number;
  archived: boolean;
  installationId?: string | null;
  connectedRepositoryId: string | null;
}

interface PreviewResponse {
  repository: {
    owner: string;
    name: string;
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    sizeKb: number;
    archived: boolean;
  };
  languages: { language: string; bytes: number; percent: number }[];
  branches: { name: string; sha: string; protected: boolean; isDefault: boolean }[];
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
}

interface GitHubStatus {
  oauthConfigured: boolean;
  appConfigured: boolean;
  appSlug: string | null;
  connected: boolean;
  login: string | null;
  scopes: string[];
  installationsCount: number;
  installations: {
    id: string;
    installationId: string;
    accountLogin: string;
    accountType: string;
    accountAvatar: string | null;
  }[];
}

/** Connect GitHub → pick account → pick repository → pick branch → analyze. */
export function ConnectRepositoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [ownerFilter, setOwnerFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<GitHubRepoSummary | null>(null);
  const [branch, setBranch] = useState<string>('');

  const status = useQuery({
    queryKey: ['github-status'],
    queryFn: () => get<GitHubStatus>('/api/github/status'),
  });

  // Handle redirect back from GitHub App installation
  useEffect(() => {
    const installedParam = searchParams.get('github');
    const installationId = searchParams.get('installation_id');

    if (installedParam === 'installed' && installationId) {
      post('/api/github/installations', { installationId })
        .then(() => {
          toast.success('GitHub App installed successfully!');
          void status.refetch();
          void queryClient.invalidateQueries({ queryKey: ['github-repositories'] });
          void queryClient.invalidateQueries({ queryKey: ['github-accounts'] });
        })
        .catch((err) => {
          toast.error('Failed to link GitHub App installation', (err as Error).message);
        })
        .finally(() => {
          // Clear search parameters
          setSearchParams({});
        });
    } else if (installedParam === 'installed') {
      toast.success('GitHub App connected!');
      void status.refetch();
      setSearchParams({});
    }
  }, [searchParams, setSearchParams, status, queryClient, toast]);

  const accounts = useQuery({
    queryKey: ['github-accounts'],
    queryFn: () => get<{ accounts: { login: string; type: string; avatarUrl: string; installationId?: string }[] }>('/api/github/organizations'),
    enabled: status.data?.connected === true,
  });

  const repositories = useQuery({
    queryKey: ['github-repositories', ownerFilter],
    queryFn: () =>
      get<{ repositories: GitHubRepoSummary[] }>(
        `/api/github/repositories${ownerFilter ? `?owner=${encodeURIComponent(ownerFilter)}` : ''}`,
      ),
    enabled: status.data?.connected === true,
  });

  const preview = useQuery({
    queryKey: ['github-preview', selected?.fullName],
    queryFn: () =>
      get<PreviewResponse>(
        `/api/github/repositories/${selected!.owner}/${selected!.name}/preview${
          selected?.installationId ? `?installationId=${encodeURIComponent(selected.installationId)}` : ''
        }`,
      ),
    enabled: Boolean(selected),
  });

  const connect = useMutation({
    mutationFn: (input: { owner: string; name: string; branch: string; installationId?: string }) =>
      post<{ repository: { id: string } }>('/api/repositories', input),
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      toast.success('Repository connected', 'Starting analysis…');
      try {
        await post(`/api/repositories/${data.repository.id}/analyze`, {
          branch: variables.branch,
          incremental: false,
          generateDocs: true,
        });
      } catch (error) {
        toast.error('Connected, but analysis could not start', (error as Error).message);
      }
      navigate(`/repositories/${data.repository.id}`);
    },
    onError: (error: Error) => toast.error('Could not connect repository', error.message),
  });

  const installUrlQuery = useQuery({
    queryKey: ['github-app-install-url'],
    queryFn: () => get<{ installUrl: string | null; configured: boolean }>('/api/github/app/install-url'),
    enabled: status.data?.appConfigured === true,
  });

  const filtered = useMemo(() => {
    const list = repositories.data?.repositories ?? [];
    const needle = search.trim().toLowerCase();
    return needle ? list.filter((repository) => repository.fullName.toLowerCase().includes(needle)) : list;
  }, [repositories.data, search]);

  const effectiveBranch = branch || preview.data?.repository.defaultBranch || selected?.defaultBranch || '';

  if (status.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!status.data?.connected) {
    return (
      <ConnectGitHubStep
        status={status.data}
        onDone={() => {
          void status.refetch();
          void queryClient.invalidateQueries({ queryKey: ['github-repositories'] });
          void queryClient.invalidateQueries({ queryKey: ['github-accounts'] });
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h1 className="text-base font-semibold">Connect a repository</h1>
          <p className="mt-0.5 text-xs text-ink-muted">
            Connected via <span className="font-medium text-ink">{status.data.login ?? 'GitHub'}</span>
            {status.data.installationsCount > 0 ? ` (${status.data.installationsCount} GitHub App installation${status.data.installationsCount > 1 ? 's' : ''})` : ''}.
          </p>
        </div>
        {status.data.appConfigured && installUrlQuery.data?.installUrl ? (
          <Button
            size="sm"
            onClick={() => {
              window.open(installUrlQuery.data!.installUrl!, '_blank');
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Install on another account / repo
          </Button>
        ) : null}
      </header>

      <div className="grid gap-4 p-5 lg:grid-cols-[1fr_22rem]">
        <Card className="min-h-0">
          <CardHeader
            title="Your repositories"
            description={`${filtered.length} available`}
            actions={
              <div className="flex items-center gap-2">
                <Select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
                  <option value="">All accounts</option>
                  {accounts.data?.accounts.map((account) => (
                    <option key={account.login} value={account.login}>
                      {account.login} {account.type === 'Organization' ? '(Org)' : ''}
                    </option>
                  ))}
                </Select>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filter…"
                    className="w-48 pl-7"
                  />
                </div>
              </div>
            }
          />

          {repositories.isError ? <ErrorState error={repositories.error} retry={() => void repositories.refetch()} /> : null}

          <div className="max-h-[32rem] overflow-y-auto">
            {repositories.isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 8 }).map((_, index) => (
                  <Skeleton key={index} className="h-12" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                title="No repositories found"
                description={
                  status.data.appConfigured
                    ? "If your repo is not listed, you can grant access via the GitHub App installation settings."
                    : "Adjust the filter, or check the token's scopes."
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {filtered.map((repository) => (
                  <li key={repository.githubId}>
                    <button
                      onClick={() => {
                        setSelected(repository);
                        setBranch('');
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-raised ${
                        selected?.githubId === repository.githubId ? 'bg-surface-raised' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate text-xs font-medium text-ink">
                          {repository.fullName}
                          {repository.private ? <Lock className="h-3 w-3 text-ink-faint" /> : null}
                          {repository.connectedRepositoryId ? (
                            <Badge tone="ok">
                              <CheckCircle2 className="h-3 w-3" /> connected
                            </Badge>
                          ) : null}
                        </p>
                        <p className="truncate text-2xs text-ink-faint">{repository.description ?? 'No description'}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-2xs text-ink-faint">
                        {repository.language ? <span>{repository.language}</span> : null}
                        <span>{formatNumber(repository.sizeKb)} KB</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader title="Repository details" description="Reviewed before anything is indexed" />
            {!selected ? (
              <EmptyState title="Select a repository" description="Its languages, size and branches appear here." />
            ) : preview.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-5" />
                <Skeleton className="h-20" />
                <Skeleton className="h-8" />
              </div>
            ) : preview.isError ? (
              <ErrorState error={preview.error} retry={() => void preview.refetch()} />
            ) : preview.data ? (
              <div className="space-y-3 p-4">
                <div>
                  <p className="font-mono text-xs text-ink">{preview.data.repository.fullName}</p>
                  <p className="mt-0.5 text-2xs text-ink-muted">{preview.data.repository.description ?? ''}</p>
                </div>

                <div>
                  <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-faint">Languages</p>
                  <div className="space-y-1">
                    {preview.data.languages.slice(0, 6).map((language) => (
                      <div key={language.language} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 truncate text-2xs text-ink-muted">{language.language}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-overlay">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${language.percent}%` }} />
                        </div>
                        <span className="w-10 shrink-0 text-right font-mono text-2xs text-ink-faint">
                          {language.percent}%
                        </span>
                      </div>
                    ))}
                    {preview.data.languages.length === 0 ? (
                      <p className="text-2xs text-ink-faint">GitHub reported no language statistics.</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-2xs">
                  <div className="rounded border border-line bg-surface-raised px-2 py-1.5">
                    <p className="text-ink-faint">Repository size</p>
                    <p className="font-mono text-ink">{formatNumber(preview.data.repository.sizeKb)} KB</p>
                  </div>
                  <div className="rounded border border-line bg-surface-raised px-2 py-1.5">
                    <p className="text-ink-faint">File limit</p>
                    <p className="font-mono text-ink">{formatNumber(preview.data.limits.maxFiles)}</p>
                  </div>
                </div>

                <label className="block">
                  <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-faint">Branch</span>
                  <Select
                    className="w-full"
                    value={effectiveBranch}
                    onChange={(event) => setBranch(event.target.value)}
                  >
                    {preview.data.branches.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.name}
                        {option.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </Select>
                </label>

                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  loading={connect.isPending}
                  disabled={Boolean(selected.connectedRepositoryId)}
                  onClick={() =>
                    connect.mutate({
                      owner: selected.owner,
                      name: selected.name,
                      branch: effectiveBranch,
                      installationId: selected.installationId ?? undefined,
                    })
                  }
                >
                  {selected.connectedRepositoryId ? 'Already connected' : 'Start analysis'}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>

                {selected.connectedRepositoryId ? (
                  <Button
                    className="w-full"
                    onClick={() => navigate(`/repositories/${selected.connectedRepositoryId}`)}
                  >
                    Open connected repository
                  </Button>
                ) : null}

                <p className="text-2xs leading-relaxed text-ink-faint">
                  Indexing reads file contents through the GitHub API. Nothing is cloned or executed, and files matching
                  the ignore patterns (including <span className="font-mono">.env</span>) are never read.
                </p>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ConnectGitHubStep({
  status,
  onDone,
}: {
  status?: GitHubStatus;
  onDone: () => void;
}) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  const saveToken = useMutation({
    mutationFn: () => post<{ login: string }>('/api/github/token', { token: token.trim() }),
    onSuccess: (data) => {
      toast.success(`Connected as ${data.login}`);
      setToken('');
      onDone();
    },
    onError: (error: Error) => toast.error('GitHub rejected that token', error.message),
  });

  const startOAuth = useMutation({
    mutationFn: () => get<{ authorizeUrl: string }>('/api/github/connect'),
    onSuccess: (data) => {
      window.location.href = data.authorizeUrl;
    },
    onError: (error: Error) => toast.error('Could not start GitHub OAuth', error.message),
  });

  const installUrlQuery = useQuery({
    queryKey: ['github-app-install-url'],
    queryFn: () => get<{ installUrl: string | null; configured: boolean }>('/api/github/app/install-url'),
    enabled: Boolean(status?.appConfigured),
  });

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-2.5">
          <Github className="h-6 w-6 text-ink" />
          <div>
            <h1 className="text-base font-semibold">Connect GitHub</h1>
            <p className="text-2xs text-ink-muted">Choose your preferred connection method</p>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          The platform connects directly to GitHub to read repository structures, analyze code, and perform automated PR reviews without storing persistent static secrets.
        </p>

        {/* 1. GitHub App Flow (Best for production) */}
        {status?.appConfigured ? (
          <div className="mt-5 rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <ShieldCheck className="h-4 w-4 text-accent" />
              <span>GitHub App (Recommended)</span>
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
              Select entire organizations or individual repositories with fine-grained permissions. Zero manual token handling.
            </p>
            <Button
              variant="primary"
              size="md"
              className="mt-3 w-full"
              loading={installUrlQuery.isLoading}
              onClick={() => {
                if (installUrlQuery.data?.installUrl) {
                  window.location.href = installUrlQuery.data.installUrl;
                }
              }}
            >
              <Github className="h-4 w-4" /> Install GitHub App
            </Button>
          </div>
        ) : null}

        {/* 2. GitHub OAuth Flow */}
        {status?.oauthConfigured ? (
          <div className="mt-4">
            <Button
              variant={status?.appConfigured ? 'secondary' : 'primary'}
              size="md"
              className="w-full"
              loading={startOAuth.isPending}
              onClick={() => startOAuth.mutate()}
            >
              <Github className="h-4 w-4" /> Authorize with GitHub OAuth
            </Button>
          </div>
        ) : null}

        {/* 3. Personal Access Token (Fallback) */}
        <div className="mt-5 border-t border-line pt-4">
          {!showTokenInput && (status?.appConfigured || status?.oauthConfigured) ? (
            <button
              onClick={() => setShowTokenInput(true)}
              className="text-2xs text-ink-muted hover:text-ink hover:underline"
            >
              Or connect manually with a Personal Access Token →
            </button>
          ) : (
            <div>
              <p className="text-2xs uppercase tracking-wider text-ink-faint">Personal access token</p>
              <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
                Create a token with <span className="font-mono">repo</span> scope at github.com/settings/tokens.
              </p>
              <Input
                type="password"
                className="mt-2"
                placeholder="ghp_… or github_pat_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button
                className="mt-2 w-full"
                size="md"
                loading={saveToken.isPending}
                disabled={token.trim().length < 20}
                onClick={() => saveToken.mutate()}
              >
                Verify and save token
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
