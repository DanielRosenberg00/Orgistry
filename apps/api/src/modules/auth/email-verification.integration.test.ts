import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../mail/testing/in-memory-account-mailer';
import { createDbAuthRepository } from './auth.repo';
import { createAuthService } from './auth.service';
import { createDbEmailVerificationRepository } from './email-verification.repo';
import { createEmailVerificationService } from './email-verification.service';
import { hashEmailVerificationToken } from './email-verification.token';

/**
 * DB-backed email-verification integration test.
 *
 * Exercises the full lifecycle against a live PostgreSQL through the real
 * Drizzle repository, asserting the invariants the in-memory unit tests
 * cannot prove: hash-only durable storage, transactional consumption under
 * the FOR-UPDATE row lock (two concurrent completions can never both
 * succeed), resend invalidation at the SQL layer, and durable sanitized
 * security events. The in-memory account mailer stands in for SMTP — the raw
 * token is recovered from the captured email link, the recipient's channel.
 *
 * Destructive (truncates auth tables), so it prefers `TEST_DATABASE_URL`.
 * When no database is reachable it SKIPS with a warning rather than passing
 * silently. Run via `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping email-verification.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)(
  'email verification against live PostgreSQL',
  () => {
    const config = testConfig();
    let db: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    let mailer: InMemoryAccountMailer;

    const user = {
      email: 'verify.persist@example.com',
      password: 'a-strong-password-123',
      displayName: 'Verify Persist',
    };
    let accessToken: string;
    let userId: string;

    beforeAll(async () => {
      await runMigrations(connectionString as string);
      db = createDbClient(connectionString as string);
      await db.sql.unsafe(
        'TRUNCATE memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
      );

      mailer = createInMemoryAccountMailer();
      const emailVerificationService = createEmailVerificationService({
        repo: createDbEmailVerificationRepository(db.db),
        mailer,
        webBaseUrl: config.web.url,
        ttlSeconds: config.emailVerification.ttlSeconds,
      });
      const authService = createAuthService({
        repo: createDbAuthRepository(db.db),
        jwtSecret: config.auth.jwtSecret,
        accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
        sessionTtlSeconds: config.auth.sessionTtlSeconds,
        refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
        emailVerification: emailVerificationService,
      });
      app = buildApp({
        config,
        readinessProbes: [passingProbe('postgres')],
        authService,
        emailVerificationService,
        logger: false,
      });
      await app.ready();

      const registered = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: user,
      });
      expect(registered.statusCode).toBe(201);
      accessToken = registered.json().data.tokens.accessToken;
      userId = registered.json().data.user.id;
    });

    afterAll(async () => {
      await app.close();
      await db.close();
    });

    function complete(token: string) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/email-verification/complete',
        payload: { token },
      });
    }

    it('registration persisted a hash-only token row for the emailed link', async () => {
      const rawToken = mailer.lastLinkToken();
      expect(rawToken).toBeTruthy();

      const rows = await db.sql<
        { token_hash: string; used_at: Date | null; invalidated_at: Date | null }[]
      >`
        SELECT token_hash, used_at, invalidated_at
        FROM email_verification_tokens WHERE user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(hashEmailVerificationToken(rawToken!));
      expect(rows[0].token_hash).not.toBe(rawToken);
      expect(rows[0].used_at).toBeNull();
      expect(rows[0].invalidated_at).toBeNull();
    });

    it('resend durably invalidates the previous generation', async () => {
      const resend = await app.inject({
        method: 'POST',
        url: '/v1/auth/email-verification/request',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(resend.statusCode).toBe(200);

      const usable = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM email_verification_tokens
        WHERE user_id = ${userId} AND used_at IS NULL AND invalidated_at IS NULL
      `;
      expect(Number(usable[0].count)).toBe(1);
    });

    it('two concurrent completions cannot both succeed (FOR UPDATE serialization)', async () => {
      const rawToken = mailer.lastLinkToken()!;

      const [first, second] = await Promise.all([
        complete(rawToken),
        complete(rawToken),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const users = await db.sql<{ email_verified_at: Date | null }[]>`
        SELECT email_verified_at FROM users WHERE id = ${userId}
      `;
      expect(users[0].email_verified_at).not.toBeNull();

      const used = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM email_verification_tokens
        WHERE user_id = ${userId} AND used_at IS NOT NULL
      `;
      expect(Number(used[0].count)).toBe(1);
    });

    it('reuse after success is rejected and durable state is unchanged', async () => {
      const rawToken = mailer.lastLinkToken()!;
      const reuse = await complete(rawToken);
      expect(reuse.statusCode).toBe(409);
      expect(reuse.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');

      const usable = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM email_verification_tokens
        WHERE user_id = ${userId} AND used_at IS NULL AND invalidated_at IS NULL
      `;
      expect(Number(usable[0].count)).toBe(0);
    });

    it('wrote durable, sanitized verification security events', async () => {
      const rows = await db.sql<
        { event_type: string; metadata: Record<string, unknown> }[]
      >`
        SELECT event_type, metadata FROM security_events
        WHERE event_type LIKE 'auth.email_verification%'
      `;
      const types = rows.map((row) => row.event_type);
      expect(types).toContain('auth.email_verification_requested');
      expect(types).toContain('auth.email_verification_succeeded');

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(mailer.lastLinkToken()!);
      expect(serialized).not.toMatch(/token_hash|tokenHash/);
    });

    it('the verified state is reflected by the current-user contract', async () => {
      const meResponse = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(meResponse.json().data.user.emailVerified).toBe(true);
    });
  },
);
