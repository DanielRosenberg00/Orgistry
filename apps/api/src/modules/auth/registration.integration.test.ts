import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { requireRow } from '../../lib/db-rows';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../mail/testing/in-memory-account-mailer';
import { createDbRegistrationRepository } from './registration.repo';
import { createRegistrationService } from './registration.service';
import {
  lastCompletionTokenFor,
  registerTestUser,
} from './testing/register-test-user';

/**
 * DB-backed verification-first registration integration tests (Sprint 18).
 *
 * These prove the properties the in-memory suite cannot: the advisory-lock
 * issuance serialization, the partial unique index on usable generations, the
 * `FOR UPDATE` completion race (exactly one account per token), and the
 * atomicity of the completion transaction against a REAL PostgreSQL.
 *
 * Destructive (truncates auth + org tables), so it prefers
 * `TEST_DATABASE_URL`. When no database is reachable it SKIPS with a warning
 * rather than passing silently. Run via `pnpm test:integration`.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping registration.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)(
  'verification-first registration against live PostgreSQL',
  () => {
    const config = testConfig();
    let db: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    let mailer: InMemoryAccountMailer;

    const account = {
      email: 'Race.User@Example.com',
      password: 'a-strong-password-123',
      displayName: 'Race User',
    };
    const normalizedEmail = 'race.user@example.com';

    beforeAll(async () => {
      await runMigrations(connectionString as string);
      db = createDbClient(connectionString as string);

      mailer = createInMemoryAccountMailer();
      const registrationService = createRegistrationService({
        repo: createDbRegistrationRepository(db.db),
        mailer,
        webBaseUrl: config.web.url,
        completionTtlSeconds: config.registration.completionTtlSeconds,
        jwtSecret: config.auth.jwtSecret,
        accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
        sessionTtlSeconds: config.auth.sessionTtlSeconds,
        refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
      });
      app = buildApp({
        config,
        readinessProbes: [passingProbe('postgres')],
        registrationService,
        logger: false,
      });
      await app.ready();
    });

    beforeEach(async () => {
      await db.sql.unsafe(
        'TRUNCATE pending_registrations, memberships, organization_plans, organizations, security_events, password_reset_tokens, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
      );
      mailer.messages.length = 0;
    });

    afterAll(async () => {
      await app.close();
      await db.close();
    });

    function register() {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: account,
      });
    }

    function complete(token: string) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/registration/complete',
        payload: { token },
      });
    }

    it('stages hash-only material and creates no account state on request', async () => {
      const response = await register();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, data: { accepted: true } });

      const pendingRows = await db.sql<
        { password_hash: string; token_hash: string; invitation_id: string | null }[]
      >`
        SELECT password_hash, token_hash, invitation_id
        FROM pending_registrations WHERE normalized_email = ${normalizedEmail}
      `;
      expect(pendingRows).toHaveLength(1);
      const pendingRow = requireRow(pendingRows, 'pending registration row');
      expect(pendingRow.password_hash.startsWith('$argon2id$')).toBe(true);
      expect(pendingRow.password_hash).not.toContain(account.password);
      const rawToken = lastCompletionTokenFor(mailer, account.email) as string;
      expect(pendingRow.token_hash).not.toBe(rawToken);
      expect(pendingRow.invitation_id).toBeNull();

      const userCount = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM users
      `;
      expect(userCount[0]?.count).toBe('0');
      const sessionCount = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM sessions
      `;
      expect(sessionCount[0]?.count).toBe('0');
    });

    it('serializes CONCURRENT issuance for one email: exactly one usable generation survives', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => register()),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
      const rows = await db.sql<{ usable: string; total: string }[]>`
        SELECT
          count(*) FILTER (WHERE used_at IS NULL AND invalidated_at IS NULL)::text AS usable,
          count(*)::text AS total
        FROM pending_registrations WHERE normalized_email = ${normalizedEmail}
      `;
      expect(rows[0]?.total).toBe('6');
      expect(rows[0]?.usable).toBe('1');
    });

    it('completes exactly ONE of many concurrent completion attempts for the same token', async () => {
      await register();
      const rawToken = lastCompletionTokenFor(mailer, account.email) as string;

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => complete(rawToken)),
      );
      const succeeded = responses.filter((r) => r.statusCode === 201);
      const conflicts = responses.filter((r) => r.statusCode === 409);
      expect(succeeded).toHaveLength(1);
      expect(conflicts).toHaveLength(5);
      for (const conflict of conflicts) {
        expect(conflict.json().error.code).toBe('REGISTRATION_TOKEN_USED');
        expect(conflict.headers['set-cookie']).toBeUndefined();
      }

      // Exactly one of everything — no duplicate resources from the race.
      const counts = await db.sql<
        { users: string; orgs: string; memberships: string; sessions: string; tokens: string }[]
      >`
        SELECT
          (SELECT count(*) FROM users)::text AS users,
          (SELECT count(*) FROM organizations)::text AS orgs,
          (SELECT count(*) FROM memberships)::text AS memberships,
          (SELECT count(*) FROM sessions)::text AS sessions,
          (SELECT count(*) FROM refresh_tokens)::text AS tokens
      `;
      expect(counts[0]).toEqual({
        users: '1',
        orgs: '1',
        memberships: '1',
        sessions: '1',
        tokens: '1',
      });
    });

    it('creates a fully provisioned, email-verified account on completion', async () => {
      await register();
      const rawToken = lastCompletionTokenFor(mailer, account.email) as string;
      const response = await complete(rawToken);
      expect(response.statusCode).toBe(201);
      expect(response.json().data.user.emailVerified).toBe(true);
      expect(response.headers['set-cookie']).toBeDefined();

      const users = await db.sql<
        { email_verified_at: string | null; password_hash: string }[]
      >`
        SELECT email_verified_at, password_hash FROM users
        WHERE normalized_email = ${normalizedEmail}
      `;
      expect(users).toHaveLength(1);
      const userRow = requireRow(users, 'completed user row');
      expect(userRow.email_verified_at).not.toBeNull();
      expect(userRow.password_hash.startsWith('$argon2id$')).toBe(true);

      // Pending registration consumed.
      const pending = await db.sql<{ used_at: string | null }[]>`
        SELECT used_at FROM pending_registrations
        WHERE normalized_email = ${normalizedEmail}
      `;
      expect(
        requireRow(pending, 'consumed pending registration').used_at,
      ).not.toBeNull();

      // The new session works end-to-end (personal workspace + membership).
      const memberships = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM memberships
      `;
      expect(memberships[0]?.count).toBe('1');
    });

    it('a repeated request supersedes the previous emailed link at the database', async () => {
      await register();
      const firstToken = lastCompletionTokenFor(mailer, account.email) as string;
      await register();
      const secondToken = lastCompletionTokenFor(mailer, account.email) as string;
      expect(secondToken).not.toBe(firstToken);

      const superseded = await complete(firstToken);
      expect(superseded.statusCode).toBe(409);
      expect(superseded.json().error.code).toBe('REGISTRATION_TOKEN_USED');
      const current = await complete(secondToken);
      expect(current.statusCode).toBe(201);
    });

    it('leaves NO orphaned account state when the email was taken during the pending window', async () => {
      await register();
      const rawToken = lastCompletionTokenFor(mailer, account.email) as string;
      // Another account claims the address (the email-change path) meanwhile.
      await registerTestUser(app, mailer, {
        email: 'squatter@example.com',
        password: account.password,
        displayName: 'Squatter',
      });
      await db.sql`
        UPDATE users SET email = ${account.email}, normalized_email = ${normalizedEmail}
        WHERE normalized_email = 'squatter@example.com'
      `;
      const orgsBefore = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM organizations
      `;

      const response = await complete(rawToken);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('REGISTRATION_TOKEN_INVALID');

      // Still exactly one user for the address and no extra workspace/session.
      const users = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM users
        WHERE normalized_email = ${normalizedEmail}
      `;
      expect(users[0]?.count).toBe('1');
      const orgsAfter = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM organizations
      `;
      expect(requireRow(orgsAfter, 'org count after').count).toBe(
        requireRow(orgsBefore, 'org count before').count,
      );
    });

    it('records anonymous request events and a user-attributed completion event', async () => {
      await register();
      const rawToken = lastCompletionTokenFor(mailer, account.email) as string;
      await complete(rawToken);
      // Probe an existing account: the event must stay anonymous.
      await register();

      const requested = await db.sql<
        { user_id: string | null; metadata: Record<string, unknown> }[]
      >`
        SELECT user_id, metadata FROM security_events
        WHERE event_type = 'auth.registration_requested'
        ORDER BY created_at
      `;
      expect(requested.length).toBeGreaterThanOrEqual(2);
      for (const event of requested) {
        expect(event.user_id).toBeNull();
        const raw = JSON.stringify(event.metadata);
        expect(raw).not.toContain(normalizedEmail);
        expect(raw).not.toContain(rawToken);
      }

      const completed = await db.sql<{ user_id: string | null }[]>`
        SELECT user_id FROM security_events
        WHERE event_type = 'auth.registration_completion_succeeded'
      `;
      expect(completed).toHaveLength(1);
      expect(requireRow(completed, 'completion event').user_id).not.toBeNull();
    });
  },
);
