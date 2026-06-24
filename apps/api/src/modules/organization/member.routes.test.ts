import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MEMBER_EVENT_TYPES } from './member.events';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from './testing/build-organization-test-app';

/**
 * End-to-end member-management & effective-permission route behavior, exercised
 * through `app.inject` over the in-memory store. Covers authentication,
 * membership + permission gating, cross-organization isolation, the Last Owner
 * invariant, soft removal, and the audit seam.
 */
let ctx: OrganizationTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Member User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `member.user.${emailSeq}@example.com`,
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

/** Directly seed an active membership (no invite flow exists in Sprint 5). */
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

/** Find the active owner membership id for an org (created with the team org). */
function ownerMembershipId(organizationId: string, userId: string): string {
  const membership = ctx.orgStore.memberships.find(
    (m) =>
      m.organizationId === organizationId &&
      m.userId === userId &&
      m.status === 'active',
  );
  if (!membership) {
    throw new Error('owner membership not found');
  }
  return membership.id;
}

beforeEach(async () => {
  ctx = await buildOrganizationTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/organizations/:id/members (member listing)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (cross-org fails)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(stranger.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires members.read — a Viewer is forbidden', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('returns only the requested org\'s members, excludes removed, leaks no internals', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const removed = await registerUser('Removed');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const removedMemId = addMembership(orgId, removed.userId, ROLE_IDS.viewer);
    ctx.orgStore.memberships.find((m) => m.id === removedMemId)!.status = 'removed';

    // A separate org whose members must NOT appear here.
    const other = await registerUser('Other');
    await createTeamOrg(other.token, 'Other Org');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items as Array<{
      user: { id: string; email: string };
      role: { key: string };
      status: string;
    }>;
    const userIds = items.map((i) => i.user.id);
    expect(userIds).toContain(owner.userId);
    expect(userIds).toContain(member.userId);
    expect(userIds).not.toContain(removed.userId); // removed excluded
    expect(userIds).not.toContain(other.userId); // other org excluded

    // No auth/session internals leak through the member DTO.
    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('normalizedEmail');
  });
});

describe('PATCH /v1/organizations/:id/members/:membershipId/role (role change)', () => {
  it('requires members.change_role (a Member is forbidden)', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${targetMem}/role`,
      headers: authHeader(member.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects an invalid (non-fixed) role with a validation error', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${targetMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'superadmin' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404s when the target membership belongs to another organization', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    const otherMem = ownerMembershipId(otherOrgId, other.userId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${otherMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('allows a valid role change by an owner', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${targetMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.member.role.key).toBe('admin');
    // The change is recorded on the audit seam.
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === MEMBER_EVENT_TYPES.memberRoleChanged,
      ),
    ).toBe(true);
  });

  it('prevents demoting the last active Owner (self-demotion)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const ownerMem = ownerMembershipId(orgId, owner.userId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${ownerMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OWNER_REQUIRED');
  });

  it('allows demoting an Owner when another active Owner exists', async () => {
    const owner = await registerUser('Owner');
    const second = await registerUser('Second Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, second.userId, ROLE_IDS.owner);
    const ownerMem = ownerMembershipId(orgId, owner.userId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${ownerMem}/role`,
      headers: authHeader(owner.token),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.member.role.key).toBe('admin');
  });
});

describe('DELETE /v1/organizations/:id/members/:membershipId (removal)', () => {
  it('requires members.remove (a Member is forbidden)', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.viewer);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('soft-removes a member, sets removal markers, and records an audit event', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.member);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.member.status).toBe('removed');
    expect(response.json().data.member.removedAt).not.toBeNull();

    const stored = ctx.orgStore.memberships.find((m) => m.id === targetMem)!;
    expect(stored.status).toBe('removed');
    expect(stored.removedAt).not.toBeNull();
    expect(stored.removedByUserId).toBe(owner.userId);
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === MEMBER_EVENT_TYPES.memberRemoved,
      ),
    ).toBe(true);
  });

  it('handles an already-removed membership idempotently', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.member);

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(owner.token),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(owner.token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.member.status).toBe('removed');
  });

  it('prevents removing the last active Owner', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const ownerMem = ownerMembershipId(orgId, owner.userId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${ownerMem}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OWNER_REQUIRED');
  });

  it('allows removing an Owner when another active Owner exists', async () => {
    const owner = await registerUser('Owner');
    const second = await registerUser('Second Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const secondMem = addMembership(orgId, second.userId, ROLE_IDS.owner);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${secondMem}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
  });

  it('a removed member no longer has access', async () => {
    const owner = await registerUser('Owner');
    const target = await registerUser('Target');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const targetMem = addMembership(orgId, target.userId, ROLE_IDS.member);

    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${targetMem}`,
      headers: authHeader(owner.token),
    });

    // The removed user can no longer list members or read their effective
    // permissions there — every organization-scoped surface rejects them.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: authHeader(target.token),
    });
    expect(members.statusCode).toBe(404);

    const effective = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/permissions/effective`,
      headers: authHeader(target.token),
    });
    expect(effective.statusCode).toBe(404);
  });
});
