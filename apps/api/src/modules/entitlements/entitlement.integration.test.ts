import { createDbClient, runMigrations } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import { passingProbe, testConfig } from '../../testing/build-test-app';
import { createAuthService } from '../auth/auth.service';
import { createDbAuthRepository } from '../auth/auth.repo';
import { createOrganizationService } from '../organization/organization.service';
import { createDbOrganizationRepository } from '../organization/organization.repo';
import { createProjectService } from '../projects/project.service';
import { createDbProjectRepository } from '../projects/project.repo';
import { createEntitlementService } from './entitlement.service';
import { createDbEntitlementRepository } from './plan.repo';
import { createPlanService } from './plan.service';

/**
 * DB-backed entitlements/plan integration test.
 *
 * Proves against live PostgreSQL what the in-memory route tests cannot: every
 * new organization is provisioned with default (Free) plan state, the demo plan
 * change persists and records `plan.changed_demo` on the event seam, and the
 * `max_projects` quota is enforced against real row counts.
 *
 * Skips (with a warning) when no database is reachable. Run via
 * `pnpm test:integration` with infrastructure up.
 */
loadWorkspaceEnv();

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[api] Skipping entitlement.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('entitlements against live PostgreSQL', () => {
  const config = testConfig();
  let db: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let emailSeq = 0;

  function authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function registerUser(): Promise<{ token: string; userId: string }> {
    emailSeq += 1;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `plan.int.${emailSeq}@example.com`,
        password: 'a-strong-password-123',
        displayName: 'Plan Int',
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

  beforeAll(async () => {
    await runMigrations(connectionString as string);
    db = createDbClient(connectionString as string);
    const orgRepo = createDbOrganizationRepository(db.db);
    const entitlementService = createEntitlementService({
      repo: createDbEntitlementRepository(db.db),
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
      organizationService: createOrganizationService({ repo: orgRepo }),
      projectService: createProjectService({
        accessControl: orgRepo,
        projects: createDbProjectRepository(db.db),
        entitlements: entitlementService,
      }),
      planService: createPlanService({
        accessControl: orgRepo,
        entitlements: entitlementService,
      }),
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('provisions every new organization with default Free plan state', async () => {
    const owner = await registerUser();
    // Personal workspace (provisioned at registration).
    const orgs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: authHeader(owner.token),
    });
    const personalOrgId = orgs.json().data.items[0].organization.id;
    // Team org (provisioned explicitly).
    const teamOrgId = await createTeamOrg(owner.token, 'Acme');

    for (const orgId of [personalOrgId, teamOrgId]) {
      const plan = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/plan`,
        headers: authHeader(owner.token),
      });
      expect(plan.statusCode).toBe(200);
      expect(plan.json().data.plan.key).toBe('free');

      // The row really exists in organization_plans (one per org).
      const rows = await db.sql<{ plan_key: string }[]>`
        SELECT plan_key FROM organization_plans WHERE organization_id = ${orgId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].plan_key).toBe('free');
    }
  });

  it('persists a demo plan change and records plan.changed_demo', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');

    const change = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(owner.token),
      payload: { planKey: 'pro' },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().data.plan.key).toBe('pro');

    const rows = await db.sql<{ plan_key: string }[]>`
      SELECT plan_key FROM organization_plans WHERE organization_id = ${orgId}`;
    expect(rows[0].plan_key).toBe('pro');

    const events = await db.sql<{ event_type: string; metadata: unknown }[]>`
      SELECT event_type, metadata FROM security_events
      WHERE organization_id = ${orgId} AND event_type = 'plan.changed_demo'`;
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      previousPlanKey: 'free',
      newPlanKey: 'pro',
    });
  });

  it('enforces max_projects against real row counts and frees quota on delete', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme'); // Free: max_projects = 3

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/projects`,
        headers: authHeader(owner.token),
        payload: { name: `P${i}` },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().data.project.id);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: 'Overflow' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('QUOTA_EXCEEDED');

    // No fourth project row was written.
    const count = await db.sql<{ value: number }[]>`
      SELECT count(*)::int AS value FROM projects
      WHERE organization_id = ${orgId} AND deleted_at IS NULL`;
    expect(count[0].value).toBe(3);

    // Soft-deleting one frees a slot.
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${ids[0]}`,
      headers: authHeader(owner.token),
    });
    const refill = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/projects`,
      headers: authHeader(owner.token),
      payload: { name: 'Refilled' },
    });
    expect(refill.statusCode).toBe(201);
  });
});
