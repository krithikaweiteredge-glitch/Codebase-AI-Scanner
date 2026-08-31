import { Network } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Card, Input, PasswordInput } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/useAuth';

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name || undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent/15 text-accent">
            <Network className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Codebase Intelligence</h1>
            <p className="text-2xs text-ink-muted">Internal developer tool</p>
          </div>
        </div>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
          <p className="mt-1 text-xs text-ink-muted">
            {mode === 'login'
              ? 'Use your account to access connected repositories.'
              : 'Accounts are local to this deployment. Connect GitHub after signing up.'}
          </p>

          <form onSubmit={submit} className="mt-4 space-y-3">
            {mode === 'register' ? (
              <label className="block">
                <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-faint">Name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
              </label>
            ) : null}

            <label className="block">
              <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-faint">Email</span>
              <Input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-faint">Password</span>
              <PasswordInput
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {mode === 'register' ? (
                <span className="mt-1 block text-2xs text-ink-faint">At least 8 characters.</span>
              ) : null}
            </label>

            {error ? (
              <p className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-xs text-danger">{error}</p>
            ) : null}

            <Button type="submit" variant="primary" size="md" className="w-full" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <button
            className="mt-3 w-full text-center text-2xs text-ink-muted hover:text-ink"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
          </button>
        </Card>
      </div>
    </div>
  );
}
