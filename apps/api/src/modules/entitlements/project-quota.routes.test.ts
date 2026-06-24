import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildEntitlementsTestApp,
  type EntitlementsTestContext,
} from './testing/build-entitlements-test-app';

/**
 * The primary end-to-end proof of Sprint 7: project creation enforces the
 * organization's `max_projects` quota AFTER the permission check, and the three
 * concepts stay separate.
 *
 *   Permission  — may the USER create a project?      (projects.create)
 *   Entitlement — does the plan allow projects at all? (here: always, count > 0)
 *   Quota       — does the plan still have ROOM?       (max_projects)
 *
 * Default plan is Free (max_projects = 3). All enforcement is server-side.
 */
let ctx: EntitlementsTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Quota User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `quota.user.${emailSeq}@example.com`,
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

function createProject(
  token: string,
  organizationId: string,
  name: string,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/projects`,
    headers: authHeader(token),
    payload: { name },
  });
}

async function changePlan(
  token: string,
  organizationId: string,
  planKey: string,
): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/v1/organizations/${organizationId}/plan/demo`,
    headers: authHeader(token),
    payload: { planKey },
  });
  expect(response.statusCode).toBe(200);
}

function projectCreatedEvents(organizationId: string): number {
  return ctx.orgStore.securityEvents.filter(
    (e) =>
      e.eventType === 'project.created' &&
      e.organizationId === organizationId,
  ).length;
}

function activeProjectCount(organizationId: string): number {
  return ctx.orgStore.projects.filter(
    (p) => p.organizationId === organizationId && p.deletedAt === null,
  ).length;
}

beforeEach(async () => {
  ctx = await buildEntitlementsTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('project creation under max_projects quota', () => {
  it('succeeds while the active project count is below the Free ceiling (3)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 3; i += 1) {
      expect((await createProject(owner.token, orgId, `P${i}`)).statusCode).toBe(
        201,
      );
    }
    expect(activeProjectCount(orgId)).toBe(3);
  });

  it('fails with QUOTA_EXCEEDED at the ceiling, creating no project and no project.created event', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 3; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }
    const eventsBefore = projectCreatedEvents(orgId);

    const blocked = await createProject(owner.token, orgId, 'Overflow');
    expect(blocked.statusCode).toBe(409);

    // Standard error envelope: { ok: false, error: { code, message, requestId, details } }.
    const body = blocked.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    // The requestId is echoed on the response header for correlation.
    expect(blocked.headers['x-request-id']).toBe(body.error.requestId);
    expect(body.error.details).toEqual({
      quota: 'max_projects',
      limit: 3,
      current: 3,
    });

    // No side effects: no fourth project, no extra action event.
    expect(activeProjectCount(orgId)).toBe(3);
    expect(projectCreatedEvents(orgId)).toBe(eventsBefore);
  });

  it('an upgraded plan raises the ceiling and re-allows creation', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 3; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }
    expect((await createProject(owner.token, orgId, 'Blocked')).statusCode).toBe(
      409,
    );

    // Upgrade Free → Pro (max_projects = 20) via the demo endpoint.
    await changePlan(owner.token, orgId, 'pro');
    expect((await createProject(owner.token, orgId, 'NowAllowed')).statusCode).toBe(
      201,
    );
    expect(activeProjectCount(orgId)).toBe(4);
  });

  it('deleting a project frees quota (soft-deleted projects do not count)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await createProject(owner.token, orgId, `P${i}`);
      ids.push(res.json().data.project.id);
    }
    expect((await createProject(owner.token, orgId, 'Blocked')).statusCode).toBe(
      409,
    );

    // Soft-delete one; the active count drops to 2 and a creation fits again.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${ids[0]}`,
      headers: authHeader(owner.token),
    });
    expect(del.statusCode).toBe(200);
    expect((await createProject(owner.token, orgId, 'Refilled')).statusCode).toBe(
      201,
    );
    expect(activeProjectCount(orgId)).toBe(3);
  });
});

describe('permission vs quota separation', () => {
  it('a Viewer is blocked by PERMISSION even when quota has room', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    // Quota is wide open (0 of 3 used), but the Viewer lacks projects.create.
    const response = await createProject(viewer.token, orgId, 'Nope');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(activeProjectCount(orgId)).toBe(0);
  });

  it('having the permission does NOT bypass quota (Owner is still quota-blocked at the ceiling)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    for (let i = 0; i < 3; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }
    const response = await createProject(owner.token, orgId, 'OverLimit');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('plan capacity does NOT grant user permission (a Viewer on Business still cannot create)', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    // The plan has plenty of project quota (Business: 100), but entitlement is
    // an ORGANIZATION capability — it never confers a USER permission.
    await changePlan(owner.token, orgId, 'business');
    const response = await createProject(viewer.token, orgId, 'StillNope');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
});
