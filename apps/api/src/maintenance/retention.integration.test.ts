import { createDbClient, runMigrations, schema } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { count, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRetentionCleanup, type RetentionRunSummary } from './retention';
import { retentionExitCode } from './retention-cli';
import {
  RETENTION_CATEGORIES,
  findRetentionCategory,
  type RetentionWindows,
} from './retention-policy';

/**
 * PostgreSQL-backed retention cleanup tests (Sprint 25, ORG-PR-015).
 *
 * The properties under test are all relational or temporal — timestamp
 * boundaries, foreign-key ordering between sessions and refresh tokens,
 * `LIMIT`-ed batch deletion, and re-run safety — so they are proven against a
 * REAL PostgreSQL rather than a fake.
 *
 * Every fixture timestamp is derived from a fixed `NOW`, so no case depends on
 * wall-clock timing or a sleep.
 *
 * Destructive (truncates the auth tables), so it prefers `TEST_DATABASE_URL`.
 * When no database is reachable it SKIPS with a warning rather than passing
 * silently. Run via `pnpm test:integration`.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping retention.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

/** Fixed reference instant; every fixture and cutoff is derived from it. */
const NOW = new Date('2026-08-24T12:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/** `days` before NOW. Negative values are in the future. */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Windows used by every case. Chosen to be far from the fixture ages. */
const WINDOWS: RetentionWindows = {
  securityEventDays: 180,
  expiredAuthTokenDays: 30,
  endedSessionDays: 90,
  cleanupBatchSize: 100,
};

describe.skipIf(!connectionString)(
  'retention cleanup against live PostgreSQL',
  () => {
    let db: ReturnType<typeof createDbClient>;
    let userId: string;

    /** Run the cleanup with the fixed clock and the shared windows. */
    async function cleanup(
      overrides: {
        mode?: 'dry-run' | 'apply';
        batchSize?: number;
        maxBatchesPerCategory?: number;
        categories?: typeof RETENTION_CATEGORIES;
        client?: ReturnType<typeof createDbClient>;
      } = {},
    ): Promise<RetentionRunSummary> {
      return runRetentionCleanup(overrides.client ?? db, {
        mode: overrides.mode ?? 'dry-run',
        windows: WINDOWS,
        batchSize: overrides.batchSize ?? WINDOWS.cleanupBatchSize,
        maxBatchesPerCategory: overrides.maxBatchesPerCategory ?? 1_000,
        categories: overrides.categories ?? RETENTION_CATEGORIES,
        now: NOW,
      });
    }

    /** The result for one category, by name. */
    function resultFor(summary: RetentionRunSummary, category: string) {
      const result = summary.results.find((entry) => entry.category === category);
      expect(result, `no result for category ${category}`).toBeDefined();
      return result!;
    }

    /** Row count for a table. Uses the template form so it works for any table. */
    async function rowCount(table: PgTable): Promise<number> {
      const rows = await db.db.execute<{ total: number }>(
        sql`select count(*)::int as total from ${table}`,
      );
      return rows[0]?.total ?? 0;
    }

    beforeAll(async () => {
      await runMigrations(connectionString as string);
      db = createDbClient(connectionString as string);
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.sql.unsafe(
        'TRUNCATE pending_registrations, security_events, password_reset_tokens, email_verification_tokens, refresh_tokens, sessions, memberships, organization_plans, organizations, users RESTART IDENTITY CASCADE',
      );

      const [user] = await db.db
        .insert(schema.users)
        .values({
          email: 'Retention.Subject@example.com',
          normalizedEmail: 'retention.subject@example.com',
          passwordHash: '$argon2id$v=19$m=1,t=1,p=1$fixture$fixture-not-a-real-hash',
          displayName: 'Retention Subject',
        })
        .returning({ id: schema.users.id });
      userId = user!.id;
    });

    /** Insert a session with an explicit expiry, plus one refresh token in it. */
    async function seedSession(expiresAt: Date): Promise<string> {
      const [session] = await db.db
        .insert(schema.sessions)
        .values({ userId, expiresAt })
        .returning({ id: schema.sessions.id });
      const sessionId = session!.id;
      await db.db.insert(schema.refreshTokens).values({
        sessionId,
        tokenHash: `hash-${sessionId}`,
        familyId: `fam-${sessionId}`,
        expiresAt,
      });
      return sessionId;
    }

    describe('dry-run mode', () => {
      it('counts eligible rows and mutates nothing', async () => {
        await db.db.insert(schema.securityEvents).values([
          { actorType: 'system', eventType: 'test.old', createdAt: daysAgo(400) },
          { actorType: 'system', eventType: 'test.old', createdAt: daysAgo(200) },
          { actorType: 'system', eventType: 'test.recent', createdAt: daysAgo(10) },
        ]);
        await seedSession(daysAgo(365));
        await seedSession(daysAgo(1));

        const summary = await cleanup({ mode: 'dry-run' });

        expect(resultFor(summary, 'security_events').eligible).toBe(2);
        expect(resultFor(summary, 'expired_sessions').eligible).toBe(1);
        expect(resultFor(summary, 'expired_refresh_tokens').eligible).toBe(1);
        expect(summary.totalDeleted).toBe(0);
        expect(summary.failedCategories).toBe(0);

        // Nothing was removed.
        expect(await rowCount(schema.securityEvents)).toBe(3);
        expect(await rowCount(schema.sessions)).toBe(2);
        expect(await rowCount(schema.refreshTokens)).toBe(2);
      });

      it('reports zero batches and no deletions for every category', async () => {
        const summary = await cleanup({ mode: 'dry-run' });

        for (const result of summary.results) {
          expect(result.deleted).toBe(0);
          expect(result.batches).toBe(0);
          expect(result.truncated).toBe(false);
        }
      });
    });

    describe('apply mode', () => {
      it('deletes expired rows and preserves active ones', async () => {
        const expiredSessionId = await seedSession(daysAgo(365));
        const activeSessionId = await seedSession(daysAgo(-30));

        await db.db.insert(schema.securityEvents).values([
          { actorType: 'user', eventType: 'auth.login_succeeded', createdAt: daysAgo(400) },
          { actorType: 'user', eventType: 'auth.login_succeeded', createdAt: daysAgo(5) },
        ]);
        await db.db.insert(schema.emailVerificationTokens).values([
          { userId, tokenHash: 'evtok-old', expiresAt: daysAgo(90) },
          { userId, tokenHash: 'evtok-live', expiresAt: daysAgo(-1) },
        ]);
        await db.db.insert(schema.passwordResetTokens).values([
          { userId, tokenHash: 'prtok-old', expiresAt: daysAgo(90) },
          { userId, tokenHash: 'prtok-live', expiresAt: daysAgo(-1) },
        ]);
        await db.db.insert(schema.pendingRegistrations).values([
          {
            email: 'stale@example.com',
            normalizedEmail: 'stale@example.com',
            passwordHash: 'fixture-hash-stale',
            displayName: 'Stale',
            tokenHash: 'preg-old',
            expiresAt: daysAgo(90),
          },
          {
            email: 'fresh@example.com',
            normalizedEmail: 'fresh@example.com',
            passwordHash: 'fixture-hash-fresh',
            displayName: 'Fresh',
            tokenHash: 'preg-live',
            expiresAt: daysAgo(-1),
          },
        ]);

        const summary = await cleanup({ mode: 'apply' });

        expect(summary.failedCategories).toBe(0);
        expect(resultFor(summary, 'security_events').deleted).toBe(1);
        expect(resultFor(summary, 'expired_refresh_tokens').deleted).toBe(1);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(1);
        expect(resultFor(summary, 'expired_email_verification_tokens').deleted).toBe(1);
        expect(resultFor(summary, 'expired_password_reset_tokens').deleted).toBe(1);
        expect(resultFor(summary, 'expired_pending_registrations').deleted).toBe(1);
        expect(summary.totalDeleted).toBe(6);

        // The active half of every pair survived.
        expect(await rowCount(schema.securityEvents)).toBe(1);
        expect(await rowCount(schema.emailVerificationTokens)).toBe(1);
        expect(await rowCount(schema.passwordResetTokens)).toBe(1);
        expect(await rowCount(schema.pendingRegistrations)).toBe(1);

        const remainingSessions = await db.db
          .select({ id: schema.sessions.id })
          .from(schema.sessions);
        expect(remainingSessions.map((row) => row.id)).toEqual([activeSessionId]);

        // The expired session's refresh token went with it; the active one stayed.
        const remainingTokens = await db.db
          .select({ sessionId: schema.refreshTokens.sessionId })
          .from(schema.refreshTokens);
        expect(remainingTokens.map((row) => row.sessionId)).toEqual([activeSessionId]);
        expect(remainingTokens.map((row) => row.sessionId)).not.toContain(
          expiredSessionId,
        );

        // The account itself is never touched by retention.
        expect(await rowCount(schema.users)).toBe(1);
      });

      it('never deletes a row younger than its cutoff, including at the boundary', async () => {
        const cutoff = daysAgo(WINDOWS.securityEventDays);
        await db.db.insert(schema.securityEvents).values([
          { actorType: 'system', eventType: 'test.exactly_at_cutoff', createdAt: cutoff },
          {
            actorType: 'system',
            eventType: 'test.one_ms_older',
            createdAt: new Date(cutoff.getTime() - 1),
          },
        ]);

        const summary = await cleanup({
          mode: 'apply',
          categories: [findRetentionCategory('security_events')!],
        });

        // The predicate is strictly `<`: a row AT the cutoff is retained.
        expect(resultFor(summary, 'security_events').deleted).toBe(1);
        const survivors = await db.db
          .select({ eventType: schema.securityEvents.eventType })
          .from(schema.securityEvents);
        expect(survivors.map((row) => row.eventType)).toEqual([
          'test.exactly_at_cutoff',
        ]);
      });

      it('is idempotent — a second apply deletes nothing more', async () => {
        await db.db.insert(schema.securityEvents).values(
          Array.from({ length: 5 }, (_unused, index) => ({
            actorType: 'system' as const,
            eventType: `test.old_${index}`,
            createdAt: daysAgo(400),
          })),
        );

        const first = await cleanup({ mode: 'apply' });
        const second = await cleanup({ mode: 'apply' });

        expect(first.totalDeleted).toBe(5);
        expect(second.totalDeleted).toBe(0);
        expect(second.failedCategories).toBe(0);
        expect(retentionExitCode(second)).toBe(0);
        expect(await rowCount(schema.securityEvents)).toBe(0);
      });

      it('honors the batch size and reports a truncated category', async () => {
        await db.db.insert(schema.securityEvents).values(
          Array.from({ length: 7 }, (_unused, index) => ({
            actorType: 'system' as const,
            eventType: `test.old_${index}`,
            createdAt: daysAgo(400 + index),
          })),
        );

        const capped = await cleanup({
          mode: 'apply',
          batchSize: 2,
          maxBatchesPerCategory: 2,
          categories: [findRetentionCategory('security_events')!],
        });

        // Two batches of two — the cap stopped the sweep with a backlog left.
        expect(resultFor(capped, 'security_events').deleted).toBe(4);
        expect(resultFor(capped, 'security_events').batches).toBe(2);
        expect(resultFor(capped, 'security_events').truncated).toBe(true);
        expect(await rowCount(schema.securityEvents)).toBe(3);

        // Re-running with the same cap finishes the backlog and stops cleanly.
        const rest = await cleanup({
          mode: 'apply',
          batchSize: 2,
          maxBatchesPerCategory: 5,
          categories: [findRetentionCategory('security_events')!],
        });
        expect(resultFor(rest, 'security_events').deleted).toBe(3);
        expect(resultFor(rest, 'security_events').truncated).toBe(false);
        expect(await rowCount(schema.securityEvents)).toBe(0);
      });

      it('deletes the oldest rows first', async () => {
        await db.db.insert(schema.securityEvents).values([
          { actorType: 'system', eventType: 'test.oldest', createdAt: daysAgo(500) },
          { actorType: 'system', eventType: 'test.middle', createdAt: daysAgo(400) },
          { actorType: 'system', eventType: 'test.newest_eligible', createdAt: daysAgo(300) },
        ]);

        await cleanup({
          mode: 'apply',
          batchSize: 1,
          maxBatchesPerCategory: 1,
          categories: [findRetentionCategory('security_events')!],
        });

        const survivors = await db.db
          .select({ eventType: schema.securityEvents.eventType })
          .from(schema.securityEvents);
        expect(survivors.map((row) => row.eventType).sort()).toEqual([
          'test.middle',
          'test.newest_eligible',
        ]);
      });

      it('touches only the selected category', async () => {
        await db.db.insert(schema.securityEvents).values({
          actorType: 'system',
          eventType: 'test.old',
          createdAt: daysAgo(400),
        });
        await seedSession(daysAgo(365));

        const summary = await cleanup({
          mode: 'apply',
          categories: [findRetentionCategory('expired_sessions')!],
        });

        expect(summary.results).toHaveLength(1);
        expect(await rowCount(schema.sessions)).toBe(0);
        expect(await rowCount(schema.securityEvents)).toBe(1);
      });

      it('clears a session’s refresh tokens even when run as the only category', async () => {
        // `expired_refresh_tokens` normally runs first; running the session
        // sweep alone must still satisfy the foreign key.
        await seedSession(daysAgo(365));

        const summary = await cleanup({
          mode: 'apply',
          categories: [findRetentionCategory('expired_sessions')!],
        });

        expect(summary.failedCategories).toBe(0);
        expect(await rowCount(schema.sessions)).toBe(0);
        expect(await rowCount(schema.refreshTokens)).toBe(0);
      });

      it('keeps a refresh token whose own expiry is still inside the window', async () => {
        // A token that outlives its session must not be swept early: only its
        // own `expires_at` decides, and the session sweep only reaches tokens
        // belonging to sessions it is deleting.
        const [session] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: daysAgo(-10) })
          .returning({ id: schema.sessions.id });
        await db.db.insert(schema.refreshTokens).values({
          sessionId: session!.id,
          tokenHash: 'rtok-live',
          familyId: 'fam-live',
          expiresAt: daysAgo(-5),
        });

        await cleanup({ mode: 'apply' });

        expect(await rowCount(schema.refreshTokens)).toBe(1);
        expect(await rowCount(schema.sessions)).toBe(1);
      });

      it('holds back an eligible session whose refresh token is NOT yet eligible', async () => {
        // THE INVARIANT: a refresh token is deleted only by its OWN predicate.
        // Refresh-token lifetimes are not capped by the session (rotation mints
        // `now + refreshTokenTtl`), so a session can become retention-eligible
        // while a token in its family is still inside the window. The session
        // must wait rather than take the token with it to satisfy the foreign
        // key.
        const sessionExpiry = daysAgo(WINDOWS.endedSessionDays + 30);
        const [session] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: sessionExpiry })
          .returning({ id: schema.sessions.id });
        // Rotated shortly before the session ended, so it outlives it and is
        // still inside the retention window.
        await db.db.insert(schema.refreshTokens).values({
          sessionId: session!.id,
          tokenHash: 'rtok-outlives-session',
          familyId: 'fam-outlives-session',
          expiresAt: daysAgo(WINDOWS.endedSessionDays - 10),
        });

        const summary = await cleanup({ mode: 'apply' });

        expect(resultFor(summary, 'expired_refresh_tokens').deleted).toBe(0);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(0);
        expect(await rowCount(schema.refreshTokens)).toBe(1);
        expect(await rowCount(schema.sessions)).toBe(1);

        // Dry-run must agree with apply: a held-back session is not reported
        // as eligible either, or the operator would be told rows will go that
        // will not.
        const dryRun = await cleanup({ mode: 'dry-run' });
        expect(resultFor(dryRun, 'expired_sessions').eligible).toBe(0);
      });

      it('releases the held-back session once its last token ages out', async () => {
        const sessionExpiry = daysAgo(WINDOWS.endedSessionDays + 30);
        const [session] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: sessionExpiry })
          .returning({ id: schema.sessions.id });
        await db.db.insert(schema.refreshTokens).values({
          sessionId: session!.id,
          tokenHash: 'rtok-aged-out',
          familyId: 'fam-aged-out',
          expiresAt: daysAgo(WINDOWS.endedSessionDays + 1),
        });

        const summary = await cleanup({ mode: 'apply' });

        expect(resultFor(summary, 'expired_refresh_tokens').deleted).toBe(1);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(1);
        expect(await rowCount(schema.refreshTokens)).toBe(0);
        expect(await rowCount(schema.sessions)).toBe(0);
      });

      it('holds back an eligible session still referenced by a RETAINED security event', async () => {
        // `security_events.session_id` is a second inbound foreign key on
        // `sessions`, and security events are retained far longer than
        // sessions (180 d vs 90 d by default). Deleting the session would
        // either violate the constraint or require mutating audit rows;
        // neither is acceptable, so the session waits.
        const [session] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: daysAgo(WINDOWS.endedSessionDays + 100) })
          .returning({ id: schema.sessions.id });
        await db.db.insert(schema.securityEvents).values({
          userId,
          sessionId: session!.id,
          actorType: 'user',
          eventType: 'auth.login_succeeded',
          createdAt: daysAgo(WINDOWS.securityEventDays - 10),
        });

        const summary = await cleanup({ mode: 'apply' });

        expect(summary.failedCategories).toBe(0);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(0);
        expect(await rowCount(schema.sessions)).toBe(1);
        expect(await rowCount(schema.securityEvents)).toBe(1);

        const dryRun = await cleanup({ mode: 'dry-run' });
        expect(resultFor(dryRun, 'expired_sessions').eligible).toBe(0);
      });

      it('releases the session once the referencing security event ages out', async () => {
        const [session] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: daysAgo(WINDOWS.endedSessionDays + 100) })
          .returning({ id: schema.sessions.id });
        await db.db.insert(schema.securityEvents).values({
          userId,
          sessionId: session!.id,
          actorType: 'user',
          eventType: 'auth.login_succeeded',
          createdAt: daysAgo(WINDOWS.securityEventDays + 10),
        });

        const summary = await cleanup({ mode: 'apply' });

        expect(summary.failedCategories).toBe(0);
        expect(resultFor(summary, 'security_events').deleted).toBe(1);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(1);
        expect(await rowCount(schema.sessions)).toBe(0);
        expect(await rowCount(schema.securityEvents)).toBe(0);
      });

      it('does not let a held-back session block other eligible sessions in a batch', async () => {
        // The hold-back is expressed in the SELECT, not by skipping rows after
        // the fact, so a blocked session never consumes a batch slot and never
        // triggers the executor's short-batch termination early.
        const blockedExpiry = daysAgo(WINDOWS.endedSessionDays + 100);
        const [blocked] = await db.db
          .insert(schema.sessions)
          .values({ userId, expiresAt: blockedExpiry })
          .returning({ id: schema.sessions.id });
        await db.db.insert(schema.refreshTokens).values({
          sessionId: blocked!.id,
          tokenHash: 'rtok-blocking',
          familyId: 'fam-blocking',
          expiresAt: daysAgo(-1),
        });
        // Two clean sessions, both NEWER than the blocked one, so an
        // `ORDER BY expires_at LIMIT 1` batch would hit the blocked row first
        // if it were not filtered out in SQL.
        await seedSession(daysAgo(WINDOWS.endedSessionDays + 20));
        await seedSession(daysAgo(WINDOWS.endedSessionDays + 10));

        const summary = await cleanup({
          mode: 'apply',
          batchSize: 1,
          categories: [findRetentionCategory('expired_sessions')!],
        });

        expect(resultFor(summary, 'expired_sessions').deleted).toBe(2);
        const remaining = await db.db
          .select({ id: schema.sessions.id })
          .from(schema.sessions);
        expect(remaining.map((row) => row.id)).toEqual([blocked!.id]);
        expect(await rowCount(schema.refreshTokens)).toBe(1);
      });
    });

    describe('failure handling', () => {
      it('reports a non-zero exit code when the database is unreachable', async () => {
        const unreachable = createDbClient(
          'postgres://orgistry:orgistry@127.0.0.1:1/orgistry_does_not_exist',
        );
        try {
          const summary = await cleanup({ mode: 'apply', client: unreachable });

          expect(summary.failedCategories).toBe(RETENTION_CATEGORIES.length);
          expect(summary.totalDeleted).toBe(0);
          expect(retentionExitCode(summary)).toBe(1);
          for (const result of summary.results) {
            expect(result.failure?.message).toBeTruthy();
          }
        } finally {
          await unreachable.close().catch(() => undefined);
        }
      });
    });

    describe('output hygiene', () => {
      it('emits counts and table metadata only — never row contents', async () => {
        await db.db.insert(schema.emailVerificationTokens).values({
          userId,
          tokenHash: 'evtok-secret-material-fixture',
          expiresAt: daysAgo(90),
        });
        await db.db.insert(schema.securityEvents).values({
          actorType: 'user',
          userId,
          eventType: 'auth.login_succeeded',
          metadata: { normalizedEmail: 'retention.subject@example.com' },
          createdAt: daysAgo(400),
        });

        const serialized = JSON.stringify(await cleanup({ mode: 'apply' }));

        for (const forbidden of [
          'evtok-secret-material-fixture',
          'retention.subject@example.com',
          userId,
          'argon2id',
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      });
    });

    describe('cleanup predicates use their supporting indexes', () => {
      it('has every index the retention predicates depend on', async () => {
        // A tiny fixture table is legitimately scanned sequentially, so the
        // assertion is that the index EXISTS, not that a fixture-sized query
        // chooses it.
        const indexes = await db.sql.unsafe(
          "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
        );
        const names = indexes.map((row) => row.indexname as string);

        for (const category of RETENTION_CATEGORIES) {
          expect(names, `${category.name} is missing ${category.supportingIndex}`).toContain(
            category.supportingIndex,
          );
        }

        // The ended-session predicate additionally runs one correlated
        // subquery per inbound foreign key on `sessions`. Each needs its own
        // index or the sweep degrades to a scan of the referencing table.
        for (const referrerIndex of [
          'ix_refresh_tokens_session_id',
          'ix_security_events_session_id',
        ]) {
          expect(names, `session referrer index ${referrerIndex} is missing`).toContain(
            referrerIndex,
          );
        }
      });

      it('covers every inbound foreign key on a retention target', async () => {
        // If a future migration adds a table that references one of these,
        // the cleanup must learn about it — otherwise the category starts
        // failing on SQLSTATE 23503 (which is exactly how the
        // `security_events.session_id` reference was found).
        const targets = RETENTION_CATEGORIES.map((category) => category.table);
        const rows = await db.sql.unsafe(`
          SELECT c.conrelid::regclass::text AS referencing_table,
                 c.confrelid::regclass::text AS referenced_table
            FROM pg_constraint c
           WHERE c.contype = 'f'
             AND c.confrelid::regclass::text = ANY($1)
        `, [targets]);

        const inbound = rows.map(
          (row) => `${row.referencing_table as string} -> ${row.referenced_table as string}`,
        );
        // The complete, reviewed set. Adding to this list REQUIRES extending
        // the corresponding category's predicate first.
        expect(inbound.sort()).toEqual([
          'refresh_tokens -> sessions',
          'security_events -> sessions',
        ]);
      });
    });

    describe('durable tables are out of scope', () => {
      it('leaves invitations and API keys untouched by every category', async () => {
        const tables = RETENTION_CATEGORIES.map((category) => category.table);
        expect(tables).not.toContain('invitations');
        expect(tables).not.toContain('api_keys');

        // And prove it end to end: nothing in the catalog can reach them.
        const summary = await cleanup({ mode: 'apply' });
        expect(summary.results.map((result) => result.table)).toEqual(tables);
      });
    });

    describe('foreign-key ordering', () => {
      it('sweeps refresh tokens before sessions in one full run', async () => {
        await seedSession(daysAgo(365));

        const summary = await cleanup({ mode: 'apply' });

        // The child sweep claimed the token; the parent sweep claimed the session.
        expect(resultFor(summary, 'expired_refresh_tokens').deleted).toBe(1);
        expect(resultFor(summary, 'expired_sessions').deleted).toBe(1);
        expect(summary.failedCategories).toBe(0);

        const remaining = await db.db
          .select({ total: count() })
          .from(schema.sessions)
          .where(eq(schema.sessions.userId, userId));
        expect(remaining[0]?.total).toBe(0);
      });
    });
  },
);
