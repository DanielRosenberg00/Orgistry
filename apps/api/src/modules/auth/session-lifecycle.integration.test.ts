import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../mail/testing/in-memory-account-mailer';
import { createAuthService } from './auth.service';
import { createDbAuthRepository } from './auth.repo';
import { createDbRegistrationRepository } from './registration.repo';
import { createRegistrationService } from './registration.service';
import { registerTestUser } from './testing/register-test-user';

/**
 * DB-backed secure session lifecycle test.
 *
 * Exercises refresh issuance, transactional rotation, and reuse detection
 * against a live PostgreSQL through the real Drizzle repository — covering the
 * persistence invariants the in-memory unit tests cannot: refresh tokens stored
 * hash-only, the atomic rotate-and-swap, and family/session revocation rows.
 * Users are created through the Sprint 18 two-step registration flow (request
 * -> emailed completion token -> complete); the first refresh token is issued
 * by the completion transaction.
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
  let mailer: InMemoryAccountMailer;

  const credentials = {
    email: 'Lifecycle.User@Example.com',
    password: 'a-strong-password-123',
    displayName: 'Lifecycle User',
  };

  function cookieValue(setCookie: string | string[] | undefined): string {
    const raw = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    return new RegExp(`${cookieName}=([^;]*)`).exec(raw)?.[1] ?? '';
  }
  /** Two-step registration; returns the raw refresh cookie + completion body. */
  async function register() {
    const result = await registerTestUser(app, mailer, credentials);
    return { raw: cookieValue(result.setCookie), completion: result.completion };
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

  beforeEach(async () => {
    // The seeded `roles` baseline is preserved (not truncated).
    await db.sql.unsafe(
      'TRUNCATE pending_registrations, memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
    mailer.messages.length = 0;
  });

  it('persists the refresh token hash-only and never returns it in JSON', async () => {
    const { raw, completion } = await register();
    expect(raw).not.toBe('');
    expect(JSON.stringify(completion)).not.toContain(raw);

    const rows = await db.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM refresh_tokens
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(raw);
  });

  it('rotates transactionally: old token used, exactly one successor', async () => {
    const { raw } = await register();
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
    const { raw } = await register();
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
    const { raw } = await register();
    const [a, b] = await Promise.all([refresh(raw), refresh(raw)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);

    // The original + at most one successor: never two valid successors.
    const rows = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM refresh_tokens
    `;
    expect(Number(rows[0].count)).toBe(2);
  });
});
