import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Send, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CitationList, RetrievalTrace } from '@/components/CitationList';
import { Markdown } from '@/components/Markdown';
import { Badge, Button, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { del, get, post } from '@/lib/api';
import type { ChatAnswer, ChatMessage } from '@/lib/types';
import { cn, formatRelativeTime } from '@/lib/utils';

const SUGGESTIONS = [
  'Where is authentication handled?',
  'How does user registration work?',
  'Where is JWT generated?',
  'What happens when a user logs in?',
  'Which API endpoints are not protected?',
  'Where is the database connection initialized?',
  'Show me the complete payment flow.',
  'Are there duplicate functions?',
];

interface TurnState extends ChatAnswer {
  question: string;
}

export function ChatPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnState[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({
    queryKey: ['chat-sessions', repositoryId],
    queryFn: () =>
      get<{ sessions: { id: string; title: string; messageCount: number; updatedAt: string }[] }>(
        `/api/repositories/${repositoryId}/chat/sessions`,
      ),
    enabled: Boolean(repositoryId),
  });

  const history = useQuery({
    queryKey: ['chat-session', sessionId],
    queryFn: () =>
      get<{ session: { id: string; title: string }; messages: ChatMessage[] }>(
        `/api/repositories/${repositoryId}/chat/sessions/${sessionId}`,
      ),
    enabled: Boolean(sessionId),
  });

  const ask = useMutation({
    mutationFn: (input: { question: string; sessionId: string | null }) =>
      post<ChatAnswer>(`/api/repositories/${repositoryId}/chat`, {
        question: input.question,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    onSuccess: (data, variables) => {
      if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);
      setTurns((current) => [...current, { ...data, question: variables.question }]);
      setPendingQuestion(null);
      void queryClient.invalidateQueries({ queryKey: ['chat-sessions', repositoryId] });
    },
    onError: (error: Error) => {
      setPendingQuestion(null);
      toast.error('Could not answer that question', error.message);
    },
  });

  const removeSession = useMutation({
    mutationFn: (id: string) => del(`/api/repositories/${repositoryId}/chat/sessions/${id}`),
    onSuccess: (_data, id) => {
      if (id === sessionId) {
        setSessionId(null);
        setTurns([]);
      }
      void queryClient.invalidateQueries({ queryKey: ['chat-sessions', repositoryId] });
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pendingQuestion, history.data]);

  const submit = (value: string) => (event?: FormEvent): void => {
    event?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || ask.isPending) return;
    setQuestion('');
    setPendingQuestion(trimmed);
    ask.mutate({ question: trimmed, sessionId });
  };

  const openReference = (filePath: string, line?: number): void => {
    const params = new URLSearchParams({ path: filePath });
    if (line) params.set('line', String(line));
    navigate(`/repositories/${repositoryId}/explorer?${params.toString()}`);
  };

  const persistedTurns =
    sessionId && history.data ? pairMessages(history.data.messages) : [];
  const showPersisted = persistedTurns.length > 0 && turns.length === 0;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-60 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-2">
          <Button
            className="w-full"
            onClick={() => {
              setSessionId(null);
              setTurns([]);
            }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" /> New conversation
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {sessions.data?.sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group flex items-center gap-1 px-2 py-1.5',
                sessionId === session.id ? 'bg-surface-raised' : '',
              )}
            >
              <button
                onClick={() => {
                  setSessionId(session.id);
                  setTurns([]);
                }}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-xs text-ink">{session.title}</p>
                <p className="text-2xs text-ink-faint">
                  {session.messageCount} messages · {formatRelativeTime(session.updatedAt)}
                </p>
              </button>
              <button
                onClick={() => removeSession.mutate(session.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Delete conversation"
              >
                <Trash2 className="h-3 w-3 text-ink-faint hover:text-danger" />
              </button>
            </div>
          ))}
          {sessions.data?.sessions.length === 0 ? (
            <p className="px-3 py-2 text-2xs text-ink-faint">No conversations yet.</p>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {turns.length === 0 && persistedTurns.length === 0 && !pendingQuestion ? (
            <div className="mx-auto max-w-2xl px-6 py-12">
              <h1 className="text-base font-semibold">Ask anything about this codebase</h1>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Questions are answered from the indexed repository. Every answer lists the files and line ranges it was
                built from, and references that do not exist in the index are removed before you see them.
              </p>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => submit(suggestion)()}
                    className="rounded-md border border-line bg-surface px-3 py-2 text-left text-xs text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
            {showPersisted
              ? persistedTurns.map((turn, index) => (
                  <div key={index} className="space-y-3">
                    <UserBubble text={turn.question} />
                    <AssistantAnswer
                      answer={turn.answer}
                      citations={turn.citations}
                      onOpenReference={openReference}
                      meta={turn.meta}
                    />
                  </div>
                ))
              : null}

            {turns.map((turn, index) => (
              <div key={index} className="space-y-3">
                <UserBubble text={turn.question} />
                <AssistantAnswer
                  answer={turn.answer}
                  citations={turn.citations}
                  invalid={turn.invalidCitations}
                  sources={turn.sources}
                  retrieval={turn.retrieval}
                  usage={turn.usage}
                  degraded={turn.degraded}
                  groundingScore={turn.groundingScore}
                  followUps={turn.followUps}
                  onOpenReference={openReference}
                  onFollowUp={(value) => submit(value)()}
                />
              </div>
            ))}

            {pendingQuestion ? (
              <div className="space-y-3">
                <UserBubble text={pendingQuestion} />
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-2xs text-ink-faint">
                    <Sparkles className="h-3 w-3 animate-pulse text-accent" />
                    Retrieving code, building context, generating a grounded answer…
                  </div>
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <form onSubmit={submit(question)} className="border-t border-line p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit(question)();
                }
              }}
              rows={2}
              placeholder="Ask about this repository… (Enter to send, Shift+Enter for a new line)"
              className="min-h-[2.75rem] flex-1 resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
            />
            <Button type="submit" variant="primary" size="md" loading={ask.isPending} disabled={!question.trim()}>
              <Send className="h-3.5 w-3.5" /> Ask
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-surface-raised px-3 py-2 text-sm text-ink">{text}</p>
    </div>
  );
}

function AssistantAnswer({
  answer,
  citations,
  invalid,
  sources,
  retrieval,
  usage,
  degraded,
  groundingScore,
  followUps,
  onOpenReference,
  onFollowUp,
  meta,
}: {
  answer: string;
  citations: ChatAnswer['citations'];
  invalid?: ChatAnswer['invalidCitations'];
  sources?: ChatAnswer['sources'];
  retrieval?: ChatAnswer['retrieval'];
  usage?: ChatAnswer['usage'];
  degraded?: boolean;
  groundingScore?: number;
  followUps?: string[];
  onOpenReference: (filePath: string, line?: number) => void;
  onFollowUp?: (question: string) => void;
  meta?: string;
}) {
  return (
    <div>
      {degraded ? (
        <div className="mb-2 rounded border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-2xs text-ink-muted">
          Retrieval-only mode: no generative AI provider is configured, so this lists the matching code rather than a
          synthesised explanation.
        </div>
      ) : null}

      <Markdown content={answer} onOpenReference={onOpenReference} />

      <CitationList citations={citations} invalid={invalid} sources={sources} onOpen={onOpenReference} />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {groundingScore !== undefined ? (
          <Badge tone={groundingScore >= 0.99 ? 'ok' : groundingScore >= 0.6 ? 'warn' : 'danger'}>
            {Math.round(groundingScore * 100)}% of citations verified
          </Badge>
        ) : null}
        {meta ? <span className="text-2xs text-ink-faint">{meta}</span> : null}
      </div>

      {followUps?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {followUps.map((followUp) => (
            <button
              key={followUp}
              onClick={() => onFollowUp?.(followUp)}
              className="rounded border border-line bg-surface px-2 py-1 text-2xs text-ink-muted hover:border-accent/40 hover:text-ink"
            >
              {followUp}
            </button>
          ))}
        </div>
      ) : null}

      {retrieval ? <RetrievalTrace retrieval={retrieval} usage={usage} /> : null}
    </div>
  );
}

/** Turn a flat persisted message list into question/answer pairs. */
function pairMessages(messages: ChatMessage[]): {
  question: string;
  answer: string;
  citations: ChatAnswer['citations'];
  meta: string;
}[] {
  const turns: { question: string; answer: string; citations: ChatAnswer['citations']; meta: string }[] = [];
  let pendingQuestion: string | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      pendingQuestion = message.content;
    } else if (message.role === 'assistant') {
      turns.push({
        question: pendingQuestion ?? '',
        answer: message.content,
        citations: (message.citations ?? []) as ChatAnswer['citations'],
        meta: [
          message.provider && message.model ? `${message.provider}/${message.model}` : null,
          message.latencyMs ? `${message.latencyMs}ms` : null,
          message.groundingScore !== null ? `${Math.round((message.groundingScore ?? 0) * 100)}% verified` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      pendingQuestion = null;
    }
  }
  return turns;
}
