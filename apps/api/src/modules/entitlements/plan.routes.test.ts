import { PLAN_CATALOG } from '@orgistry/contracts';
import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildEntitlementsTestApp,
  type EntitlementsTestContext,
} from './testing/build-entitlements-test-app';

/**
 * End-to-end plan & entitlements route behavior, exercised through `app.inject`
 * over the shared in-memory store:
 *   GET   …/plan          (plan.read)
 *   GET   …/entitlements  (plan.read)
 *   PATCH …/plan/demo     (plan.change_demo)
 *
 * Every assertion proves BACKEND enforcement and the Sprint 7 separation:
 * permission (RBAC) is distinct from entitlement/quota (plan). There is no UI to
 * hide behind, and no billing is ever invoked.
 */
let ctx: EntitlementsTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Plan User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `plan.user.${emailSeq}@example.com`,
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

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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

/** List the caller's organizations and return the first (personal) org id. */
async function firstOrganizationId(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/organizations',
    headers: authHeader(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.items[0].organization.id;
}

/** Directly seed an active membership (no invite flow exists yet). */
function addMembership(
  organizationId: string,
  userId: string,
  roleId: string,
): string {
  const now = new Date();
  const id = createId('mem');
  ctx.orgStore.memberships.push({
    id,
    userId,
    organizationId,
    roleId,
    status: 'active',
    invitedByUserId: null,
    joinedAt: now,
    removedAt: null,
    removedByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

beforeEach(async () => {
  ctx = await buildEntitlementsTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/organizations/:id/plan', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/plan`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (a stranger gets a uniform 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/plan`,
      headers: authHeader(stranger.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('returns the default Free plan for a new TEAM organization', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/plan`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.organizationId).toBe(orgId);
    expect(data.plan).toEqual({
      key: 'free',
      name: 'Free',
      description: PLAN_CATALOG.free.description,
    });
    expect(data.assignedAt).toBeTypeOf('string');
    expect(data.updatedAt).toBeTypeOf('string');
  });

  it('returns the default Free plan for a new PERSONAL organization (from registration)', async () => {
    const owner = await registerUser('Owner');
    const personalOrgId = await firstOrganizationId(owner.token);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${personalOrgId}/plan`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plan.key).toBe('free');
  });

  it('does not expose internal plan storage rows or any billing field', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/plan`,
      headers: authHeader(owner.token),
    });
    const data = response.json().data;
    // The plan DTO is key/name/description only; no row id, no raw quota columns.
    expect(Object.keys(data.plan).sort()).toEqual(
      ['description', 'key', 'name'].sort(),
    );
    expect('id' in data.plan).toBe(false);
    // No billing provider state anywhere in the response.
    expect(JSON.stringify(data).toLowerCase()).not.toContain('stripe');
    expect(JSON.stringify(data).toLowerCase()).not.toContain('subscription');
  });

  it('lets a Viewer (who holds plan.read) read the plan', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/plan`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /v1/organizations/:id/entitlements', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/entitlements`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (a stranger gets a uniform 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/entitlements`,
      headers: authHeader(stranger.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns the full resolved entitlement set for the Free default plan', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/entitlements`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.organizationId).toBe(orgId);
    expect(data.planKey).toBe('free');
    // Includes all six required entitlement keys with the Free plan values.
    expect(Object.keys(data.entitlements).sort()).toEqual(
      [
        'api_keys_access',
        'audit_log_access',
        'audit_retention_days',
        'max_api_keys',
        'max_members',
        'max_projects',
      ].sort(),
    );
    expect(data.entitlements).toEqual(PLAN_CATALOG.free.entitlements);
  });

  it('does not require a specific role name — a Member sees entitlements too', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/entitlements`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('PATCH /v1/organizations/:id/plan/demo', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      payload: { planKey: 'pro' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (a stranger gets a uniform 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(stranger.token),
      payload: { planKey: 'pro' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lets an Owner (plan.change_demo) switch the plan, returns new entitlements, and records plan.changed_demo', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(owner.token),
      payload: { planKey: 'business' },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.plan.key).toBe('business');
    expect(data.entitlements).toEqual(PLAN_CATALOG.business.entitlements);

    // The action event is recorded on the internal event seam (no read API).
    const events = ctx.orgStore.securityEvents.filter(
      (e) => e.eventType === 'plan.changed_demo',
    );
    expect(events).toHaveLength(1);
    expect(events[0].organizationId).toBe(orgId);
    expect(events[0].metadata).toMatchObject({
      previousPlanKey: 'free',
      newPlanKey: 'business',
    });

    // A subsequent read reflects the new plan.
    const after = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/entitlements`,
      headers: authHeader(owner.token),
    });
    expect(after.json().data.planKey).toBe('business');
  });

  it('rejects an invalid target plan key with a validation error and no change', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(owner.token),
      payload: { planKey: 'enterprise' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    // No plan-change event was recorded.
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === 'plan.changed_demo',
      ),
    ).toBe(false);
  });

  it('forbids a Member: plan.read does NOT imply plan.change_demo (permission separation)', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(member.token),
      payload: { planKey: 'pro' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('forbids a Viewer from changing the plan', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/plan/demo`,
      headers: authHeader(viewer.token),
      payload: { planKey: 'pro' },
    });
    expect(response.statusCode).toBe(403);
  });
});
