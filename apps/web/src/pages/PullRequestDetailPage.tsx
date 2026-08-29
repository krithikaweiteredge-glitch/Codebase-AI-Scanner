import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, GitPullRequest, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Markdown } from '@/components/Markdown';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  SeverityBadge,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { get, post } from '@/lib/api';
import type { Finding } from '@/lib/types';
import { cn } from '@/lib/utils';

interface PullRequestDetail {
  pullRequest: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft: boolean;
    author: string | null;
    headRef: string;
    headSha: string;
    baseRef: string;
    url: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[];
  comments: { id: number; author: string | null; body: string; createdAt: string; url: string }[];
  reviews: {
    id: string;
    status: string;
    verdict: string | null;
    summary: string;
    counts: Record<string, number> | null;
    createdAt: string;
    postedToGithub: boolean;
    githubCommentUrl: string | null;
    findings: Finding[];
  }[];
}

interface ReviewResponse {
  review: {
    id: string;
    verdict: string;
    summary: string;
    counts: Record<string, number>;
    testGaps: string[];
    breakingChanges: string[];
    generatedBy: 'ai' | 'deterministic';
    rejectedFindings: number;
    markdown: string;
  };
  findings: Finding[];
  disclaimer: string;
}

export function PullRequestDetailPage() {
  const { repositoryId, number } = useParams<{ repositoryId: string; number: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'review' | 'files' | 'comments'>('review');
  const [freshReview, setFreshReview] = useState<ReviewResponse | null>(null);

  const detail = useQuery({
    queryKey: ['pull-request', repositoryId, number],
    queryFn: () => get<PullRequestDetail>(`/api/repositories/${repositoryId}/pull-requests/${number}`),
    enabled: Boolean(repositoryId && number),
  });

  const review = useMutation({
    mutationFn: () => post<ReviewResponse>(`/api/repositories/${repositoryId}/pull-requests/${number}/review`),
    onSuccess: (data) => {
      setFreshReview(data);
      toast.success('Review generated', `${data.findings.length} finding(s)`);
      void queryClient.invalidateQueries({ queryKey: ['pull-request', repositoryId, number] });
    },
    onError: (error: Error) => toast.error('Review failed', error.message),
  });

  const postReview = useMutation({
    mutationFn: (reviewId: string) =>
      post<{ posted: boolean; url: string }>(
        `/api/repositories/${repositoryId}/pull-requests/${number}/review/${reviewId}/post`,
        { confirm: true },
      ),
    onSuccess: (data) => {
      toast.success('Review posted to GitHub', data.url);
      void queryClient.invalidateQueries({ queryKey: ['pull-request', repositoryId, number] });
    },
    onError: (error: Error) => toast.error('Could not post to GitHub', error.message),
  });

  if (detail.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (detail.isError) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  if (!detail.data) return null;

  const { pullRequest, files, comments, reviews } = detail.data;
  const latestReview = freshReview
    ? {
        id: freshReview.review.id,
        status: freshReview.review.verdict,
        verdict: freshReview.review.verdict,
        summary: freshReview.review.summary,
        counts: freshReview.review.counts,
        createdAt: new Date().toISOString(),
        postedToGithub: false,
        githubCommentUrl: null,
        findings: freshReview.findings,
      }
    : reviews[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-5 py-4">
        <button
          onClick={() => navigate(`/repositories/${repositoryId}/pull-requests`)}
          className="mb-2 flex items-center gap-1 text-2xs text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3 w-3" /> All pull requests
        </button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <GitPullRequest className="h-4 w-4 text-ok" />
              <span className="font-mono text-ink-faint">#{pullRequest.number}</span>
              <span className="truncate">{pullRequest.title}</span>
              <a href={pullRequest.url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-accent">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </h1>
            <p className="mt-0.5 text-xs text-ink-muted">
              {pullRequest.author} · <span className="font-mono">{pullRequest.headRef}</span> →{' '}
              <span className="font-mono">{pullRequest.baseRef}</span> · {pullRequest.changedFiles} files ·{' '}
              <span className="text-ok">+{pullRequest.additions}</span>{' '}
              <span className="text-danger">-{pullRequest.deletions}</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => review.mutate()} loading={review.isPending}>
              <Sparkles className="h-3.5 w-3.5" /> Generate review
            </Button>
            {latestReview && !latestReview.postedToGithub ? (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      `Post this review as a comment on ${pullRequest.url}?\n\nThis is visible to everyone with access to the repository.`,
                    )
                  ) {
                    postReview.mutate(latestReview.id);
                  }
                }}
                loading={postReview.isPending}
              >
                <Send className="h-3.5 w-3.5" /> Post review to GitHub
              </Button>
            ) : null}
            {latestReview?.githubCommentUrl ? (
              <a
                href={latestReview.githubCommentUrl}
                target="_blank"
                rel="noreferrer"
                className="text-2xs text-accent hover:underline"
              >
                View posted comment
              </a>
            ) : null}
          </div>
        </div>

        <Tabs
          className="mt-3 border-b-0"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'review', label: 'AI review', count: latestReview?.findings.length },
            { value: 'files', label: 'Changed files', count: files.length },
            { value: 'comments', label: 'Comments', count: comments.length },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'review' ? (
          !latestReview ? (
            <Card className="p-6">
              <p className="text-sm font-medium">No review yet</p>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                Generating a review fetches the diff, runs the deterministic rule set over the lines the PR adds, pulls
                the surrounding code from the indexed branch and existing tests for the touched modules, and (when an AI
                provider is configured) asks for a review constrained to the changed lines.
              </p>
              <Button className="mt-3" variant="primary" onClick={() => review.mutate()} loading={review.isPending}>
                <Sparkles className="h-3.5 w-3.5" /> Generate review
              </Button>
            </Card>
          ) : (
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Review"
                  description={freshReview ? `Generated by ${freshReview.review.generatedBy}` : undefined}
                  actions={
                    <Badge
                      tone={
                        latestReview.status === 'request_changes' || latestReview.verdict === 'Needs Changes'
                          ? 'danger'
                          : latestReview.status === 'approve' || latestReview.verdict === 'Approved'
                            ? 'ok'
                            : 'warn'
                      }
                    >
                      {latestReview.verdict ?? latestReview.status}
                    </Badge>
                  }
                />
                <div className="p-4">
                  <div className="mb-3 flex flex-wrap gap-2">
                    {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
                      <span key={severity} className="flex items-center gap-1">
                        <SeverityBadge severity={severity} />
                        <span className="font-mono text-2xs text-ink-muted">
                          {latestReview.counts?.[severity] ?? 0}
                        </span>
                      </span>
                    ))}
                  </div>
                  <Markdown content={latestReview.summary} />

                  {freshReview?.review.testGaps.length ? (
                    <>
                      <h3 className="mt-4 text-2xs font-semibold uppercase tracking-wider text-ink-faint">Test gaps</h3>
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-ink-muted">
                        {freshReview.review.testGaps.map((gap) => (
                          <li key={gap}>{gap}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {freshReview?.review.breakingChanges.length ? (
                    <>
                      <h3 className="mt-4 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                        Possible breaking changes
                      </h3>
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-ink-muted">
                        {freshReview.review.breakingChanges.map((change) => (
                          <li key={change}>{change}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {freshReview && freshReview.review.rejectedFindings > 0 ? (
                    <p className="mt-3 rounded border border-warn/30 bg-warn/5 px-2 py-1.5 text-2xs text-ink-muted">
                      {freshReview.review.rejectedFindings} model finding(s) pointed at files the PR does not touch and
                      were discarded.
                    </p>
                  ) : null}
                </div>
              </Card>

              {latestReview.findings.length ? (
                <div className="space-y-2">
                  {latestReview.findings.map((finding) => (
                    <Card key={finding.id ?? `${finding.filePath}-${finding.startLine}`} className="p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={finding.severity} />
                        <StatusBadge status={finding.status} source={finding.source} />
                        <Badge tone="neutral">{finding.category}</Badge>
                        <span className="text-xs font-medium text-ink">{finding.title}</span>
                      </div>
                      <Link
                        to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(finding.filePath ?? '')}&line=${finding.startLine ?? 1}`}
                        className="mt-1 block font-mono text-2xs text-accent hover:underline"
                      >
                        {finding.filePath}:{finding.startLine}
                      </Link>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
                        {finding.description}
                      </p>
                      {finding.evidence ? (
                        <p className="mt-2 font-mono text-2xs text-ink-faint">Evidence: {finding.evidence}</p>
                      ) : null}
                      {finding.recommendation ? (
                        <p className="mt-2 text-xs text-ink">Fix: {finding.recommendation}</p>
                      ) : null}
                    </Card>
                  ))}
                </div>
              ) : null}

              {freshReview ? (
                <Card className="p-4">
                  <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                    Comment that would be posted
                  </h3>
                  <pre className="mt-2 max-h-80 overflow-auto rounded border border-line bg-canvas p-3 font-mono text-2xs text-ink-muted">
                    {freshReview.review.markdown}
                  </pre>
                  <p className="mt-2 text-2xs text-ink-faint">{freshReview.disclaimer}</p>
                </Card>
              ) : null}
            </div>
          )
        ) : tab === 'files' ? (
          <div className="space-y-3">
            {files.map((file) => (
              <Card key={file.filename}>
                <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
                  <Link
                    to={`/repositories/${repositoryId}/explorer?path=${encodeURIComponent(file.filename)}`}
                    className="truncate font-mono text-xs text-accent hover:underline"
                  >
                    {file.filename}
                  </Link>
                  <span className="shrink-0 text-2xs text-ink-faint">
                    {file.status} · <span className="text-ok">+{file.additions}</span>{' '}
                    <span className="text-danger">-{file.deletions}</span>
                  </span>
                </div>
                {file.patch ? (
                  <pre className="max-h-96 overflow-auto p-3 font-mono text-2xs leading-relaxed">
                    {file.patch.split('\n').map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          line.startsWith('+') && !line.startsWith('+++') && 'bg-ok/10 text-ok',
                          line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
                          line.startsWith('@@') && 'text-accent',
                          !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@') && 'text-ink-muted',
                        )}
                      >
                        {line || ' '}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <p className="p-3 text-2xs text-ink-faint">No patch available (binary or too large).</p>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {comments.length === 0 ? (
              <p className="text-xs text-ink-faint">No comments on this pull request.</p>
            ) : (
              comments.map((comment) => (
                <Card key={comment.id} className="p-3">
                  <p className="text-2xs text-ink-faint">
                    {comment.author} · {new Date(comment.createdAt).toLocaleString()}
                  </p>
                  <Markdown className="mt-1.5" content={comment.body} />
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
