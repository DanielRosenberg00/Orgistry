import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
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
import { createDbPasswordRecoveryRepository } from './password-recovery.repo';
import { createPasswordRecoveryService } from './password-recovery.service';
import { hashPasswordResetToken } from './password-recovery.token';

/**
 * DB-backed password-recovery + credential-management integration test.
 *
 * Exercises the Sprint 17 lifecycle against a live PostgreSQL through the real
 * Drizzle repositories, asserting the invariants the in-memory unit tests
 * cannot prove: hash-only durable reset-token storage, transactional
 * completion under the FOR-UPDATE row lock (two concurrent completions can
 * never both replace the password), durable session/refresh-token revocation
 * inside the SAME transaction as the password swap, the password-change
 * keep-current-session policy at the SQL layer, and the email-change
 * verification reset. The in-memory account mailer stands in for SMTP — raw
 * tokens are recovered from the captured email links, the recipient's channel.
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
    '[api] Skipping password-recovery.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)(
  'password recovery and credential management against live PostgreSQL',
  () => {
    const config = testConfig();
    let db: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    let mailer: InMemoryAccountMailer;

    const user = {
      email: 'recover.persist@example.com',
      password: 'original-password-123',
      displayName: 'Recover Persist',
    };
    const NEW_PASSWORD = 'reset-password-456';
    // Tracks the user's CURRENT password as the lifecycle suite mutates it.
    // Concurrency tests only WRITE it (they are independently runnable and
    // read nothing from other tests); the later password-change/email-change
    // lifecycle tests read it.
    let activePassword = NEW_PASSWORD;
    let userId: string;
    let firstAccessToken: string;
    let firstRefreshCookie: string;

    function refreshCookieValue(response: LightMyRequestResponse): string {
      const name = config.auth.refreshCookie.name;
      const header = response.headers['set-cookie'];
      const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
      return new RegExp(`${name}=([^;]*)`).exec(raw)?.[1] ?? '';
    }

    beforeAll(async () => {
      await runMigrations(connectionString as string);
      db = createDbClient(connectionString as string);
      await db.sql.unsafe(
        'TRUNCATE memberships, organizations, security_events, password_reset_tokens, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
      );

      mailer = createInMemoryAccountMailer();
      const emailVerificationService = createEmailVerificationService({
        repo: createDbEmailVerificationRepository(db.db),
        mailer,
        webBaseUrl: config.web.url,
        ttlSeconds: config.emailVerification.ttlSeconds,
      });
      const passwordRecoveryService = createPasswordRecoveryService({
        repo: createDbPasswordRecoveryRepository(db.db),
        mailer,
        webBaseUrl: config.web.url,
        ttlSeconds: config.passwordRecovery.ttlSeconds,
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
        passwordRecoveryService,
        logger: false,
      });
      await app.ready();

      const registered = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: user,
      });
      expect(registered.statusCode).toBe(201);
      userId = registered.json().data.user.id;
      firstAccessToken = registered.json().data.tokens.accessToken;
      firstRefreshCookie = refreshCookieValue(registered);
    });

    afterAll(async () => {
      await app.close();
      await db.close();
    });

    function requestReset(email: string) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/password-recovery/request',
        payload: { email },
      });
    }

    function completeReset(token: string, newPassword: string) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/password-recovery/complete',
        payload: { token, newPassword },
      });
    }

    function login(password: string, email = user.email) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password },
      });
    }

    function refresh(cookieToken: string) {
      return app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: `${config.auth.refreshCookie.name}=${cookieToken}`,
          [config.auth.csrfHeaderName]: '1',
        },
      });
    }

    function me(accessToken: string) {
      return app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
    }

    it('request persists a hash-only reset token row and answers generically', async () => {
      const known = await requestReset(user.email);
      expect(known.statusCode).toBe(200);
      expect(known.json().data).toEqual({ accepted: true });

      const rawToken = mailer.lastLinkToken();
      expect(rawToken).toBeTruthy();
      expect(mailer.lastMessage()!.text).toContain(
        '/auth/reset-password#token=',
      );

      const rows = await db.sql<
        { token_hash: string; used_at: Date | null; expires_at: Date | string }[]
      >`
        SELECT token_hash, used_at, expires_at
        FROM password_reset_tokens WHERE user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(hashPasswordResetToken(rawToken!));
      expect(rows[0].token_hash).not.toBe(rawToken);
      expect(rows[0].used_at).toBeNull();
      // The raw SQL client may return timestamptz as a string; coerce.
      expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('an unknown email produces the identical response and no row', async () => {
      const mailsBefore = mailer.messages.length;
      const unknown = await requestReset('nobody.here@example.com');
      expect(unknown.statusCode).toBe(200);
      expect(unknown.json().data).toEqual({ accepted: true });
      expect(mailer.messages).toHaveLength(mailsBefore);

      const rows = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM password_reset_tokens
      `;
      expect(Number(rows[0].count)).toBe(1);
    });

    it('two concurrent recovery requests leave exactly one usable generation (user-row lock)', async () => {
      const mailsBefore = mailer.messages.length;

      const [firstRequest, secondRequest] = await Promise.all([
        requestReset(user.email),
        requestReset(user.email),
      ]);

      // Both callers get the identical generic acceptance; both emails may
      // legitimately go out (persist-and-commit before send, per request).
      expect(firstRequest.statusCode).toBe(200);
      expect(secondRequest.statusCode).toBe(200);
      expect(firstRequest.json().data).toEqual({ accepted: true });
      expect(secondRequest.json().data).toEqual({ accepted: true });
      const newMessages = mailer.messages.slice(mailsBefore);
      expect(newMessages).toHaveLength(2);

      // Raw tokens come ONLY from the captured emails; they are hashed only
      // here, inside the test, to identify rows — never sent anywhere raw.
      const rawTokens = newMessages.map((message) => {
        const match = message.text.match(/#token=([^&\s]+)/);
        expect(match).toBeTruthy();
        return decodeURIComponent(match![1]);
      });
      expect(rawTokens[0]).not.toBe(rawTokens[1]);

      // Issuance serialized on the user row: exactly one generation is
      // usable; every other generation (incl. the test-1 token) is retired.
      const active = await db.sql<{ token_hash: string }[]>`
        SELECT token_hash FROM password_reset_tokens
        WHERE user_id = ${userId} AND used_at IS NULL AND invalidated_at IS NULL
      `;
      expect(active).toHaveLength(1);
      const winner = rawTokens.find(
        (raw) => hashPasswordResetToken(raw) === active[0].token_hash,
      );
      const loser = rawTokens.find(
        (raw) => hashPasswordResetToken(raw) !== active[0].token_hash,
      );
      expect(winner).toBeTruthy();
      expect(loser).toBeTruthy();
      const invalidated = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM password_reset_tokens
        WHERE user_id = ${userId}
          AND token_hash = ${hashPasswordResetToken(loser!)}
          AND invalidated_at IS NOT NULL AND used_at IS NULL
      `;
      expect(Number(invalidated[0].count)).toBe(1);

      // The losing token cannot reset the password.
      const losingAttempt = await completeReset(loser!, 'loser-password-000');
      expect(losingAttempt.statusCode).toBe(409);
      expect(losingAttempt.json().error.code).toBe('PASSWORD_RESET_TOKEN_USED');
      expect((await login('loser-password-000')).statusCode).toBe(401);

      // No raw token or token hash reached a response or a security event.
      for (const raw of rawTokens) {
        const hash = hashPasswordResetToken(raw);
        for (const body of [firstRequest.body, secondRequest.body]) {
          expect(body).not.toContain(raw);
          expect(body).not.toContain(hash);
        }
        const leaked = await db.sql<{ count: string }[]>`
          SELECT count(*) FROM security_events
          WHERE metadata::text LIKE ${'%' + raw + '%'}
             OR metadata::text LIKE ${'%' + hash + '%'}
        `;
        expect(Number(leaked[0].count)).toBe(0);
      }

      // The surviving token DOES reset the password — the generation
      // invariant closes inside this test; nothing is exported to others.
      const winningCompletion = await completeReset(
        winner!,
        'generation-winner-pass-456',
      );
      expect(winningCompletion.statusCode).toBe(200);
      expect((await login('generation-winner-pass-456')).statusCode).toBe(200);
      expect((await login(user.password)).statusCode).toBe(401);
      activePassword = 'generation-winner-pass-456';
    });

    it('two concurrent completions cannot both succeed (FOR UPDATE serialization)', async () => {
      // Self-contained: issue a FRESH generation and take its emailed token —
      // no dependency on any other test having run.
      expect((await requestReset(user.email)).statusCode).toBe(200);
      const rawToken = mailer.lastLinkToken()!;

      const [first, second] = await Promise.all([
        completeReset(rawToken, NEW_PASSWORD),
        completeReset(rawToken, 'competing-password-789'),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      // Exactly one consumption of THIS token is durable.
      const used = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM password_reset_tokens
        WHERE token_hash = ${hashPasswordResetToken(rawToken)}
          AND used_at IS NOT NULL
      `;
      expect(Number(used[0].count)).toBe(1);

      // Exactly one durable password result: one candidate authenticates,
      // the losing attempt created no second change.
      const loginA = await login(NEW_PASSWORD);
      const loginB = await login('competing-password-789');
      expect([loginA.statusCode, loginB.statusCode].sort()).toEqual([200, 401]);
      activePassword =
        loginA.statusCode === 200 ? NEW_PASSWORD : 'competing-password-789';
    });

    it('the reset durably revoked every pre-reset session and refresh token', async () => {
      // The registration session (the only one alive at reset time) was
      // revoked with the reset reason, together with its refresh tokens.
      const sessions = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM sessions
        WHERE user_id = ${userId} AND revoked_reason = 'password_reset'
      `;
      expect(Number(sessions[0].count)).toBeGreaterThanOrEqual(1);
      const tokens = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM refresh_tokens rt
        JOIN sessions s ON s.id = rt.session_id
        WHERE s.user_id = ${userId} AND rt.revoked_reason = 'password_reset'
      `;
      expect(Number(tokens[0].count)).toBeGreaterThanOrEqual(1);

      // Old access token fails at session revalidation; old cookie cannot mint.
      expect((await me(firstAccessToken)).statusCode).toBe(401);
      expect((await refresh(firstRefreshCookie)).statusCode).toBe(401);
    });

    it('password change keeps the current session and revokes the rest at the SQL layer', async () => {
      // Two fresh sessions with the post-reset password.
      const winner = await login(activePassword);
      const winnerLogin = winner.json().data.tokens.accessToken as string;
      const winnerCookie = refreshCookieValue(winner);
      const loser = await login(activePassword);
      const loserAccess = loser.json().data.tokens.accessToken as string;
      const loserCookie = refreshCookieValue(loser);

      const changed = await app.inject({
        method: 'POST',
        url: '/v1/auth/change-password',
        headers: { authorization: `Bearer ${winnerLogin}` },
        payload: {
          currentPassword: activePassword,
          newPassword: 'changed-password-999',
        },
      });
      expect(changed.statusCode).toBe(200);

      // Caller's session and refresh chain survive.
      expect((await me(winnerLogin)).statusCode).toBe(200);
      expect((await refresh(winnerCookie)).statusCode).toBe(200);
      // The other session and its refresh chain are durably dead.
      expect((await me(loserAccess)).statusCode).toBe(401);
      expect((await refresh(loserCookie)).statusCode).toBe(401);

      const revoked = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM sessions
        WHERE user_id = ${userId} AND revoked_reason = 'password_changed'
      `;
      expect(Number(revoked[0].count)).toBeGreaterThanOrEqual(1);

      // Old and new password behave as expected.
      expect((await login(activePassword)).statusCode).toBe(401);
      activePassword = 'changed-password-999';
      expect((await login(activePassword)).statusCode).toBe(200);
    });

    it('email change durably swaps the address, clears verification, and reissues', async () => {
      const session = await login('changed-password-999');
      const accessToken = session.json().data.tokens.accessToken as string;

      const changed = await app.inject({
        method: 'POST',
        url: '/v1/auth/change-email',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          currentPassword: 'changed-password-999',
          newEmail: 'Recover.Renamed@Example.com',
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().data.user.emailVerified).toBe(false);

      const rows = await db.sql<
        { email: string; normalized_email: string; email_verified_at: Date | null }[]
      >`
        SELECT email, normalized_email, email_verified_at
        FROM users WHERE id = ${userId}
      `;
      expect(rows[0].email).toBe('Recover.Renamed@Example.com');
      expect(rows[0].normalized_email).toBe('recover.renamed@example.com');
      expect(rows[0].email_verified_at).toBeNull();

      // A fresh verification generation exists and the email went to the new
      // address.
      expect(mailer.lastMessage()!.to).toBe('Recover.Renamed@Example.com');
      const usable = await db.sql<{ count: string }[]>`
        SELECT count(*) FROM email_verification_tokens
        WHERE user_id = ${userId} AND used_at IS NULL AND invalidated_at IS NULL
      `;
      expect(Number(usable[0].count)).toBe(1);

      // Login follows the new address.
      expect(
        (await login('changed-password-999', 'recover.renamed@example.com'))
          .statusCode,
      ).toBe(200);
    });

    it('wrote durable, sanitized credential-lifecycle security events', async () => {
      const rows = await db.sql<
        { event_type: string; metadata: Record<string, unknown> }[]
      >`
        SELECT event_type, metadata FROM security_events
        WHERE event_type LIKE 'auth.password%' OR event_type LIKE 'auth.email_change%'
      `;
      const types = rows.map((row) => row.event_type);
      expect(types).toContain('auth.password_reset_requested');
      expect(types).toContain('auth.password_reset_completed');
      expect(types).toContain('auth.password_changed');
      expect(types).toContain('auth.email_changed');

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(user.password);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain('changed-password-999');
      expect(serialized).not.toMatch(/token_hash|tokenHash/);
      expect(serialized).not.toContain('/auth/reset-password');
    });
  },
);
