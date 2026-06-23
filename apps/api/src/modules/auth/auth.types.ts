import type { SecurityActorType, SessionRow, UserRow } from '@orgistry/db';

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

/** Values for inserting a new session. */
export interface NewSession {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
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
  insertSession(values: NewSession): Promise<SessionRow>;
  findSessionById(id: string): Promise<SessionRow | null>;
  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
