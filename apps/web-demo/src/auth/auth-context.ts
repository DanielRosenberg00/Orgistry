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
  /**
   * REQUEST a registration (Sprint 18, verification-first). Resolves when the
   * backend has accepted the request — it does NOT sign the user in and MUST
   * NOT be treated as account creation: the account is created only when the
   * emailed completion link is used (`completeRegistration`).
   *
   * `invitationToken` is the OPTIONAL raw invitation token from an opened
   * invitation link. It rides only in this request body: callers hold it in
   * transient memory for exactly as long as the submission needs it — never
   * storage, never the DOM, never a URL.
   */
  register: (input: {
    email: string;
    password: string;
    displayName: string;
    invitationToken?: string;
  }) => Promise<void>;
  /**
   * Complete a registration with the raw token from the emailed link. On
   * success the backend has created the account and issued a session; the
   * returned user is adopted into authenticated state. The token must only
   * ever live in transient component memory and this request body.
   */
  completeRegistration: (
    token: string,
  ) => Promise<{ invitationUnavailable: boolean }>;
  logout: () => Promise<void>;
  /**
   * Re-fetch `GET /v1/auth/me` and update `user` (no-op when signed out).
   * Verification state (`user.emailVerified`) is ALWAYS backend-derived — the
   * verification flow calls this after completion/resend instead of ever
   * mutating the flag client-side.
   */
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
