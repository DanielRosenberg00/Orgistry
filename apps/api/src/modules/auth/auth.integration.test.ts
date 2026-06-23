import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from './auth.service';
import { createDbAuthRepository } from './auth.repo';

/**
 * DB-backed auth integration test.
 *
 * Exercises register/login/me against a live PostgreSQL through the real
 * Drizzle repository, and asserts persistence invariants the in-memory unit
 * tests cannot: password stored as an Argon2id hash, durable + sanitized
 * security events, and the normalized-email uniqueness constraint.
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

  const user = {
    email: 'Persist.User@Example.com',
    password: 'a-strong-password-123',
    displayName: 'Persist User',
  };
  const normalizedEmail = 'persist.user@example.com';

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    // Clean auth state so the suite is deterministic and re-runnable.
    await db.sql.unsafe(
      'TRUNCATE security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );

    const authService = createAuthService({
      repo: createDbAuthRepository(db.db),
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
    });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('registers a user and persists only an Argon2id hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: user,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.user.id).toMatch(/^user_/);

    const rows = await db.sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE normalized_email = ${normalizedEmail}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0].password_hash).not.toContain(user.password);
  });

  it('writes a durable, sanitized registration security event', async () => {
    const rows = await db.sql<
      { request_id: string | null; metadata: Record<string, unknown> }[]
    >`
      SELECT request_id, metadata FROM security_events
      WHERE event_type = 'auth.registration_succeeded'
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].request_id).toMatch(/^req_/);
    expect(JSON.stringify(rows[0].metadata)).not.toContain(user.password);
  });

  it('rejects a duplicate normalized email at the database constraint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...user, email: '  PERSIST.USER@example.com ' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');

    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE normalized_email = ${normalizedEmail}
    `;
    expect(rows[0].count).toBe('1');
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
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
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
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].session_id).toBeNull();
    expect(JSON.stringify(rows[0].metadata)).not.toContain('not.a.valid.jwt');
  });
});
