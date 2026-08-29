import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { get, post } from '@/lib/api';
import type { AppConfig, AuthUser } from '@/lib/types';

interface AuthContextValue {
  user: AuthUser | null;
  config: AppConfig | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => get<{ user: AuthUser | null }>('/api/auth/me'),
    retry: false,
    staleTime: 30_000,
  });

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => get<AppConfig>('/api/config'),
    staleTime: 5 * 60_000,
  });

  const loginMutation = useMutation({
    mutationFn: (input: { email: string; password: string }) => post<{ user: AuthUser }>('/api/auth/login', input),
    onSuccess: (data) => queryClient.setQueryData(['session'], { user: data.user }),
  });

  const registerMutation = useMutation({
    mutationFn: (input: { email: string; password: string; name?: string }) =>
      post<{ user: AuthUser }>('/api/auth/register', input),
    onSuccess: (data) => queryClient.setQueryData(['session'], { user: data.user }),
  });

  const logoutMutation = useMutation({
    mutationFn: () => post('/api/auth/logout'),
    onSuccess: () => {
      queryClient.setQueryData(['session'], { user: null });
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session.data?.user ?? null,
      config: config.data ?? null,
      loading: session.isLoading,
      login: async (email, password) => {
        await loginMutation.mutateAsync({ email, password });
      },
      register: async (email, password, name) => {
        await registerMutation.mutateAsync({ email, password, ...(name ? { name } : {}) });
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
      refresh: async () => {
        await session.refetch();
      },
    }),
    [session, config.data, loginMutation, registerMutation, logoutMutation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
