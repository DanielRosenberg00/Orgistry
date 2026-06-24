import { createDbClient, ROLE_IDS, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { createId } from '@orgistry/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import { createRbacService } from '../rbac/rbac.service';
import { createDbRbacRepository } from '../rbac/rbac.repo';
import { createMemberService } from './member.service';
import { createOrganizationRbacService } from './org-rbac.service';
import { createOrganizationService } from './organization.service';
import { createDbOrganizationRepository } from './organization.repo';

/**
 * DB-backed member-management integration test.
 *
 * Proves the persistence invariants the in-memory unit tests cannot: the Last
 * Owner protection holds TRANSACTIONALLY (including under concurrency, where a
 * read-before-write pre-check would race), soft removal writes the lifecycle
 * markers, removed memberships lose access, and member-management actions are
 * recorded on the organization-scoped audit seam.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping member.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('member management against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let orgRepo: ReturnType<typeof createDbOrganizationRepository>;
  let app: FastifyInstance;
  let emailSeq = 0;

  function authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function registerUser(displayName = 'Test User'): Promise<{
    token: string;
    userId: string;
  }> {
    emailSeq += 1;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `member.int.${emailSeq}@example.com`,
        password: 'a-strong-password-123',
        displayName,
      },
    });
    expect(response.statusCode).toBe(201);
    return {
      token: response.json().data.tokens.accessToken,
      userId: response.json().data.user.id,
    };
  }

  async function createTeamOrg(token: string, name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: authHeader(token),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data.organization.id;
  }

  async function addMembership(
    organizationId: string,
    userId: string,
    roleId: string,
  ): Promise<string> {
    const id = createId('mem');
    await db.sql`
      INSERT INTO memberships (id, user_id, organization_id, role_id, status)
      VALUES (${id}, ${userId}, ${organizationId}, ${roleId}, 'active')`;
    return id;
  }

  async function ownerMembershipId(
    organizationId: string,
    userId: string,
  ): Promise<string> {
    const rows = await db.sql<{ id: string }[]>`
      SELECT id FROM memberships
      WHERE organization_id = ${organizationId} AND user_id = ${userId}
        AND status = 'active' LIMIT 1`;
    return rows[0].id;
  }

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    orgRepo = createDbOrganizationRepository(db.db);

    const authService = createAuthService({
      repo: createDbAuthRepository(db.db),
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
      refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    });
    const rbacService = createRbacService({ repo: createDbRbacRepository(db.db) });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      organizationService: createOrganizationService({ repo: orgRepo }),
      memberService: createMemberService({ repo: orgRepo }),
      organizationRbacService: createOrganizationRbacService({
        repo: orgRepo,
        rbacService,
      }),
      rbacService,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    // Truncate domain tables; PRESERVE the seeded roles/permissions baseline.
    await db.sql.unsafe(
      'TRUNCATE memberships, organizations, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  it('changes a member role and records an organization-scoped audit event', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = await addMembership(orgId, target.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${targetMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.sql<{ role_id: string }[]>`
      SELECT role_id FROM memberships WHERE id = ${targetMem}`;
    expect(rows[0].role_id).toBe(ROLE_IDS.admin);

    const events = await db.sql<{ event_type: string; organization_id: string }[]>`
      SELECT event_type, organization_id FROM security_events
      WHERE event_type = 'org.member_role_changed'`;
    expect(events).toHaveLength(1);
    expect(events[0].organization_id).toBe(orgId);
  });

  it('blocks demoting the last active Owner (transactional)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const ownerMem = await ownerMembershipId(orgId, owner.userId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${ownerMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OWNER_REQUIRED');

    // Still an active owner — the row was not changed.
    const owners = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE organization_id = ${orgId} AND status = 'active' AND role_id = ${ROLE_IDS.owner}`;
    expect(owners[0].count).toBe('1');
  });

  it('serializes concurrent owner demotions so exactly one Owner survives', async () => {
    const owner = await registerUser('Owner A');
    const second = await registerUser('Owner B');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const memA = await ownerMembershipId(orgId, owner.userId);
    const memB = await addMembership(orgId, second.userId, ROLE_IDS.owner);

    const ctx = { requestId: null, ipAddress: null, userAgent: null };
    // Fire both demotions concurrently. The active-owner set is locked FOR
    // UPDATE, so the two transactions serialize: one demotion succeeds and the
    // other sees a single remaining Owner and is rejected. A read-before-write
    // pre-check would let BOTH through.
    const results = await Promise.allSettled([
      orgRepo.changeMemberRole({
        organizationId: orgId,
        membershipId: memA,
        newRoleId: ROLE_IDS.admin,
        actorUserId: owner.userId,
        ctx,
      }),
      orgRepo.changeMemberRole({
        organizationId: orgId,
        membershipId: memB,
        newRoleId: ROLE_IDS.admin,
        actorUserId: second.userId,
        ctx,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const owners = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE organization_id = ${orgId} AND status = 'active' AND role_id = ${ROLE_IDS.owner}`;
    expect(owners[0].count).toBe('1');
  });

  it('soft-removes a member with lifecycle markers and keeps the row', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = await addMembership(orgId, target.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.sql<
      { status: string; removed_at: string | null; removed_by_user_id: string | null }[]
    >`SELECT status, removed_at, removed_by_user_id FROM memberships WHERE id = ${targetMem}`;
    expect(rows).toHaveLength(1); // not hard-deleted
    expect(rows[0].status).toBe('removed');
    expect(rows[0].removed_at).not.toBeNull();
    expect(rows[0].removed_by_user_id).toBe(owner.userId);

    // Removed member no longer has access to ANY organization-scoped surface:
    // effective permissions, member listing, and the org-scoped RBAC reads.
    const effective = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
      headers: authHeader(target.token),
    });
    expect(effective.statusCode).toBe(404);

    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(target.token),
    });
    expect(members.statusCode).toBe(404);

    const roles = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(target.token),
    });
    expect(roles.statusCode).toBe(404);
  });

  it('blocks removing the last active Owner (transactional)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const ownerMem = await ownerMembershipId(orgId, owner.userId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${ownerMem}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OWNER_REQUIRED');
  });

  it('lists only the org\'s active members with effective-permission-gated access', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const userIds = response
      .json()
      .data.items.map((i: { user: { id: string } }) => i.user.id);
    expect(userIds).toContain(owner.userId);
    expect(userIds).toContain(member.userId);
    expect(JSON.stringify(response.json())).not.toContain('passwordHash');
  });
});
