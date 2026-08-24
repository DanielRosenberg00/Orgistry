import type { Config } from '@orgistry/config';
import { schema } from '@orgistry/db';
import type { DbExecutor } from '@orgistry/db';
import { and, count, eq, gte, inArray, lt, notExists, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Retention policy catalog (Sprint 25, ORG-PR-015).
 *
 * ONE definition per lifecycle category, and it is the only place a deletion
 * predicate is written. A category names the table it deletes from, the
 * timestamp column the age cutoff applies to, the configured window, and the
 * two operations the executor needs: count eligible rows (dry-run) and delete
 * one bounded batch (apply).
 *
 * Safety model — the invariants every category here must satisfy:
 *
 *  1. **Age, never state.** Every predicate is `<timestamp column> < cutoff`,
 *     where `cutoff = now - window`. No category infers eligibility from a
 *     status string, a nullable lifecycle marker, or a join.
 *  2. **Expired means unusable.** For the token/session categories the column
 *     is `expires_at`, and the platform already refuses every expired token
 *     and session at use time. A row selected here is therefore dead state by
 *     the schema's own rules, not a judgement call made by this file.
 *  3. **Index-backed.** Each predicate is served by a real index (named in
 *     `supportingIndex`); see packages/db/src/schema/auth.ts.
 *  4. **Bounded.** Deletion always runs through a `LIMIT`-ed id subselect, so
 *     one statement can never delete more than the batch size.
 *
 * DELIBERATELY NOT COVERED — these tables are durable lifecycle records by
 * their own schema contracts, and deleting them would destroy history the
 * product exposes:
 *
 *  - `invitations`   — "Rows are NEVER hard-deleted" (schema/invitations.ts);
 *                      expiry is derived at read time, and accepted/revoked
 *                      rows are the audit trail of who joined an organization.
 *  - `api_keys`      — revoked, never hard-deleted (schema/api-keys.ts); the
 *                      revoked row is what proves a key existed.
 *  - `users`, `organizations`, `memberships`, `projects` — account and tenant
 *                      state, soft-deleted at most. Account deletion is a
 *                      product feature, not a retention sweep.
 *
 * There is also no separate audit table: the audit read path (Sprint 20) reads
 * `security_events`, so audit retention IS the `security_events` category.
 */

/** Stable category identifiers. Used by `--category` and by every summary. */
export const RETENTION_CATEGORY_NAMES = [
  'security_events',
  'expired_refresh_tokens',
  'expired_sessions',
  'expired_email_verification_tokens',
  'expired_password_reset_tokens',
  'expired_pending_registrations',
] as const;

export type RetentionCategoryName = (typeof RETENTION_CATEGORY_NAMES)[number];

/** The retention windows the catalog reads. Matches `Config['retention']`. */
export type RetentionWindows = Config['retention'];

/**
 * The run-wide facts a category may need beyond its own cutoff: the full
 * window set and the instant the run derives every cutoff from. Only
 * `expired_sessions` uses it — to compute the cutoffs of the tables that
 * REFERENCE a session, so it can tell whether a referrer is itself expendable.
 */
export interface RetentionRunContext {
  readonly windows: RetentionWindows;
  readonly now: Date;
}

export interface RetentionCategory {
  /** Stable identifier — also the `--category` value and summary key. */
  readonly name: RetentionCategoryName;
  /** The table rows are deleted from. */
  readonly table: string;
  /** Why the table grows, in one line. */
  readonly growthDriver: string;
  /** The timestamp column the age cutoff is applied to. */
  readonly retentionColumn: string;
  /** The index that serves this category's predicate. */
  readonly supportingIndex: string;
  /** Configured minimum age, in whole days, before a row becomes eligible. */
  windowDays(windows: RetentionWindows): number;
  /** Rows currently eligible for deletion. Never mutates. */
  countEligible(
    executor: DbExecutor,
    cutoff: Date,
    context: RetentionRunContext,
  ): Promise<number>;
  /**
   * Delete at most `batchSize` eligible rows and return how many were
   * deleted. Called inside a transaction owned by the executor.
   */
  deleteBatch(
    executor: DbExecutor,
    cutoff: Date,
    batchSize: number,
    context: RetentionRunContext,
  ): Promise<number>;
}

/**
 * Bind an instant as a `timestamptz` parameter.
 *
 * The Drizzle query builder maps a `Date` through the column's type when it
 * knows the column; the raw `sql` template does not, and the postgres.js
 * driver rejects a bare `Date` in that position. Sending the ISO-8601 string
 * with an explicit cast is unambiguous (the value carries its own UTC offset)
 * and stays a BOUND PARAMETER, never string-concatenated SQL.
 */
function isoParam(instant: Date) {
  return sql`${instant.toISOString()}::timestamptz`;
}

/**
 * Build a category whose whole rule is "delete rows older than the cutoff",
 * with no dependent rows to clear first. Five of the six categories are this
 * shape, so the two statements exist once:
 *
 *   SELECT count(*)     FROM t WHERE col < cutoff                  -- dry-run
 *   DELETE FROM t WHERE id IN (
 *     SELECT id FROM t WHERE col < cutoff ORDER BY col LIMIT n)     -- apply
 *
 * The `LIMIT`-ed subselect is the standard PostgreSQL bounded-delete idiom:
 * PostgreSQL has no `DELETE ... LIMIT`, so the rows are chosen by a bounded
 * SELECT and deleted by primary key. `ORDER BY col` makes the batch the
 * OLDEST eligible rows, which keeps repeated runs monotonic and lets the
 * planner walk the supporting index. Concurrent inserts cannot widen the
 * batch: the subselect is evaluated once, inside the batch's transaction.
 *
 * Why `sql` templates rather than the Drizzle query builder here (the
 * `expired_sessions` category below uses the builder): `.from()` cannot be
 * applied to a table held in a generic type parameter, so a shared factory
 * has to drop to the template form. Nothing is string-concatenated — the
 * table and columns are interpolated as schema OBJECTS (Drizzle emits their
 * quoted identifiers) and the cutoff and batch size are bound parameters, so
 * the statements are exactly as injection-safe as the builder.
 */
function ageBasedCategory(definition: {
  name: RetentionCategoryName;
  table: string;
  growthDriver: string;
  retentionColumn: string;
  supportingIndex: string;
  windowDays: (windows: RetentionWindows) => number;
  drizzleTable: PgTable;
  idColumn: PgColumn;
  cutoffColumn: PgColumn;
}): RetentionCategory {
  const { drizzleTable, idColumn, cutoffColumn } = definition;

  return {
    name: definition.name,
    table: definition.table,
    growthDriver: definition.growthDriver,
    retentionColumn: definition.retentionColumn,
    supportingIndex: definition.supportingIndex,
    windowDays: definition.windowDays,

    async countEligible(executor, cutoff) {
      const rows = await executor.execute<{ eligible: number }>(
        sql`select count(*)::int as eligible from ${drizzleTable}
            where ${cutoffColumn} < ${isoParam(cutoff)}`,
      );
      return rows[0]?.eligible ?? 0;
    },

    async deleteBatch(executor, cutoff, batchSize) {
      const deleted = await executor.execute(
        sql`delete from ${drizzleTable} where ${idColumn} in (
              select ${idColumn} from ${drizzleTable}
              where ${cutoffColumn} < ${isoParam(cutoff)}
              order by ${cutoffColumn}
              limit ${batchSize}
            ) returning ${idColumn}`,
      );
      return deleted.length;
    },
  };
}

/**
 * Sessions eligible for deletion.
 *
 * `sessions` is the only retention target with INBOUND foreign keys, and it
 * has two: `refresh_tokens.session_id` and `security_events.session_id`.
 * Neither has `ON DELETE CASCADE` — deliberately, so nothing can delete
 * session or audit history implicitly. Deleting a session therefore requires
 * that no retained row still points at it.
 *
 * The rule this encodes: **a session is deleted only when every row that
 * references it is ITSELF past its own retention cutoff.** A session that
 * still has a retained referrer is held back and picked up by a later run.
 * Two consequences, both intended:
 *
 *  - **Refresh tokens are only ever deleted by their own predicate.** Refresh
 *    lifetimes are not capped by the session (`auth.service.ts — refresh`
 *    mints a successor at `now + refreshTokenTtl`), so a token rotated shortly
 *    before a session ends outlives it and a session becomes eligible before
 *    that token does. Holding the session back makes the active-token
 *    guarantee STRUCTURAL: it depends on nothing outside this file — in
 *    particular not on the (true, but remote) fact that the rotation path
 *    rejects a token whose session has expired before it checks the token's
 *    own expiry.
 *  - **Audit history is never mutated to make a delete succeed.** Security
 *    events are retained far longer than sessions (180 d vs 90 d by default),
 *    so in a real database most expired sessions ARE still referenced by a
 *    retained event. Without this clause the category fails on every run with
 *    SQLSTATE 23503; the alternatives — cascading the delete, or nulling
 *    `security_events.session_id` — would each destroy audit fidelity to
 *    reclaim a session row. Sessions are therefore effectively retained until
 *    their events age out. That is correct, and it is documented in
 *    docs/retention.md rather than hidden behind a nominal 90-day window.
 *
 * Each referrer clause uses THAT referrer's own retention cutoff, so the
 * predicate stays correct if the windows are configured independently.
 *
 * Index support: the outer predicate walks `ix_sessions_expires_at`; the
 * correlated subqueries walk `ix_refresh_tokens_session_id` and
 * `ix_security_events_session_id`.
 */
function deletableSessionsWhere(
  executor: DbExecutor,
  cutoff: Date,
  windows: RetentionWindows,
  now: Date,
) {
  const securityEventCutoff = new Date(
    now.getTime() - windows.securityEventDays * MILLISECONDS_PER_DAY,
  );

  return and(
    lt(schema.sessions.expiresAt, cutoff),
    // No refresh token in the family is still inside its own window.
    notExists(
      executor
        .select({ retained: sql`1` })
        .from(schema.refreshTokens)
        .where(
          and(
            eq(schema.refreshTokens.sessionId, schema.sessions.id),
            gte(schema.refreshTokens.expiresAt, cutoff),
          ),
        ),
    ),
    // No retained security event still attributes anything to this session.
    notExists(
      executor
        .select({ retained: sql`1` })
        .from(schema.securityEvents)
        .where(
          and(
            eq(schema.securityEvents.sessionId, schema.sessions.id),
            gte(schema.securityEvents.createdAt, securityEventCutoff),
          ),
        ),
    ),
  );
}

const expiredSessions: RetentionCategory = {
  name: 'expired_sessions',
  table: 'sessions',
  growthDriver: 'One row per login; rows are never removed at logout (revocation is a marker).',
  retentionColumn: 'expires_at',
  supportingIndex: 'ix_sessions_expires_at',
  windowDays: (windows) => windows.endedSessionDays,

  async countEligible(executor, cutoff, context) {
    const rows = await executor
      .select({ eligible: count() })
      .from(schema.sessions)
      .where(deletableSessionsWhere(executor, cutoff, context.windows, context.now));
    return rows[0]?.eligible ?? 0;
  },

  async deleteBatch(executor, cutoff, batchSize, context) {
    // The batch is filtered in SQL rather than skipped afterwards, so a
    // held-back session never consumes a batch slot and never causes the
    // executor's short-batch termination to fire early.
    const doomed = await executor
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(deletableSessionsWhere(executor, cutoff, context.windows, context.now))
      .orderBy(schema.sessions.expiresAt)
      .limit(batchSize);

    const sessionIds = doomed.map((row) => row.id);
    if (sessionIds.length === 0) {
      return 0;
    }

    // Every token reachable here is provably `expires_at < cutoff` — the
    // selection above excluded any session that still holds a retained one.
    // `expired_refresh_tokens` normally removes them first; this delete keeps
    // the category correct when run alone via `--category`.
    await executor
      .delete(schema.refreshTokens)
      .where(inArray(schema.refreshTokens.sessionId, sessionIds));

    const deleted = await executor
      .delete(schema.sessions)
      .where(inArray(schema.sessions.id, sessionIds))
      .returning({ id: schema.sessions.id });
    return deleted.length;
  },
};

/**
 * The ordered catalog. Order matters exactly once: `expired_refresh_tokens`
 * runs before `expired_sessions`, so a session whose last token ages out in
 * the same run is released in that run rather than the next one.
 */
export const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  ageBasedCategory({
    name: 'security_events',
    table: 'security_events',
    growthDriver:
      'One row per authentication, authorization, and audited mutation event.',
    retentionColumn: 'created_at',
    supportingIndex: 'ix_security_events_created_at',
    windowDays: (windows) => windows.securityEventDays,
    drizzleTable: schema.securityEvents,
    idColumn: schema.securityEvents.id,
    cutoffColumn: schema.securityEvents.createdAt,
  }),
  ageBasedCategory({
    name: 'expired_refresh_tokens',
    table: 'refresh_tokens',
    growthDriver:
      'One row per refresh rotation; a long-lived session accumulates a whole family.',
    retentionColumn: 'expires_at',
    supportingIndex: 'ix_refresh_tokens_expires_at',
    windowDays: (windows) => windows.endedSessionDays,
    drizzleTable: schema.refreshTokens,
    idColumn: schema.refreshTokens.id,
    cutoffColumn: schema.refreshTokens.expiresAt,
  }),
  expiredSessions,
  ageBasedCategory({
    name: 'expired_email_verification_tokens',
    table: 'email_verification_tokens',
    growthDriver: 'One row per verification request/resend.',
    retentionColumn: 'expires_at',
    supportingIndex: 'ix_email_verification_tokens_expires_at',
    windowDays: (windows) => windows.expiredAuthTokenDays,
    drizzleTable: schema.emailVerificationTokens,
    idColumn: schema.emailVerificationTokens.id,
    cutoffColumn: schema.emailVerificationTokens.expiresAt,
  }),
  ageBasedCategory({
    name: 'expired_password_reset_tokens',
    table: 'password_reset_tokens',
    growthDriver: 'One row per password-recovery request.',
    retentionColumn: 'expires_at',
    supportingIndex: 'ix_password_reset_tokens_expires_at',
    windowDays: (windows) => windows.expiredAuthTokenDays,
    drizzleTable: schema.passwordResetTokens,
    idColumn: schema.passwordResetTokens.id,
    cutoffColumn: schema.passwordResetTokens.expiresAt,
  }),
  ageBasedCategory({
    name: 'expired_pending_registrations',
    table: 'pending_registrations',
    growthDriver:
      'One row per public registration request, including requests never completed.',
    retentionColumn: 'expires_at',
    supportingIndex: 'ix_pending_registrations_expires_at',
    windowDays: (windows) => windows.expiredAuthTokenDays,
    drizzleTable: schema.pendingRegistrations,
    idColumn: schema.pendingRegistrations.id,
    cutoffColumn: schema.pendingRegistrations.expiresAt,
  }),
];

/** Look up one category by name, or `undefined` when the name is unknown. */
export function findRetentionCategory(
  name: string,
): RetentionCategory | undefined {
  return RETENTION_CATEGORIES.find((category) => category.name === name);
}

/** Milliseconds in one day. Retention windows are whole days. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The deletion cutoff for a category: rows strictly older than this instant
 * are eligible. Derived from an explicit `now` so every run — and every test —
 * is deterministic.
 */
export function retentionCutoff(
  category: RetentionCategory,
  windows: RetentionWindows,
  now: Date,
): Date {
  return new Date(now.getTime() - category.windowDays(windows) * MILLISECONDS_PER_DAY);
}
