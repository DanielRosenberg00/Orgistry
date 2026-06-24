import type {
  MembershipRow,
  OrganizationRow,
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

/** Values for inserting a new user. */
export interface NewUser {
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  displayName: string;
}

/**
 * Inputs for the transactional account-registration provisioning.
 *
 * Registration must atomically create a user, their personal workspace
 * (organization + active Owner membership), a session, and the first refresh
 * token. Bundling these into one repository call lets the database
 * implementation run them in a single transaction so a partial failure can
 * never leave a user without a personal workspace.
 */
export interface RegisterAccountParams {
  user: NewUser;
  /** Personal workspace to create. `slugBase` is resolved to a unique slug. */
  personalWorkspace: {
    name: string;
    slugBase: string;
  };
  session: {
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
  };
  refreshToken: {
    /** SHA-256 hash of the raw token. The raw token is never persisted. */
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  };
}

/** Rows created by a successful `registerAccount` transaction. */
export interface RegisterAccountResult {
  user: UserRow;
  organization: OrganizationRow;
  membership: MembershipRow;
  session: SessionRow;
  refreshToken: RefreshTokenRow;
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
  insertUser(values: NewUser): Promise<UserRow>;
  /**
   * Atomically provision a newly registered account: user + personal workspace
   * (organization + active Owner membership) + session + first refresh token.
   * Implementations MUST run this as a single transaction — if any step fails,
   * nothing is persisted, so a user can never exist without a personal
   * workspace. A duplicate normalized email surfaces as the same conflict as
   * `insertUser`.
   */
  registerAccount(params: RegisterAccountParams): Promise<RegisterAccountResult>;
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

  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
