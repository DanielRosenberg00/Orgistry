import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { createId } from '@orgistry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import type { RegisterAccountParams } from '../auth/auth.types';
import { createOrganizationService } from './organization.service';
import { createDbOrganizationRepository } from './organization.repo';

/**
 * DB-backed organization foundation integration test.
 *
 * Exercises registration-provisioned personal workspaces, team creation,
 * list/read scoping, and the persistence invariants the in-memory unit tests
 * cannot prove against a live PostgreSQL: transactional registration rollback,
 * the one-active-membership-per-(user,org) partial unique index, and
 * membership-scoped visibility.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping organization.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('organization foundation against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let authRepo: ReturnType<typeof createDbAuthRepository>;
  let app: FastifyInstance;
  let emailSeq = 0;

  function authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function registerUser(displayName = 'Test User'): Promise<{
    token: string;
    userId: string;
    email: string;
  }> {
    emailSeq += 1;
    const email = `org.user.${emailSeq}@example.com`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'a-strong-password-123', displayName },
    });
    expect(response.statusCode).toBe(201);
    return { token: response.json().data.tokens.accessToken, userId: response.json().data.user.id, email };
  }

  function createOrg(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: authHeader(token),
      payload,
    });
  }

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    authRepo = createDbAuthRepository(db.db);

    const authService = createAuthService({
      repo: authRepo,
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
      refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    });
    const organizationService = createOrganizationService({
      repo: createDbOrganizationRepository(db.db),
    });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      organizationService,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    // Truncate domain tables but PRESERVE the seeded `roles` baseline. CASCADE
    // from users also clears organizations/memberships/sessions/tokens.
    await db.sql.unsafe(
      'TRUNCATE memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  it('provisions a personal workspace + active Owner membership at registration', async () => {
    const { userId } = await registerUser('Ada Lovelace');

    const orgs = await db.sql<
      { id: string; type: string; status: string; created_by_user_id: string }[]
    >`SELECT id, type, status, created_by_user_id FROM organizations WHERE created_by_user_id = ${userId}`;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].type).toBe('personal');
    expect(orgs[0].status).toBe('active');

    const memberships = await db.sql<
      { status: string; role_id: string; organization_id: string }[]
    >`SELECT status, role_id, organization_id FROM memberships WHERE user_id = ${userId}`;
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe('active');
    expect(memberships[0].role_id).toBe('role_owner');
    expect(memberships[0].organization_id).toBe(orgs[0].id);
  });

  it('rolls registration back atomically when a later step fails', async () => {
    const sharedTokenHash = `dup_${createId('rtok')}`;
    const params = (email: string, slugBase: string): RegisterAccountParams => ({
      user: {
        email,
        normalizedEmail: email,
        passwordHash: 'not-a-real-hash',
        displayName: 'Atomic',
      },
      personalWorkspace: { name: 'Atomic Workspace', slugBase },
      session: {
        ipAddress: null,
        userAgent: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      refreshToken: {
        tokenHash: sharedTokenHash,
        familyId: createId('rtok'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // First registration succeeds and claims the shared refresh-token hash.
    await authRepo.registerAccount(params('atomic.a@example.com', 'atomic-a'));
    // Second reuses the hash -> the refresh-token insert violates the unique
    // index AFTER the user/org/membership inserts, forcing a full rollback.
    await expect(
      authRepo.registerAccount(params('atomic.b@example.com', 'atomic-b')),
    ).rejects.toThrow();

    const users = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users`;
    const orgs = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM organizations`;
    const memberships = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships`;
    // Only the first account exists; the second left no partial state — its
    // user, organization, and membership inserts were all rolled back even
    // though they succeeded before the failing refresh-token insert.
    expect(users[0].count).toBe('1');
    expect(orgs[0].count).toBe('1');
    expect(memberships[0].count).toBe('1');

    const rolledBack = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users
      WHERE normalized_email = 'atomic.b@example.com'`;
    expect(rolledBack[0].count).toBe('0');
  });

  it('creates a team organization with the creator as active Owner', async () => {
    const { token, userId } = await registerUser();
    const response = await createOrg(token, { name: 'Acme Inc' });
    expect(response.statusCode).toBe(201);
    const orgId = response.json().data.organization.id;
    expect(response.json().data.organization.type).toBe('team');

    const rows = await db.sql<{ status: string; role_id: string }[]>`
      SELECT status, role_id FROM memberships
      WHERE user_id = ${userId} AND organization_id = ${orgId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].role_id).toBe('role_owner');
  });

  it('enforces one active membership per (user, organization)', async () => {
    const { token, userId } = await registerUser();
    const orgId = (await createOrg(token, { name: 'Acme' })).json().data
      .organization.id;

    // A second ACTIVE membership for the same pair violates the partial unique
    // index.
    await expect(
      db.sql`
        INSERT INTO memberships (id, user_id, organization_id, role_id, status)
        VALUES (${createId('mem')}, ${userId}, ${orgId}, 'role_member', 'active')`,
    ).rejects.toThrow();

    // A removed membership for the same pair is allowed (history is retained).
    await expect(
      db.sql`
        INSERT INTO memberships (id, user_id, organization_id, role_id, status)
        VALUES (${createId('mem')}, ${userId}, ${orgId}, 'role_member', 'removed')`,
    ).resolves.toBeDefined();
  });

  it('lists and reads only organizations the user belongs to', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const aliceOrgId = (await createOrg(alice.token, { name: 'Alice Org' }))
      .json().data.organization.id;

    // Alice lists her personal workspace + the new team org.
    const aliceList = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: authHeader(alice.token),
    });
    expect(aliceList.json().data.items).toHaveLength(2);

    // Bob lists only his personal workspace and cannot see Alice's org.
    const bobList = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: authHeader(bob.token),
    });
    expect(bobList.json().data.items).toHaveLength(1);
    expect(JSON.stringify(bobList.json())).not.toContain('Alice Org');

    // Bob cannot read Alice's org -> indistinguishable 404.
    const bobRead = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${aliceOrgId}`,
      headers: authHeader(bob.token),
    });
    expect(bobRead.statusCode).toBe(404);
    expect(bobRead.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('treats a removed membership as no access', async () => {
    const { token, userId } = await registerUser();
    const orgId = (await createOrg(token, { name: 'Acme' })).json().data
      .organization.id;

    await db.sql`
      UPDATE memberships SET status = 'removed', removed_at = now()
      WHERE user_id = ${userId} AND organization_id = ${orgId}`;

    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}`,
      headers: authHeader(token),
    });
    expect(read.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: authHeader(token),
    });
    // Only the personal workspace remains visible.
    const names = list
      .json()
      .data.items.map((i: { organization: { name: string } }) => i.organization.name);
    expect(names).not.toContain('Acme');
  });

  it('rejects a duplicate explicit slug with a conflict', async () => {
    const { token } = await registerUser();
    await createOrg(token, { name: 'First', slug: 'taken-slug' });
    const conflict = await createOrg(token, { name: 'Second', slug: 'taken-slug' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('ORGANIZATION_SLUG_TAKEN');
  });
});
