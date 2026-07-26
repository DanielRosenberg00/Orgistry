import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { requireRow } from '../../lib/db-rows';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../mail/testing/in-memory-account-mailer';
import { createAuthService } from './auth.service';
import { createDbAuthRepository } from './auth.repo';
import { createDbRegistrationRepository } from './registration.repo';
import { createRegistrationService } from './registration.service';
import { hashRegistrationCompletionToken } from './registration.token';
import { lastCompletionTokenFor } from './testing/register-test-user';

/**
 * DB-backed auth integration test.
 *
 * Exercises the Sprint 18 verification-first registration flow (request ->
 * emailed completion token -> complete) plus login/me against a live
 * PostgreSQL through the real Drizzle repositories, and asserts persistence
 * invariants the in-memory unit tests cannot: the pending registration stores
 * only an Argon2id password hash and a token hash, completion creates a
 * born-verified user, duplicate requests are enumeration-safe at the SQL
 * layer, and security events are durable and sanitized.
 *
 * Destructive (truncates auth tables), so it prefers `TEST_DATABASE_URL`. When
 * no database is reachable it SKIPS with a warning rather than passing silently.
 * Run via `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping auth.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('auth endpoints against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let mailer: InMemoryAccountMailer;

  const user = {
    email: 'Persist.User@Example.com',
    password: 'a-strong-password-123',
    displayName: 'Persist User',
  };
  const normalizedEmail = 'persist.user@example.com';

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    // Clean auth + organization state so the suite is deterministic and
    // re-runnable. The seeded `roles` baseline is preserved (not truncated).
    await db.sql.unsafe(
      'TRUNCATE pending_registrations, memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );

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
    const authService = createAuthService({
      repo: createDbAuthRepository(db.db),
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
      refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      registrationService,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('accepts a registration request and stages only a hashed pending row — no user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: user,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    // No token, user, session, or cookie on the request surface.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toContain('accessToken');

    const rawToken = lastCompletionTokenFor(mailer, user.email);
    expect(rawToken).toBeTruthy();

    const pending = await db.sql<
      { password_hash: string; token_hash: string }[]
    >`
      SELECT password_hash, token_hash FROM pending_registrations
      WHERE normalized_email = ${normalizedEmail}
    `;
    expect(pending).toHaveLength(1);
    const pendingRow = requireRow(pending, 'pending registration row');
    expect(pendingRow.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(pendingRow.password_hash).not.toContain(user.password);
    // The stored token hash is derived from — never equal to — the raw token.
    expect(pendingRow.token_hash).not.toBe(rawToken);
    expect(pendingRow.token_hash).toBe(
      hashRegistrationCompletionToken(rawToken as string),
    );

    const users = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE normalized_email = ${normalizedEmail}
    `;
    expect(users[0]?.count).toBe('0');
  });

  it('completing via the emailed token creates a verified user with only an Argon2id hash', async () => {
    const rawToken = lastCompletionTokenFor(mailer, user.email);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/registration/complete',
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.user.id).toMatch(/^user_/);
    expect(response.json().data.tokens.accessToken).toBeTruthy();
    expect(response.headers['set-cookie']).toBeDefined();

    const rows = await db.sql<
      { password_hash: string; email_verified_at: Date | null }[]
    >`
      SELECT password_hash, email_verified_at FROM users
      WHERE normalized_email = ${normalizedEmail}
    `;
    expect(rows).toHaveLength(1);
    const userRow = requireRow(rows, 'created user row');
    // Verification-first accounts are born verified.
    expect(userRow.email_verified_at).not.toBeNull();
    expect(userRow.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(userRow.password_hash).not.toContain(user.password);
  });

  it('writes durable, sanitized, ANONYMOUS registration-request events', async () => {
    const requested = await db.sql<
      {
        user_id: string | null;
        request_id: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      SELECT user_id, request_id, metadata FROM security_events
      WHERE event_type = 'auth.registration_requested'
    `;
    expect(requested.length).toBeGreaterThanOrEqual(1);
    for (const event of requested) {
      // Submitting an email to a public endpoint authenticates nobody.
      expect(event.user_id).toBeNull();
      expect(JSON.stringify(event.metadata)).not.toContain(user.password);
    }
    expect(requested[0]?.request_id).toMatch(/^req_/);

    const completed = await db.sql<{ user_id: string | null }[]>`
      SELECT user_id FROM security_events
      WHERE event_type = 'auth.registration_completion_succeeded'
    `;
    expect(completed).toHaveLength(1);
    expect(completed[0]?.user_id).toMatch(/^user_/);

    // The retired Sprint 17 event names are gone.
    const retired = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE event_type IN ('auth.registration_succeeded', 'auth.registration_duplicate_email')
    `;
    expect(retired[0]?.count).toBe('0');
  });

  it('a duplicate request returns the identical accepted body and stages nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...user, email: '  PERSIST.USER@example.com ' },
    });
    // Enumeration-safe: indistinguishable from a fresh registration request.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });

    const users = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE normalized_email = ${normalizedEmail}
    `;
    expect(users[0]?.count).toBe('1');

    // No new usable pending registration was staged for the taken email.
    const pending = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pending_registrations
      WHERE normalized_email = ${normalizedEmail}
        AND used_at IS NULL AND invalidated_at IS NULL
    `;
    expect(pending[0]?.count).toBe('0');
  });

  it('logs in and resolves the current user, never exposing the hash', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: normalizedEmail, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().data.tokens.accessToken;

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.email).toBe(user.email);
    expect(JSON.stringify(me.json())).not.toContain('passwordHash');
  });

  it('returns a generic error and records a failed-login event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: normalizedEmail, password: 'wrong-password-value' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');

    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events WHERE event_type = 'auth.login_failed'
    `;
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('persists a durable, sanitized access_token_rejected event', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: 'Bearer not.a.valid.jwt',
        'x-request-id': 'req_integration_reject',
      },
    });
    expect(response.statusCode).toBe(401);

    const rows = await db.sql<
      {
        user_id: string | null;
        session_id: string | null;
        request_id: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      SELECT user_id, session_id, request_id, metadata FROM security_events
      WHERE event_type = 'auth.access_token_rejected'
        AND request_id = 'req_integration_reject'
    `;
    expect(rows).toHaveLength(1);
    const eventRow = requireRow(rows, 'access_token_rejected event');
    expect(eventRow.user_id).toBeNull();
    expect(eventRow.session_id).toBeNull();
    expect(JSON.stringify(eventRow.metadata)).not.toContain('not.a.valid.jwt');
  });
});
