import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from './auth.service';
import { createDbAuthRepository } from './auth.repo';

/**
 * DB-backed secure session lifecycle test.
 *
 * Exercises refresh issuance, transactional rotation, and reuse detection
 * against a live PostgreSQL through the real Drizzle repository — covering the
 * persistence invariants the in-memory unit tests cannot: refresh tokens stored
 * hash-only, the atomic rotate-and-swap, and family/session revocation rows.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping session-lifecycle.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('session lifecycle against live PostgreSQL', () => {
  const config = testConfig();
  const cookieName = config.auth.refreshCookie.name;
  const csrfHeader = config.auth.csrfHeaderName;
  let db: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;

  const credentials = {
    email: 'Lifecycle.User@Example.com',
    password: 'a-strong-password-123',
    displayName: 'Lifecycle User',
  };

  function setCookie(response: LightMyRequestResponse): string {
    const raw = response.headers['set-cookie'];
    return Array.isArray(raw) ? raw[0] : (raw ?? '');
  }
  function cookieValue(response: LightMyRequestResponse): string {
    return new RegExp(`${cookieName}=([^;]*)`).exec(setCookie(response))?.[1] ?? '';
  }
  function register() {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: credentials,
    });
  }
  function refresh(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${cookieName}=${token}`, [csrfHeader]: '1' },
    });
  }

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);

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
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    // The seeded `roles` baseline is preserved (not truncated).
    await db.sql.unsafe(
      'TRUNCATE memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  it('persists the refresh token hash-only and never returns it in JSON', async () => {
    const response = await register();
    const raw = cookieValue(response);
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(response.json())).not.toContain(raw);

    const rows = await db.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM refresh_tokens
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(raw);
  });

  it('rotates transactionally: old token used, exactly one successor', async () => {
    const raw = cookieValue(await register());
    const rotated = await refresh(raw);
    expect(rotated.statusCode).toBe(200);

    const rows = await db.sql<{ used_at: Date | null; family_id: string }[]>`
      SELECT used_at, family_id FROM refresh_tokens ORDER BY created_at ASC
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].used_at).not.toBeNull(); // original consumed
    expect(rows[1].used_at).toBeNull(); // successor fresh
    expect(rows[0].family_id).toBe(rows[1].family_id); // same family
  });

  it('detects reuse and revokes the family + session', async () => {
    const raw = cookieValue(await register());
    await refresh(raw); // consume original
    const reuse = await refresh(raw); // present consumed token again

    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('TOKEN_REUSE_DETECTED');

    const tokens = await db.sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM refresh_tokens
    `;
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);

    const sessions = await db.sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM sessions
    `;
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);

    const events = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security_events
      WHERE event_type = 'auth.refresh_token_reuse_detected'
    `;
    expect(Number(events[0].count)).toBeGreaterThanOrEqual(1);
  });

  it('cannot mint two successors for concurrent refreshes of one token', async () => {
    const raw = cookieValue(await register());
    const [a, b] = await Promise.all([refresh(raw), refresh(raw)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);

    // The original + at most one successor: never two valid successors.
    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM refresh_tokens
    `;
    expect(Number(rows[0].count)).toBe(2);
  });
});
