import type {
  RefreshTokenRow,
  SecurityActorType,
  SessionRow,
  UserRow,
} from '@orgistry/db';

/**
 * Internal auth-module types.
 *
 * `UserRow`/`SessionRow` are the persistence shapes (they include
 * `passwordHash`); they are used INSIDE the module only and are never returned
 * from a route — the service maps them to the public `AuthUser` contract first.
 */

/** Per-request security context attached to every event and session. */
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Narrow port for the verification email the auth service triggers after an
 * authenticated email change commits (Sprint 17). BEST-EFFORT BY CONTRACT:
 * implementations must never throw — the change has already committed by the
 * time this runs, and an email outage must not undo it. A failed delivery is
 * recorded by the implementation and the user can resend from the
 * authenticated endpoint. OPTIONAL on the auth service: when absent, email
 * change behaves identically except that no verification email goes out.
 *
 * (Until Sprint 18 this port also carried the post-registration verification
 * email. Verification-first registration made that obsolete: a completed
 * account is created email-verified, so registration never sends a
 * verification email at all.)
 */
export interface EmailChangeVerification {
  /** Never throws; `user.email` is the already-committed NEW address. */
  sendEmailChangeVerificationEmail(
    user: { id: string; email: string },
    ctx: RequestContext,
  ): Promise<void>;
}

/** Values for inserting a new session. */
export interface NewSession {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

/** Values for inserting a new refresh token (hash-only, family-linked). */
export interface NewRefreshToken {
  sessionId: string;
  familyId: string;
  /** SHA-256 hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  parentTokenId: string | null;
  expiresAt: Date;
}

/** Inputs to an atomic refresh-token rotation (one transactional swap). */
export interface RotateRefreshTokenParams {
  /** SHA-256 hash of the refresh token presented by the client. */
  presentedTokenHash: string;
  /** SHA-256 hash of the successor token the caller has already generated. */
  successorTokenHash: string;
  successorExpiresAt: Date;
  /** Current time, for expiry checks inside the transaction. */
  now: Date;
}

/**
 * Outcome of an atomic rotation attempt. The repository classifies the
 * presented token purely on its persisted STATE (used/revoked/replaced,
 * expiry, owning-session lifecycle) — the service owns the security policy
 * (what to revoke, what to log) for each outcome.
 *
 *  - `rotated`  — the token was valid; it is now marked used and a single
 *                 successor was inserted in the same family, atomically.
 *  - `reuse`    — the token was already used/replaced/revoked, or its session
 *                 was revoked/expired. Nothing was minted. The family is
 *                 compromised; the service revokes it (see refresh design).
 *  - `expired`  — the (otherwise untouched) token is past its own expiry.
 *  - `not_found`— no token matched the presented hash.
 */
export type RotateRefreshTokenResult =
  | {
      status: 'rotated';
      successor: RefreshTokenRow;
      session: SessionRow;
    }
  | {
      status: 'reuse';
      familyId: string;
      sessionId: string;
      /** Null only if the owning session row is already gone. */
      userId: string | null;
    }
  | { status: 'expired' }
  | { status: 'not_found' };

/** Cursor-pagination inputs for listing a user's sessions. */
export interface ListSessionsParams {
  userId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/**
 * Inputs for the transactional authenticated password change (Sprint 17).
 * `currentSessionId` comes from the server-side authentication context (the
 * session the presented access token is bound to) — NEVER from client input.
 */
export interface ChangePasswordParams {
  userId: string;
  /** Argon2id hash of the new password. The raw password is never persisted. */
  newPasswordHash: string;
  /** The caller's session — the ONLY session that survives the change. */
  currentSessionId: string;
  /** Internal revocation reason stamped on the revoked rows. */
  revokeReason: string;
  now: Date;
}

/**
 * Inputs for the transactional authenticated email change (Sprint 17). The
 * update clears `email_verified_at` and invalidates outstanding verification
 * tokens in the SAME transaction, so a committed change can never leave the
 * old address's verification (or its tokens) usable.
 */
export interface ChangeEmailParams {
  userId: string;
  /** The new email as the user typed it (display/contact form). */
  email: string;
  /** Normalized form; uniqueness is enforced on this. */
  normalizedEmail: string;
  now: Date;
}

/** Values for inserting a sanitized security event. */
export interface NewSecurityEvent {
  userId: string | null;
  sessionId: string | null;
  actorType: SecurityActorType;
  eventType: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Persistence boundary for the auth workflows.
 *
 * Defining the repository as an interface lets the service be unit-tested with
 * an in-memory fake and keeps all SQL in `auth.repo.ts`.
 */
export interface AuthRepository {
  findUserByNormalizedEmail(normalizedEmail: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  insertSession(values: NewSession): Promise<SessionRow>;
  findSessionById(id: string): Promise<SessionRow | null>;

  // ----- Refresh tokens (Sprint 3) -----
  insertRefreshToken(values: NewRefreshToken): Promise<RefreshTokenRow>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null>;
  /**
   * Atomically rotate a refresh token. Implementations MUST guarantee that two
   * concurrent calls with the same `presentedTokenHash` cannot both return
   * `rotated` (i.e. cannot both mint a successor).
   */
  rotateRefreshToken(
    params: RotateRefreshTokenParams,
  ): Promise<RotateRefreshTokenResult>;
  /** Revoke every non-revoked refresh token in a family. */
  revokeRefreshTokenFamily(familyId: string, reason: string): Promise<void>;
  /** Revoke every non-revoked refresh token bound to a session. */
  revokeRefreshTokensForSession(
    sessionId: string,
    reason: string,
  ): Promise<void>;

  // ----- Sessions (Sprint 3) -----
  /** Revoke a session if it is not already revoked (idempotent). */
  revokeSession(sessionId: string, reason: string): Promise<void>;
  /**
   * List a user's active (non-revoked, non-expired) sessions, newest first,
   * one page at a time. Returns up to `limit + 1` rows so the caller can
   * detect a further page without a second query.
   */
  listActiveSessionsForUser(params: ListSessionsParams): Promise<SessionRow[]>;

  // ----- Credential management (Sprint 17) -----
  /**
   * Atomically replace the user's password hash and revoke every OTHER active
   * session (and the refresh tokens of every session except the current one).
   * Implementations MUST run all writes in one transaction so a failure can
   * never leave a new password alongside un-revoked foreign sessions.
   */
  changePasswordKeepingCurrentSession(
    params: ChangePasswordParams,
  ): Promise<void>;
  /**
   * Atomically replace the user's email (raw + normalized), clear
   * `email_verified_at`, and invalidate every unused email-verification token.
   * A duplicate normalized email surfaces as the same conflict error as
   * registration (the unique index is the authoritative guard). Returns the
   * updated row.
   */
  changeEmail(params: ChangeEmailParams): Promise<UserRow>;

  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
