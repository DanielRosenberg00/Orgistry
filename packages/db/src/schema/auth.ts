import { createId } from '@orgistry/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Authentication & security persistence (Sprint 2).
 *
 * Design rules enforced by this schema:
 *  - Public identifiers are prefixed, opaque strings (see `@orgistry/shared`).
 *    No numeric/serial keys are ever exposed.
 *  - Secrets are stored hash-only: `users.password_hash`,
 *    `refresh_tokens.token_hash`, `email_verification_tokens.token_hash`. Raw
 *    passwords and raw tokens are never persisted.
 *  - Lifecycle state is explicit (`status`, `*_at` timestamps,
 *    `revoked_at`/`revoked_reason`) rather than inferred.
 *
 * `refresh_tokens` backs the Sprint 3 session lifecycle (rotation, reuse
 * detection); `email_verification_tokens` backs the Sprint 16 email
 * verification lifecycle (request/resend + public completion).
 */

// Shared timestamp helpers keep every table's audit columns identical.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Account lifecycle. `disabled` blocks login without deleting the record. */
export type UserStatus = 'active' | 'disabled';

/**
 * Who a security event is attributed to. `api_key` is the machine actor for
 * external API key authentication events (Sprint 8) — never a user.
 */
export type SecurityActorType = 'user' | 'system' | 'anonymous' | 'api_key';

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('user')),
    // Email as the user typed it (display/contact). Uniqueness is enforced on
    // the normalized form, not this column.
    email: text('email').notNull(),
    // Lowercased/trimmed email used for lookup and the uniqueness constraint.
    normalizedEmail: text('normalized_email').notNull(),
    // Argon2id encoded hash. Never returned by any public API.
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    // Null until email verification completes (Sprint 16: set once, inside the
    // same transaction that consumes the verification token; never cleared).
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft-delete marker, consistent with the platform data model.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // One account per normalized email — the core registration invariant.
    uniqueIndex('uq_users_normalized_email').on(table.normalizedEmail),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('sess')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // Best-effort client metadata captured at session creation.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    clientName: text('client_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Lookup all sessions for a user (future session-list/revocation).
    index('ix_sessions_user_id').on(table.userId),
    // Retention sweep (Sprint 25, ORG-PR-015): the ended-session cleanup
    // predicate is `expires_at < cutoff`, so an expired session is selected
    // through this index rather than a sequential scan.
    index('ix_sessions_expires_at').on(table.expiresAt),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('rtok')),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    // SHA-256 of the raw refresh token. The raw value is returned to the client
    // once (later sprint) and never stored.
    tokenHash: text('token_hash').notNull(),
    // Rotation lineage: all tokens minted from one login share a family, so a
    // detected reuse can revoke the whole family in a later sprint.
    familyId: text('family_id').notNull(),
    parentTokenId: text('parent_token_id'),
    replacementTokenId: text('replacement_token_id'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (table) => [
    // Constant-time-ish lookup of a presented token by its hash.
    uniqueIndex('uq_refresh_tokens_token_hash').on(table.tokenHash),
    index('ix_refresh_tokens_session_id').on(table.sessionId),
    index('ix_refresh_tokens_family_id').on(table.familyId),
    // Retention sweep (Sprint 25, ORG-PR-015): the expired-refresh-token
    // cleanup predicate is `expires_at < cutoff`, and the expired-session
    // cleanup deletes a session's tokens before the session row. Both scan
    // this index instead of the whole table.
    index('ix_refresh_tokens_expires_at').on(table.expiresAt),
  ],
);

/**
 * Email-verification tokens (activated in Sprint 16).
 *
 * Lifecycle is explicit — the two terminal timestamps have DISTINCT meanings
 * and are never overloaded:
 *  - `used_at`        — the token was CONSUMED by a successful verification;
 *  - `invalidated_at` — the token was RETIRED unused (superseded by a
 *    request/resend that issued a replacement, or retired as a sibling when
 *    another token completed verification).
 *
 * A token is usable only while `used_at IS NULL AND invalidated_at IS NULL
 * AND expires_at > now()`. At most one usable token exists per user after any
 * request/resend (the issue path invalidates all prior unused tokens in the
 * same transaction that inserts the replacement).
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('evtok')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // SHA-256 of the raw verification token; raw value is emailed, never stored.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_email_verification_tokens_token_hash').on(table.tokenHash),
    index('ix_email_verification_tokens_user_id').on(table.userId),
    // Retention sweep (Sprint 25, ORG-PR-015): cleanup deletes on
    // `expires_at < cutoff` — an expired token is unusable by definition, so
    // the predicate needs no lifecycle column beyond expiry.
    index('ix_email_verification_tokens_expires_at').on(table.expiresAt),
  ],
);

/**
 * Password-reset tokens (Sprint 17).
 *
 * DELIBERATELY a separate table from `email_verification_tokens`: the two
 * token families answer different questions ("may this address be marked
 * verified?" vs "may this caller replace the account password?"), carry
 * different blast radii, and will have different retention/cleanup policies.
 * Overloading one table would make token meaning ambiguous.
 *
 * Lifecycle mirrors the verification-token model — the two terminal
 * timestamps have DISTINCT meanings and are never overloaded:
 *  - `used_at`        — the token was CONSUMED by a successful password reset;
 *  - `invalidated_at` — the token was RETIRED unused (superseded by a newer
 *    recovery request, or retired as a sibling when another token completed).
 *
 * A token is usable only while `used_at IS NULL AND invalidated_at IS NULL
 * AND expires_at > now()`. At most one usable token exists per user after any
 * recovery request. The row stores NO request metadata (no IP, no user agent,
 * no link) — the security-events seam owns sanitized request context.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('prtok')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // SHA-256 of the raw reset token; the raw value is emailed, never stored.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // Lookup of a presented token by hash; uniqueness also guards insert races.
    uniqueIndex('uq_password_reset_tokens_token_hash').on(table.tokenHash),
    // Active-token invalidation scans by user.
    index('ix_password_reset_tokens_user_id').on(table.userId),
    // Retention sweep (Sprint 25, ORG-PR-015): cleanup deletes on
    // `expires_at < cutoff` — an expired token is unusable by definition, so
    // the predicate needs no lifecycle column beyond expiry.
    index('ix_password_reset_tokens_expires_at').on(table.expiresAt),
  ],
);

/**
 * Pending registrations (Sprint 18 — verification-first registration).
 *
 * A public registration request no longer creates a user. It stages the
 * submitted profile here — with the password ALREADY hashed (Argon2id) and the
 * emailed completion token stored ONLY as a SHA-256 hash — and the account is
 * created exclusively by the completion endpoint after raw-token proof.
 *
 * Lifecycle mirrors the other token tables — the two terminal timestamps have
 * DISTINCT meanings and are never overloaded:
 *  - `used_at`        — the pending registration was CONSUMED by a successful
 *    completion (the account now exists);
 *  - `invalidated_at` — the generation was RETIRED unused (superseded by a
 *    newer registration request for the same normalized email, or retired as
 *    a sibling when another generation completed).
 *
 * A generation is usable only while `used_at IS NULL AND invalidated_at IS
 * NULL AND expires_at > now()`. The partial unique index below enforces the
 * one-usable-generation-per-normalized-email invariant structurally (issuance
 * invalidates every prior unused generation — expired or not — in the same
 * transaction that inserts the replacement, serialized by an advisory lock on
 * the normalized email).
 *
 * `invitation_id` is the OPTIONAL stable reference to a pending invitation
 * supplied at request time. Deliberately the row id, never the invitation
 * token or its hash — no invitation secret material is persisted here. The
 * invitation lifecycle is re-checked authoritatively at completion.
 *
 * The row stores NO request metadata (no IP, no user agent, no URL) — the
 * security-events seam owns sanitized request context. Expired rows are
 * deleted by the Sprint 25 retention cleanup on `expires_at` (indexed below);
 * see `apps/api/src/maintenance/retention-policy.ts`.
 */
export const pendingRegistrations = pgTable(
  'pending_registrations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('preg')),
    // Email as the user typed it (becomes `users.email` at completion).
    email: text('email').notNull(),
    // Lowercased/trimmed email; lifecycle and replacement key on this.
    normalizedEmail: text('normalized_email').notNull(),
    // Argon2id encoded hash, computed BEFORE staging. The raw password is
    // never persisted anywhere.
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    // SHA-256 of the raw completion token; the raw value is emailed, never stored.
    tokenHash: text('token_hash').notNull(),
    // Stable reference to the invitation supplied at request time (never the
    // invitation token or its hash). Null for plain registrations. Deliberately
    // carries no foreign key (the invitations schema module already imports
    // this one — same convention as `security_events.organization_id`);
    // completion treats an unresolvable reference as invitation-unavailable.
    invitationId: text('invitation_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // Lookup of a presented completion token by hash (the completion path).
    uniqueIndex('uq_pending_registrations_token_hash').on(table.tokenHash),
    // Replacement + sibling invalidation scan by normalized email.
    index('ix_pending_registrations_normalized_email').on(table.normalizedEmail),
    // Structural one-usable-generation guard. Partial so historical (used or
    // invalidated) rows never block a new generation.
    uniqueIndex('uq_pending_registrations_usable_email')
      .on(table.normalizedEmail)
      .where(sql`used_at IS NULL AND invalidated_at IS NULL`),
    // Retention sweep (Sprint 25, ORG-PR-015): cleanup deletes on
    // `expires_at < cutoff`; this index backs that predicate.
    index('ix_pending_registrations_expires_at').on(table.expiresAt),
  ],
);

export const securityEvents = pgTable(
  'security_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('sevt')),
    // Nullable: a failed login for an unknown email has no user to attribute to.
    userId: text('user_id').references(() => users.id),
    sessionId: text('session_id').references(() => sessions.id),
    // Tenant scope for organization-scoped events (the audit read path filters
    // on it). Intentionally carries no foreign key — auth-module events predate
    // organizations and anonymous events have no tenant.
    organizationId: text('organization_id'),
    actorType: text('actor_type').$type<SecurityActorType>().notNull(),
    // Dotted event name, e.g. `auth.login_succeeded`.
    eventType: text('event_type').notNull(),
    // Sanitized structured context. Never contains secrets (see the writer).
    metadata: jsonb('metadata').notNull().default({}),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('ix_security_events_user_id').on(table.userId),
    index('ix_security_events_event_type').on(table.eventType),
    index('ix_security_events_created_at').on(table.createdAt),
    // Retention sweep (Sprint 25, ORG-PR-015). `security_events.session_id`
    // is one of only two inbound foreign keys on `sessions`, so the
    // ended-session cleanup must ask, per candidate session, whether any
    // RETAINED event still references it. Without this index that question is
    // a sequential scan of the platform's largest table.
    index('ix_security_events_session_id').on(table.sessionId),
    // Backs the organization-scoped audit read path (Sprint 20, ORG-PR-014):
    // `WHERE organization_id = ? … ORDER BY created_at DESC, id DESC` with
    // keyset pagination scans this index directly.
    index('ix_security_events_org_created_id').on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type RefreshTokenInsert = typeof refreshTokens.$inferInsert;
export type EmailVerificationTokenRow =
  typeof emailVerificationTokens.$inferSelect;
export type EmailVerificationTokenInsert =
  typeof emailVerificationTokens.$inferInsert;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type PasswordResetTokenInsert = typeof passwordResetTokens.$inferInsert;
export type PendingRegistrationRow = typeof pendingRegistrations.$inferSelect;
export type PendingRegistrationInsert = typeof pendingRegistrations.$inferInsert;
export type SecurityEventRow = typeof securityEvents.$inferSelect;
export type SecurityEventInsert = typeof securityEvents.$inferInsert;
