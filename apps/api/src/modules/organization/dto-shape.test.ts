import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from './testing/build-organization-test-app';

/**
 * Focused DTO + envelope shape tests. Proves the public contracts never leak
 * persistence/auth internals, the stable identifiers are what the contract
 * promises, the standard success/error envelopes are used (with requestId on
 * errors), and cross-organization mutations do not leak target existence.
 */
let ctx: OrganizationTestContext;
let app: FastifyInstance;
let emailSeq = 0;

const FORBIDDEN_FIELDS = [
  'passwordHash',
  'password_hash',
  'normalizedEmail',
  'normalized_email',
  'emailVerifiedAt',
  'email_verified_at',
  'deletedAt',
  'deleted_at',
  'tokenHash',
  'refresh',
  'sessionId',
  'perm_',
];

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Shape User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `shape.user.${emailSeq}@example.com`,
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

function addMembership(organizationId: string, userId: string, roleId: string): string {
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

describe('Member DTO shape', () => {
  it('exposes only public fields and no auth/session internals', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);

    const raw = JSON.stringify(response.json());
    for (const field of FORBIDDEN_FIELDS) {
      expect(raw).not.toContain(field);
    }

    const item = response.json().data.items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['createdAt', 'id', 'joinedAt', 'removedAt', 'role', 'status', 'user'].sort(),
    );
    expect(Object.keys(item.user).sort()).toEqual(['displayName', 'email', 'id'].sort());
    expect(Object.keys(item.role).sort()).toEqual(['id', 'key', 'name'].sort());
  });
});

describe('Role & Permission DTO shape', () => {
  it('Role DTO exposes exactly { id, key, name, description }', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/roles`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    for (const role of response.json().data.items) {
      expect(Object.keys(role).sort()).toEqual(
        ['description', 'id', 'key', 'name'].sort(),
      );
    }
  });

  it('Permission DTO exposes the key (not the internal perm_ id)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    for (const permission of response.json().data.items) {
      expect(Object.keys(permission).sort()).toEqual(
        ['description', 'key', 'name'].sort(),
      );
      expect(permission.id).toBeUndefined();
    }
  });
});

describe('Envelopes', () => {
  it('uses the standard success envelope', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(owner.token),
    });
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  it('uses the standard error envelope with a requestId', async () => {
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
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBeTruthy();
    expect(body.error.requestId).toBeTruthy();
    expect(body.data).toBeUndefined();
  });
});

describe('Cross-organization mutation does not leak target existence', () => {
  it('returns the same MEMBER_NOT_FOUND for a foreign membership and a nonexistent one', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    // A membership that genuinely exists, but in a DIFFERENT organization.
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    const foreignMem = ctx.orgStore.memberships.find(
      (m) => m.organizationId === otherOrgId && m.userId === other.userId,
    )!.id;

    const foreign = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${foreignMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    const missing = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/mem_does_not_exist/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });

    // Identical response — the caller cannot distinguish "exists elsewhere" from
    // "does not exist".
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('MEMBER_NOT_FOUND');
    expect(missing.json().error.code).toBe('MEMBER_NOT_FOUND');
  });
});
