import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AuthSessionResponse,
  AuthUser,
  CurrentUserResponse,
} from '@orgistry/contracts';
import {
  api,
  onSessionExpired,
  refreshAccessToken,
  setAccessToken,
} from '../api/client';
import { AuthContext, type AuthStatus } from './auth-context';

/**
 * Owns browser authentication for the whole app.
 *
 * Responsibilities:
 *  - boot-time session restore: attempt a refresh against the HttpOnly cookie,
 *    and if it succeeds load the current user (`GET /v1/auth/me`);
 *  - login / register: store the returned access token in memory and the user
 *    in state;
 *  - logout: clear the backend session, the in-memory token, and all cached
 *    query data;
 *  - react to an unrecoverable 401 (the client's session-expired signal) by
 *    dropping back to the unauthenticated state.
 *
 * It deliberately holds NO token in React state — the token lives only in the
 * API client's memory. Auth status is derived from whether a `user` is loaded.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [user, setUser] = useState<AuthUser | null>(null);
  const queryClient = useQueryClient();

  // Stable ref so the session-expired listener (registered once) always calls
  // the latest reset logic without re-subscribing.
  const resetRef = useRef<() => void>(() => {});
  resetRef.current = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
    queryClient.clear();
  }, [queryClient]);

  // Restore a session from the refresh cookie exactly once, at boot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await refreshAccessToken();
      if (cancelled) return;
      if (!restored) {
        setStatus('unauthenticated');
        return;
      }
      try {
        const { user: me } = await api.get<CurrentUserResponse>('/v1/auth/me');
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('unauthenticated');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A failed silent refresh (token no longer recoverable) resets to login.
  useEffect(() => {
    onSessionExpired(() => resetRef.current());
  }, []);

  // Store the access token (memory only) and the user from a fresh session.
  const adoptSession = useCallback((session: AuthSessionResponse) => {
    setAccessToken(session.tokens.accessToken);
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await api.post<AuthSessionResponse>(
        '/v1/auth/login',
        { email, password },
        { authenticated: false, cookieAuth: true },
      );
      adoptSession(session);
    },
    [adoptSession],
  );

  const register = useCallback(
    async (input: { email: string; password: string; displayName: string }) => {
      const session = await api.post<AuthSessionResponse>(
        '/v1/auth/register',
        input,
        { authenticated: false, cookieAuth: true },
      );
      adoptSession(session);
    },
    [adoptSession],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout', undefined, { cookieAuth: true });
    } finally {
      resetRef.current();
    }
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
