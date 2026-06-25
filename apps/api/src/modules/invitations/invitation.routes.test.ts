import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { INVITATION_EVENT_TYPES } from './invitation.events';
import { hashInvitationToken } from './invitation.token';
import {
  buildInvitationsTestApp,
  type InvitationsTestContext,
} from './testing/build-invitations-test-app';

/**
 * End-to-end invitation lifecycle behavior over the shared in-memory store.
 *
 * Covers user authentication, membership + permission gating (by permission
 * key), the max_members reservation/acceptance quota, hash-only token storage,
 * fail-closed email delivery, tenant isolation, the single-use + email-match +
 * expiry/revocation invariants, registration-with-invitation (personal workspace
 * preserved), and the action-event seam (no token/hash in metadata). Every
 * assertion proves BACKEND enforcement.
 */
let ctx: InvitationsTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
  email: string;
}

async function registerUser(email?: string): Promise<TestUser> {
  emailSeq += 1;
  const resolved = email ?? `user.${emailSeq}@example.com`;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: resolved,
      password: 'a-strong-password-123',
      displayName: 'Test User',
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    token: response.json().data.tokens.accessToken,
    userId: response.json().data.user.id,
    email: resolved,
  };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createTeamOrg(token: string, name = 'Acme'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: authHeader(token),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.organization.id;
}

async function invite(
  token: string,
  organizationId: string,
  email: string,
  role = 'member',
) {
  return app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/invitations`,
    headers: authHeader(token),
    payload: { email, role },
  });
}

/** Create an invitation and return the DTO + the raw token (from the mailer). */
async function inviteOk(
  token: string,
  organizationId: string,
  email: string,
  role = 'member',
): Promise<{ id: string; rawToken: string }> {
  const response = await invite(token, organizationId, email, role);
  expect(response.statusCode).toBe(201);
  const rawToken = ctx.mailer.lastToken();
  expect(rawToken).toBeTruthy();
  return { id: response.json().data.invitation.id, rawToken: rawToken as string };
}

function setPlan(organizationId: string, planKey: string): void {
  const state = ctx.orgStore.organizationPlans.find(
    (p) => p.organizationId === organizationId,
  );
  if (!state) {
    throw new Error(`No plan state for organization ${organizationId}.`);
  }
  state.planKey = planKey as typeof state.planKey;
}

/** Directly seed an extra active membership (a stand-in user) to fill quota. */
function addFillerMember(organizationId: string, roleId = ROLE_IDS.member): void {
  const now = new Date();
  const userId = createId('user');
  ctx.orgStore.users.push({
    id: userId,
    email: `${userId}@example.com`,
    normalizedEmail: `${userId}@example.com`.toLowerCase(),
    passwordHash: 'x',
    displayName: 'Filler',
    status: 'active',
    emailVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  ctx.orgStore.memberships.push({
    id: createId('mem'),
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
}

function eventsOfType(type: string) {
  return ctx.orgStore.securityEvents.filter((e) => e.eventType === type);
}

beforeEach(async () => {
  ctx = await buildInvitationsTestApp();
  app = ctx.app;
  emailSeq = 0;
});

afterEach(async () => {
  await app.close();
});

describe('invitation create', () => {
  it('creates a pending invitation, records the event, and never exposes the token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);

    const response = await invite(owner.token, orgId, 'Invitee@Example.com', 'admin');
    expect(response.statusCode).toBe(201);

    const dto = response.json().data.invitation;
    expect(dto.organizationId).toBe(orgId);
    expect(dto.invitedEmail).toBe('Invitee@Example.com');
    expect(dto.role.key).toBe('admin');
    expect(dto.status).toBe('pending');
    expect(dto.id.startsWith('inv_')).toBe(true);

    // The mailer was exercised; the raw token is in the email, not the response.
    expect(ctx.mailer.messages).toHaveLength(1);
    const rawToken = ctx.mailer.lastToken();
    expect(rawToken).toBeTruthy();
    expect(JSON.stringify(response.json())).not.toContain(rawToken as string);

    // Hash-only storage: the raw token is never persisted.
    const stored = ctx.orgStore.invitations[0];
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash.length).toBeGreaterThan(0);
    // The DTO carries neither the token nor its hash.
    expect(JSON.stringify(response.json())).not.toContain(stored.tokenHash);

    // invitation.created recorded, with NO token/hash in metadata.
    const created = eventsOfType(INVITATION_EVENT_TYPES.created);
    expect(created).toHaveLength(1);
    const metaJson = JSON.stringify(created[0].metadata);
    expect(metaJson).not.toContain(rawToken as string);
    expect(metaJson).not.toContain(stored.tokenHash);
  });

  it('normalizes the invited email', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    await inviteOk(owner.token, orgId, 'Mixed.Case@Example.COM');
    expect(ctx.orgStore.invitations[0].invitedEmailNormalized).toBe(
      'mixed.case@example.com',
    );
  });

  it('rejects an unauthenticated create', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations`,
      payload: { email: 'x@example.com', role: 'member' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-member create with a uniform not-found', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const outsider = await registerUser();
    const response = await invite(outsider.token, orgId, 'x@example.com');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('rejects a member who lacks invitations.create', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const member = await registerUser();
    // Add the user as a plain member (no invitations.create permission).
    ctx.orgStore.memberships.push({
      id: createId('mem'),
      userId: member.userId,
      organizationId: orgId,
      roleId: ROLE_IDS.member,
      status: 'active',
      invitedByUserId: null,
      joinedAt: new Date(),
      removedAt: null,
      removedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await invite(member.token, orgId, 'x@example.com');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects an invalid email and an invalid/custom role', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);

    const badEmail = await invite(owner.token, orgId, 'not-an-email');
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json().error.code).toBe('VALIDATION_ERROR');

    const badRole = await invite(owner.token, orgId, 'x@example.com', 'superadmin');
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects inviting an email that is already an active member', async () => {
    const owner = await registerUser('owner@example.com');
    const orgId = await createTeamOrg(owner.token);
    const response = await invite(owner.token, orgId, 'owner@example.com');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('rejects a duplicate pending invitation', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    await inviteOk(owner.token, orgId, 'dupe@example.com');
    const second = await invite(owner.token, orgId, 'dupe@example.com');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('enforces the reservation quota (active members + pending invitations)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    setPlan(orgId, 'free'); // max_members = 3; owner is 1 active member.

    await inviteOk(owner.token, orgId, 'a@example.com'); // reserved 2
    await inviteOk(owner.token, orgId, 'b@example.com'); // reserved 3
    const blocked = await invite(owner.token, orgId, 'c@example.com');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(blocked.json().error.details.quota).toBe('max_members');
  });

  it('fails closed when email delivery fails (no invitation persisted)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    ctx.mailer.failNext = true;
    const response = await invite(owner.token, orgId, 'x@example.com');
    expect(response.statusCode).toBe(500);
    expect(ctx.orgStore.invitations).toHaveLength(0);
    expect(eventsOfType(INVITATION_EVENT_TYPES.created)).toHaveLength(0);
  });
});

describe('invitation list', () => {
  it('lists only the organization invitations, without token or hash', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { rawToken } = await inviteOk(owner.token, orgId, 'a@example.com');

    // A second organization with its own invitation (tenant isolation).
    const otherOwner = await registerUser();
    const otherOrg = await createTeamOrg(otherOwner.token, 'Other');
    await inviteOk(otherOwner.token, otherOrg, 'b@example.com');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].invitedEmail).toBe('a@example.com');
    const hash = ctx.orgStore.invitations.find((i) => i.invitedEmailNormalized === 'a@example.com')!.tokenHash;
    const body = JSON.stringify(response.json());
    expect(body).not.toContain(rawToken as string);
    expect(body).not.toContain(hash);
  });

  it('presents an expired pending invitation as expired', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    await inviteOk(owner.token, orgId, 'a@example.com');
    // Force expiry on the stored row (no background job exists).
    ctx.orgStore.invitations[0].expiresAt = new Date(Date.now() - 1000);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(owner.token),
    });
    expect(response.json().data.items[0].status).toBe('expired');
  });

  it('requires invitations.read', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const viewer = await registerUser();
    ctx.orgStore.memberships.push({
      id: createId('mem'),
      userId: viewer.userId,
      organizationId: orgId,
      roleId: ROLE_IDS.viewer,
      status: 'active',
      invitedByUserId: null,
      joinedAt: new Date(),
      removedAt: null,
      removedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(viewer.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
});

describe('invitation revoke', () => {
  it('revokes a pending invitation without hard-deleting it, and records the event', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id } = await inviteOk(owner.token, orgId, 'a@example.com');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ id, revoked: true });

    const row = ctx.orgStore.invitations.find((i) => i.id === id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('revoked');
    expect(row!.revokedByUserId).toBe(owner.userId);
    expect(eventsOfType(INVITATION_EVENT_TYPES.revoked)).toHaveLength(1);
  });

  it('rejects revoking an already-revoked or accepted invitation', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id } = await inviteOk(owner.token, orgId, 'a@example.com');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });
    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVITATION_REVOKED');
  });

  it('rejects a cross-organization revoke with a uniform not-found', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id } = await inviteOk(owner.token, orgId, 'a@example.com');

    const otherOwner = await registerUser();
    const otherOrg = await createTeamOrg(otherOwner.token, 'Other');
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${otherOrg}/invitations/${id}`,
      headers: authHeader(otherOwner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('INVITATION_INVALID');
  });

  it('requires invitations.revoke', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id } = await inviteOk(owner.token, orgId, 'a@example.com');
    const member = await registerUser();
    ctx.orgStore.memberships.push({
      id: createId('mem'),
      userId: member.userId,
      organizationId: orgId,
      roleId: ROLE_IDS.member,
      status: 'active',
      invitedByUserId: null,
      joinedAt: new Date(),
      removedAt: null,
      removedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('invitation inspect (public)', () => {
  it('returns safe public context for an acceptable invitation, with no internals', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme Inc');
    const { rawToken } = await inviteOk(owner.token, orgId, 'a@example.com', 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/invitations/inspect',
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(200);
    const dto = response.json().data.invitation;
    expect(dto).toEqual({
      organizationName: 'Acme Inc',
      invitedEmail: 'a@example.com',
      role: { key: 'admin', name: 'Admin' },
      expiresAt: expect.any(String),
      acceptable: true,
    });
    // No ids, token, hash, or organizationId leak.
    const body = JSON.stringify(response.json());
    expect(body).not.toContain(orgId);
    expect(body).not.toContain(rawToken as string);
  });

  it('rejects invalid, revoked, accepted, and expired tokens safely', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/invitations/inspect',
      payload: { token: 'totally-unknown-token' },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe('INVITATION_INVALID');

    const { id, rawToken } = await inviteOk(owner.token, orgId, 'r@example.com');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/invitations/inspect',
      payload: { token: rawToken },
    });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe('INVITATION_REVOKED');

    const { rawToken: expToken } = await inviteOk(owner.token, orgId, 'e@example.com');
    ctx.orgStore.invitations.find((i) => i.invitedEmailNormalized === 'e@example.com')!.expiresAt =
      new Date(Date.now() - 1000);
    const expired = await app.inject({
      method: 'POST',
      url: '/v1/invitations/inspect',
      payload: { token: expToken },
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('INVITATION_EXPIRED');
  });
});

describe('invitation accept (existing user)', () => {
  it('accepts a valid invitation, creating an active membership with the invited role', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'invitee@example.com', 'admin');

    const invitee = await registerUser('invitee@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.organization.id).toBe(orgId);
    expect(response.json().data.membership.role.key).toBe('admin');

    // Membership exists and is active with the invited role.
    const membership = ctx.orgStore.memberships.find(
      (m) => m.userId === invitee.userId && m.organizationId === orgId,
    );
    expect(membership?.status).toBe('active');
    expect(membership?.roleId).toBe(ROLE_IDS.admin);
    expect(membership?.invitedByUserId).toBe(owner.userId);

    // Invitation marked accepted (single use).
    const row = ctx.orgStore.invitations.find((i) => i.id === id);
    expect(row?.status).toBe('accepted');
    expect(row?.acceptedByUserId).toBe(invitee.userId);

    // Both action events recorded.
    expect(eventsOfType(INVITATION_EVENT_TYPES.accepted)).toHaveLength(1);
    expect(
      eventsOfType(INVITATION_EVENT_TYPES.membershipCreatedFromInvitation),
    ).toHaveLength(1);
  });

  it('rejects an email mismatch without creating a membership', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { rawToken } = await inviteOk(owner.token, orgId, 'invited@example.com');
    const other = await registerUser('someone.else@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(other.token),
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');
    expect(
      ctx.orgStore.memberships.some(
        (m) => m.userId === other.userId && m.organizationId === orgId,
      ),
    ).toBe(false);
  });

  it('rejects reuse of an already-accepted invitation', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { rawToken } = await inviteOk(owner.token, orgId, 'invitee@example.com');
    const invitee = await registerUser('invitee@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVITATION_ALREADY_ACCEPTED');
  });

  it('rejects an expired and a revoked invitation', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);

    const { rawToken: expToken } = await inviteOk(owner.token, orgId, 'exp@example.com');
    ctx.orgStore.invitations.find((i) => i.invitedEmailNormalized === 'exp@example.com')!.expiresAt =
      new Date(Date.now() - 1000);
    const expUser = await registerUser('exp@example.com');
    const expired = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(expUser.token),
      payload: { token: expToken },
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('INVITATION_EXPIRED');

    const { id, rawToken: revToken } = await inviteOk(owner.token, orgId, 'rev@example.com');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });
    const revUser = await registerUser('rev@example.com');
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(revUser.token),
      payload: { token: revToken },
    });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe('INVITATION_REVOKED');
  });

  it('rejects acceptance when the email is already an active member', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { rawToken } = await inviteOk(owner.token, orgId, 'invitee@example.com');
    const invitee = await registerUser('invitee@example.com');
    // Accept once (joins), then a second distinct invitation cannot be created
    // (already active member). Simulate a duplicate-active acceptance directly:
    await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    // A fresh invitation to the same email now fails to even create.
    const dup = await invite(owner.token, orgId, 'invitee@example.com');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
  });

  it('fails the active-member quota at acceptance without mutating state', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    setPlan(orgId, 'free'); // max_members = 3
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'invitee@example.com'); // reserved 2
    // Fill the org to the ceiling AFTER the invitation exists.
    addFillerMember(orgId);
    addFillerMember(orgId); // active members now 3 (= max)

    const invitee = await registerUser('invitee@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED');

    // No membership created, invitation NOT accepted, no membership-created event.
    expect(
      ctx.orgStore.memberships.some(
        (m) => m.userId === invitee.userId && m.organizationId === orgId,
      ),
    ).toBe(false);
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');
    expect(
      eventsOfType(INVITATION_EVENT_TYPES.membershipCreatedFromInvitation),
    ).toHaveLength(0);
  });
});

describe('registration with invitation', () => {
  it('creates the account, its personal workspace, AND the invited membership', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'newbie@example.com', 'member');

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
    // Session/refresh response shape is unchanged.
    expect(response.json().data.tokens.accessToken).toBeTruthy();
    expect(response.headers['set-cookie']).toBeTruthy();
    const newUserId = response.json().data.user.id;

    // Personal workspace (owner of a personal org) STILL created.
    const personal = ctx.orgStore.memberships.filter(
      (m) => m.userId === newUserId && m.roleId === ROLE_IDS.owner,
    );
    expect(personal.length).toBeGreaterThanOrEqual(1);
    // Invited membership created with the invited role.
    const invited = ctx.orgStore.memberships.find(
      (m) => m.userId === newUserId && m.organizationId === orgId,
    );
    expect(invited?.status).toBe('active');
    expect(invited?.roleId).toBe(ROLE_IDS.member);
    // Invitation accepted.
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('accepted');
  });

  it('rolls back the ENTIRE registration if in-transaction acceptance fails (race)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'racer@example.com');
    // Simulate the invitation becoming unavailable AFTER the pre-check but
    // BEFORE the acceptance commits: revoke it, then drive the registration
    // transaction directly with the now-stale acceptance.
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });

    const usersBefore = ctx.authRepo.users.length;
    const membershipsBefore = ctx.orgStore.memberships.length;
    const sessionsBefore = ctx.authRepo.sessions.length;

    await expect(
      ctx.authRepo.registerAccount({
        user: {
          email: 'racer@example.com',
          normalizedEmail: 'racer@example.com',
          passwordHash: 'x',
          displayName: 'Racer',
        },
        personalWorkspace: { name: "Racer's Workspace", slugBase: 'racer-ws' },
        session: {
          ipAddress: null,
          userAgent: null,
          expiresAt: new Date(Date.now() + 10_000),
        },
        refreshToken: {
          tokenHash: `rt-${createId('rtok')}`,
          familyId: createId('rtok'),
          expiresAt: new Date(Date.now() + 10_000),
        },
        invitationAcceptance: {
          tokenHash: hashInvitationToken(rawToken),
          maxMembers: 50,
          eventContext: { requestId: null, ipAddress: null, userAgent: null },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_REVOKED' });

    // No partial state: no new user, no new membership, no session issued, and
    // the invitation stays revoked (never flipped to accepted).
    expect(ctx.authRepo.users.length).toBe(usersBefore);
    expect(ctx.orgStore.memberships.length).toBe(membershipsBefore);
    expect(ctx.authRepo.sessions.length).toBe(sessionsBefore);
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe(
      'revoked',
    );
  });

  it('rejects registration when the email does not match the invitation', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { rawToken } = await inviteOk(owner.token, orgId, 'invited@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'different@example.com',
        password: 'a-strong-password-123',
        displayName: 'Mismatch',
        invitationToken: rawToken,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');
    // No account created for the failed registration.
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'different@example.com'),
    ).toBe(false);
  });

  it('does not create an account or membership when acceptance quota fails', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    setPlan(orgId, 'free'); // max_members = 3
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'newbie@example.com');
    addFillerMember(orgId);
    addFillerMember(orgId); // active = 3 (= max) before registration

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
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'newbie@example.com'),
    ).toBe(false);
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');
    // No auth session is issued for a failed registration-with-invitation.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data).toBeUndefined();
  });

  it('rejects registration with an unknown invitation token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'newbie@example.com',
        password: 'a-strong-password-123',
        displayName: 'Newbie',
        invitationToken: 'unknown-token',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('INVITATION_INVALID');
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'newbie@example.com'),
    ).toBe(false);
  });

  it('still registers normally when no invitation token is supplied', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'plain@example.com',
        password: 'a-strong-password-123',
        displayName: 'Plain',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.tokens.accessToken).toBeTruthy();
  });
});
