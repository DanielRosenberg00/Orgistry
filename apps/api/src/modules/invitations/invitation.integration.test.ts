import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import { createOrganizationService } from '../organization/organization.service';
import { createDbOrganizationRepository } from '../organization/organization.repo';
import { createEntitlementService } from '../entitlements/entitlement.service';
import { createDbEntitlementRepository } from '../entitlements/plan.repo';
import { createInvitationService } from './invitation.service';
import { createDbInvitationRepository } from './invitation.repo';
import { createCapturingInvitationMailer } from './testing/in-memory-invitation-mailer';
import { INVITATION_EVENT_TYPES } from './invitation.events';

/**
 * DB-backed invitation integration test.
 *
 * Proves the persistence invariants the in-memory unit tests cannot: the
 * invitations table migrates from scratch, the token is stored hash-only (the
 * raw token never appears in any row), acceptance creates the membership and
 * marks the invitation accepted in one transaction, single-use holds, and
 * registration-with-invitation creates the personal workspace AND the invited
 * membership atomically against real PostgreSQL.
 *
 * A capturing mailer stands in for SMTP here (the live Mailpit SMTP path is
 * covered by the fake-SMTP unit test and the manual Mailpit run). Skips with a
 * warning when no database is reachable; run via `pnpm test:integration`.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping invitation.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('invitations against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let mailer: ReturnType<typeof createCapturingInvitationMailer>;
  let emailSeq = 0;

  function authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function registerUser(email?: string): Promise<{
    token: string;
    userId: string;
    email: string;
  }> {
    emailSeq += 1;
    const resolved = email ?? `inv.int.${emailSeq}@example.com`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: resolved,
        password: 'a-strong-password-123',
        displayName: 'Int User',
      },
    });
    expect(response.statusCode).toBe(201);
    return {
      token: response.json().data.tokens.accessToken,
      userId: response.json().data.user.id,
      email: resolved,
    };
  }

  async function createTeamOrg(token: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: authHeader(token),
      payload: { name: 'Acme Inc' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data.organization.id;
  }

  async function invite(
    token: string,
    orgId: string,
    email: string,
  ): Promise<{ id: string; rawToken: string }> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(token),
      payload: { email, role: 'member' },
    });
    expect(response.statusCode).toBe(201);
    const rawToken = mailer.lastToken();
    expect(rawToken).toBeTruthy();
    return { id: response.json().data.invitation.id, rawToken: rawToken as string };
  }

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    const orgRepo = createDbOrganizationRepository(db.db);
    const entitlements = createEntitlementService({
      repo: createDbEntitlementRepository(db.db),
    });
    mailer = createCapturingInvitationMailer();
    const invitationService = createInvitationService({
      accessControl: orgRepo,
      invitations: createDbInvitationRepository(db.db),
      entitlements,
      mailer,
      ttlSeconds: config.invitations.ttlSeconds,
      webBaseUrl: config.web.url,
    });
    const authService = createAuthService({
      repo: createDbAuthRepository(db.db),
      jwtSecret: config.auth.jwtSecret,
      accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
      refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
      invitations: invitationService,
    });
    app = buildApp({
      config,
      readinessProbes: [passingProbe('postgres')],
      authService,
      organizationService: createOrganizationService({ repo: orgRepo }),
      invitationService,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    mailer.messages.length = 0;
    await db.sql.unsafe(
      'TRUNCATE invitations, projects, memberships, organizations, organization_plans, security_events, email_verification_tokens, refresh_tokens, sessions, users RESTART IDENTITY CASCADE',
    );
  });

  it('stores the token hash-only and records invitation.created', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await invite(owner.token, orgId, 'invitee@example.com');

    const rows = await db.sql`SELECT * FROM invitations WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(rawToken);
    expect(rows[0].token_hash.length).toBeGreaterThan(0);
    expect(rows[0].status).toBe('pending');

    const events = await db.sql`
      SELECT metadata FROM security_events WHERE event_type = ${INVITATION_EVENT_TYPES.created}`;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].metadata)).not.toContain(rawToken);
    expect(JSON.stringify(events[0].metadata)).not.toContain(rows[0].token_hash);
  });

  it('accepts transactionally (membership + accepted) and is single-use', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await invite(owner.token, orgId, 'invitee@example.com');
    const invitee = await registerUser('invitee@example.com');

    const accept = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(accept.statusCode).toBe(200);

    const membership = await db.sql`
      SELECT * FROM memberships WHERE user_id = ${invitee.userId} AND organization_id = ${orgId}`;
    expect(membership).toHaveLength(1);
    expect(membership[0].status).toBe('active');

    const row = await db.sql`SELECT status FROM invitations WHERE id = ${id}`;
    expect(row[0].status).toBe('accepted');

    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('INVITATION_ALREADY_ACCEPTED');
  });

  it('registration-with-invitation creates personal workspace AND invited membership atomically', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await invite(owner.token, orgId, 'newbie@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'newbie@example.com',
        password: 'a-strong-password-123',
        displayName: 'Newbie',
        invitationToken: rawToken,
      },
    });
    expect(response.statusCode).toBe(201);
    const newUserId = response.json().data.user.id;

    // Personal (owner) workspace AND invited (member) membership both exist.
    const memberships = await db.sql`
      SELECT organization_id, role_id FROM memberships WHERE user_id = ${newUserId}`;
    expect(memberships.length).toBe(2);
    const invited = memberships.find((m) => m.organization_id === orgId);
    expect(invited?.role_id).toBe('role_member');

    const row = await db.sql`SELECT status FROM invitations WHERE id = ${id}`;
    expect(row[0].status).toBe('accepted');
  });
});
