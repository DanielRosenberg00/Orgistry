import { PERMISSION_KEYS, ROLE_PERMISSIONS } from '@orgistry/contracts';
import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from './testing/build-organization-test-app';

/**
 * Organization-scoped, permission-enforced RBAC read routes:
 *   GET …/roles                  (roles.read)
 *   GET …/permissions            (permissions.read)
 *   GET …/permissions/matrix     (permissions.read)
 *   GET …/permissions/effective  (active membership only)
 *
 * These prove enforcement: unauthenticated fails, removed membership fails,
 * cross-organization fails safely, a member WITH the permission succeeds, and a
 * caller WITHOUT it (Viewer, which lacks roles.read / permissions.read) is
 * forbidden.
 */
let ctx: OrganizationTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'RBAC User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `orgrbac.user.${emailSeq}@example.com`,
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

beforeEach(async () => {
  ctx = await buildOrganizationTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/organizations/:id/roles (roles.read enforced)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('fails safely on cross-organization access (non-member 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(stranger.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('rejects a removed membership (404)', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const memId = addMembership(orgId, member.userId, ROLE_IDS.member);
    ctx.orgStore.memberships.find((m) => m.id === memId)!.status = 'removed';

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it('allows a Member (has roles.read) and returns the four fixed roles', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items.map((r: { key: string }) => r.key)).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
    ]);
  });

  it('forbids a Viewer (lacks roles.read) with the standard 403', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(response.json().error.requestId).toBeTruthy();
  });
});

describe('GET /v1/organizations/:id/permissions (permissions.read enforced)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows a Member and returns the fixed permission catalog (no perm_ ids)', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(23);
    // The stable public identifier is the key; the internal perm_ id is hidden.
    for (const item of items) {
      expect(item.id).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain('perm_');
    }
  });

  it('forbids a Viewer (lacks permissions.read)', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /v1/organizations/:id/permissions/matrix (permissions.read enforced)', () => {
  it('allows a Member and matches the seeded mapping', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/matrix`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect([...body.matrix[role]].sort()).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      );
    }
  });

  it('forbids a Viewer (lacks permissions.read)', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/matrix`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /v1/organizations/:id/permissions/effective (membership only)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the caller\'s own effective permissions as keys (DTOs, not rows)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.organizationId).toBe(orgId);
    expect(body.role.key).toBe('owner');
    expect(body.permissions).toContain(PERMISSION_KEYS.membersRemove);
    expect(JSON.stringify(body)).not.toContain('perm_');
  });

  it('is available to a Viewer (no permission gate — it is their own set)', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/permissions/effective`,
        headers: authHeader(viewer.token),
      })
    ).json().data;
    expect(body.role.key).toBe('viewer');
    expect(body.permissions).toContain(PERMISSION_KEYS.orgRead);
    expect(body.permissions).not.toContain(PERMISSION_KEYS.rolesRead);
  });

  it('ignores a removed membership and fails safely cross-org', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const memId = addMembership(orgId, member.userId, ROLE_IDS.member);
    ctx.orgStore.memberships.find((m) => m.id === memId)!.status = 'removed';

    const removed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
      headers: authHeader(member.token),
    });
    expect(removed.statusCode).toBe(404);

    const cross = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
      headers: authHeader(stranger.token),
    });
    expect(cross.statusCode).toBe(404);
  });
});
