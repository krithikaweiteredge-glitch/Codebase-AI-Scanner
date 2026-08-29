import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'xs' | 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:bg-accent/40',
  secondary: 'border border-line-strong bg-surface-raised text-ink hover:border-accent/50 hover:bg-surface-overlay',
  ghost: 'text-ink-muted hover:bg-surface-raised hover:text-ink',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
  subtle: 'bg-surface-overlay text-ink-muted hover:text-ink',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 px-2 text-2xs',
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'sm', loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="h-3 w-3" /> : null}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-ink-faint',
        'focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink',
        'focus:border-accent/60 focus:outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-line px-4 py-3', className)}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-2xs font-semibold uppercase tracking-wider text-ink-faint', className)}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'border-line-strong bg-surface-raised text-ink-muted',
    accent: 'border-accent/40 bg-accent-subtle text-accent',
    ok: 'border-ok/40 bg-ok/10 text-ok',
    warn: 'border-warn/40 bg-warn/10 text-warn',
    danger: 'border-danger/40 bg-danger/10 text-danger',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'border-severity-critical/50 bg-severity-critical/12 text-severity-critical',
  high: 'border-severity-high/50 bg-severity-high/12 text-severity-high',
  medium: 'border-severity-medium/50 bg-severity-medium/12 text-severity-medium',
  low: 'border-severity-low/50 bg-severity-low/12 text-severity-low',
  info: 'border-severity-info/50 bg-severity-info/12 text-severity-info',
};

export function SeverityBadge({ severity, className }: { severity: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info,
        className,
      )}
    >
      {severity}
    </span>
  );
}

/**
 * Confidence is a first-class part of every finding: `confirmed` came from a
 * deterministic detector, `potential` came from model reasoning alone.
 */
export function StatusBadge({ status, source }: { status: string; source?: string }) {
  const tone = status === 'confirmed' ? 'ok' : status === 'likely' ? 'warn' : 'neutral';
  const label = source === 'static' ? `${status} · static` : source === 'hybrid' ? `${status} · static+AI` : `${status} · AI`;
  return <Badge tone={tone}>{label}</Badge>;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-4 w-4 animate-spin text-current', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded bg-surface-raised', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? <div className="mb-1 text-ink-faint">{icon}</div> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <div className="max-w-md text-xs leading-relaxed text-ink-muted">{description}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, retry }: { title?: string; error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="m-4 rounded-lg border border-danger/30 bg-danger/5 p-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{message}</p>
      {retry ? (
        <Button className="mt-3" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs (controlled, no dependency)
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-line', className)} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            'relative -mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
            value === item.value
              ? 'border-accent text-ink'
              : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="ml-1.5 rounded bg-surface-overlay px-1 py-0.5 text-2xs text-ink-muted">{item.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay', className)}>
      <div
        className="h-full rounded-full bg-accent transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function ScoreRing({ score, label }: { score: number; label: string }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const colour = score >= 85 ? '#3fb950' : score >= 70 ? '#4f8cff' : score >= 55 ? '#e5b447' : '#f0506e';

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-14 w-14 shrink-0">
        <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
          <circle cx="28" cy="28" r={radius} fill="none" stroke="#232833" strokeWidth="5" />
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke={colour}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold">{score}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink">{label}</p>
      </div>
    </div>
  );
}
