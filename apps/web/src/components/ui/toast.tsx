import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (toast: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((current) => [...current.slice(-3), { ...input, id }]);
      setTimeout(() => dismiss(id), input.tone === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ title, description, tone: 'success' }),
      error: (title, description) => toast({ title, description, tone: 'error' }),
      info: (title, description) => toast({ title, description, tone: 'info' }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto animate-slide-up rounded-lg border bg-surface-raised p-3 shadow-xl',
              item.tone === 'success' && 'border-ok/40',
              item.tone === 'error' && 'border-danger/40',
              item.tone === 'info' && 'border-line-strong',
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                {item.tone === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 text-ok" />
                ) : item.tone === 'error' ? (
                  <AlertTriangle className="h-4 w-4 text-danger" />
                ) : (
                  <Info className="h-4 w-4 text-accent" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-ink">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 break-words text-2xs leading-relaxed text-ink-muted">{item.description}</p>
                ) : null}
              </div>
              <button onClick={() => dismiss(item.id)} className="text-ink-faint hover:text-ink" aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
