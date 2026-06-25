import { createContext } from 'react';
import type { AuthUser } from '@orgistry/contracts';

/**
 * Authentication state exposed to the app.
 *
 *  - `restoring` — the boot-time refresh-cookie session restore is in flight;
 *  - `authenticated` — a current user is loaded and an access token is in memory;
 *  - `unauthenticated` — no session.
 *
 * The access token itself is NEVER placed in this context (or any React state):
 * it lives only in the API client's memory. Components branch on `status`/`user`.
 */
export type AuthStatus = 'restoring' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    displayName: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
