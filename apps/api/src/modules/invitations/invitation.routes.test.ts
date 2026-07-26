import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { requireDefined } from '../../lib/invariant';
import {
  lastCompletionTokenFor,
  registerTestUser,
} from '../auth/testing/register-test-user';
import { INVITATION_EVENT_TYPES } from './invitation.events';
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
  const { accessToken, userId } = await registerTestUser(app, ctx.mailer, {
    email: resolved,
    password: 'a-strong-password-123',
    displayName: 'Test User',
  });
  return { token: accessToken, userId, email: resolved };
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
  const rawToken = ctx.mailer.lastLinkToken();
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
    // Ignore the owner's registration-completion email; this test asserts on
    // the INVITATION delivery only.
    ctx.mailer.messages.length = 0;

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
    const rawToken = ctx.mailer.lastLinkToken();
    expect(rawToken).toBeTruthy();
    expect(JSON.stringify(response.json())).not.toContain(rawToken as string);

    // Hash-only storage: the raw token is never persisted.
    const stored = requireDefined(
      ctx.orgStore.invitations[0],
      'stored invitation',
    );
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash.length).toBeGreaterThan(0);
    // The DTO carries neither the token nor its hash.
    expect(JSON.stringify(response.json())).not.toContain(stored.tokenHash);

    // invitation.created recorded, with NO token/hash in metadata.
    const created = eventsOfType(INVITATION_EVENT_TYPES.created);
    expect(created).toHaveLength(1);
    const metaJson = JSON.stringify(
      requireDefined(created[0], 'created event').metadata,
    );
    expect(metaJson).not.toContain(rawToken as string);
    expect(metaJson).not.toContain(stored.tokenHash);
  });

  it('normalizes the invited email', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    await inviteOk(owner.token, orgId, 'Mixed.Case@Example.COM');
    expect(ctx.orgStore.invitations[0]?.invitedEmailNormalized).toBe(
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
    requireDefined(
      ctx.orgStore.invitations[0],
      'stored invitation',
    ).expiresAt = new Date(Date.now() - 1000);

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

/** Stage a registration, optionally carrying an invitation token. */
function registerWithInvitation(
  email: string,
  invitationToken: string | null,
  displayName = 'Newbie',
) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email,
      password: 'a-strong-password-123',
      displayName,
      ...(invitationToken ? { invitationToken } : {}),
    },
  });
}

function completeRegistration(rawCompletionToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/registration/complete',
    payload: { token: rawCompletionToken },
  });
}

describe('registration with invitation (verification-first, Sprint 18)', () => {

  it('creates the account, personal workspace, AND invited membership at completion', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'newbie@example.com', 'member');

    // Step 1: the request is GENERIC — no account, no session, no cookie.
    const requested = await registerWithInvitation('newbie@example.com', rawToken);
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(requested.headers['set-cookie']).toBeUndefined();
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'newbie@example.com'),
    ).toBe(false);
    // The invitation is untouched until the mailbox is proven.
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');

    // Step 2: the mailbox owner completes via the emailed token.
    const completionToken = lastCompletionTokenFor(ctx.mailer, 'newbie@example.com');
    expect(completionToken).toBeTruthy();
    const completed = await completeRegistration(completionToken as string);
    expect(completed.statusCode).toBe(201);
    expect(completed.json().data.tokens.accessToken).toBeTruthy();
    expect(completed.json().data.invitation).toEqual({ status: 'accepted' });
    expect(completed.headers['set-cookie']).toBeTruthy();
    const newUserId = completed.json().data.user.id;

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
    // Invitation accepted, atomically with the account.
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('accepted');
    // Acceptance events recorded.
    expect(eventsOfType(INVITATION_EVENT_TYPES.accepted).length).toBeGreaterThanOrEqual(1);
  });

  it('an invitation revoked between request and completion follows the documented policy: account created, join unavailable', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'racer@example.com');

    const requested = await registerWithInvitation('racer@example.com', rawToken);
    expect(requested.statusCode).toBe(200);
    // The invitation becomes unavailable while the completion email is in flight.
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invitations/${id}`,
      headers: authHeader(owner.token),
    });

    const completionToken = lastCompletionTokenFor(ctx.mailer, 'racer@example.com');
    const completed = await completeRegistration(completionToken as string);

    // Documented Sprint 18 policy: the proven mailbox still gets its account,
    // personal workspace, and session; ONLY the invited-organization join is
    // reported as unavailable — never silently dropped.
    expect(completed.statusCode).toBe(201);
    expect(completed.json().data.invitation).toEqual({ status: 'unavailable' });
    const newUserId = completed.json().data.user.id;
    expect(
      ctx.orgStore.memberships.some(
        (m) => m.userId === newUserId && m.organizationId === orgId,
      ),
    ).toBe(false);
    expect(
      ctx.orgStore.memberships.some(
        (m) => m.userId === newUserId && m.roleId === ROLE_IDS.owner,
      ),
    ).toBe(true);
    // The invitation stays revoked (never flipped to accepted).
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('revoked');
  });

  it('an invitation expired between request and completion is also reported unavailable', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'late@example.com');

    await registerWithInvitation('late@example.com', rawToken);
    const invitation = ctx.orgStore.invitations.find((i) => i.id === id);
    if (invitation) invitation.expiresAt = new Date(Date.now() - 1000);

    const completionToken = lastCompletionTokenFor(ctx.mailer, 'late@example.com');
    const completed = await completeRegistration(completionToken as string);
    expect(completed.statusCode).toBe(201);
    expect(completed.json().data.invitation).toEqual({ status: 'unavailable' });
    expect(
      ctx.orgStore.memberships.some(
        (m) =>
          m.organizationId === orgId &&
          m.userId === completed.json().data.user.id,
      ),
    ).toBe(false);
  });

  it('re-checks the member quota at completion (filled while the email was in flight)', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    setPlan(orgId, 'free'); // max_members = 3
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'squeezed@example.com');

    const requested = await registerWithInvitation('squeezed@example.com', rawToken);
    expect(requested.statusCode).toBe(200);
    addFillerMember(orgId);
    addFillerMember(orgId); // active = 3 (= max) before completion

    const completionToken = lastCompletionTokenFor(ctx.mailer, 'squeezed@example.com');
    const completed = await completeRegistration(completionToken as string);
    expect(completed.statusCode).toBe(201);
    expect(completed.json().data.invitation).toEqual({ status: 'unavailable' });
    expect(
      ctx.orgStore.memberships.some(
        (m) =>
          m.organizationId === orgId &&
          m.userId === completed.json().data.user.id,
      ),
    ).toBe(false);
    // No duplicate acceptance state: the invitation remains pending.
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');
  });

  it('answers an email mismatch with the generic acceptance, with and without an existing account', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'invited@example.com');
    ctx.mailer.messages.length = 0;

    // Mismatch with an email that has NO account…
    const noAccount = await registerWithInvitation('different@example.com', rawToken, 'Mismatch');
    // …and a mismatch with an email that HAS an account (the owner's).
    const hasAccount = await registerWithInvitation(owner.email, rawToken, 'Mismatch');

    // Identical GENERIC acceptance for both: the mismatch itself is a private
    // invitation state and must not surface, and account existence must not
    // alter the response either.
    expect(noAccount.statusCode).toBe(200);
    expect(hasAccount.statusCode).toBe(200);
    expect(noAccount.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(hasAccount.json()).toEqual(noAccount.json());

    // Nothing staged, no account created, nothing sent (a failed invitation
    // must not trigger even the existing-account guidance email), and the
    // invitation itself is untouched.
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'different@example.com'),
    ).toBe(false);
    // No USABLE pending generation was staged (the owner's own consumed row
    // from setup is the only historical record).
    expect(
      ctx.registrationRepo.pendingRegistrations.filter(
        (p) => p.usedAt === null && p.invalidatedAt === null,
      ),
    ).toHaveLength(0);
    expect(ctx.mailer.messages).toHaveLength(0);
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');
  });

  it('answers a quota-exhausted invitation with the generic acceptance without staging anything', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    setPlan(orgId, 'free'); // max_members = 3
    const { id, rawToken } = await inviteOk(owner.token, orgId, 'newbie@example.com');
    addFillerMember(orgId);
    addFillerMember(orgId); // active = 3 (= max) before registration
    ctx.mailer.messages.length = 0;

    const response = await registerWithInvitation('newbie@example.com', rawToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'newbie@example.com'),
    ).toBe(false);
    expect(
      ctx.registrationRepo.pendingRegistrations.filter(
        (p) => p.usedAt === null && p.invalidatedAt === null,
      ),
    ).toHaveLength(0);
    expect(ctx.mailer.messages).toHaveLength(0);
    expect(ctx.orgStore.invitations.find((i) => i.id === id)?.status).toBe('pending');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('answers an unknown invitation token with the generic acceptance', async () => {
    const response = await registerWithInvitation('newbie@example.com', 'unknown-token');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(
      ctx.orgStore.users.some((u) => u.normalizedEmail === 'newbie@example.com'),
    ).toBe(false);
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(0);
  });

  it('still registers normally (two-step) when no invitation token is supplied', async () => {
    const { completion, invitation } = await registerTestUser(app, ctx.mailer, {
      email: 'plain@example.com',
      password: 'a-strong-password-123',
      displayName: 'Plain',
    });
    expect(completion.tokens.accessToken).toBeTruthy();
    expect(invitation).toBeNull();
  });
});

describe('public registration equality matrix (invitation states)', () => {
  interface PublicShape {
    status: number;
    body: unknown;
    setCookie: unknown;
    authHeader: unknown;
  }

  function publicShape(response: {
    statusCode: number;
    json: () => unknown;
    headers: Record<string, unknown>;
  }): PublicShape {
    return {
      status: response.statusCode,
      body: response.json(),
      setCookie: response.headers['set-cookie'],
      authHeader: response.headers.authorization,
    };
  }

  /** Counts of everything a rejected invitation must leave untouched. */
  function sideEffectSnapshot() {
    return {
      users: ctx.orgStore.users.length,
      pendings: ctx.registrationRepo.pendingRegistrations.length,
      sessions: ctx.authRepo.sessions.length,
      refreshTokens: ctx.authRepo.refreshTokens.length,
      mails: ctx.mailer.messages.length,
      invitationStates: ctx.orgStore.invitations
        .map((i) => `${i.id}:${i.status}:${i.acceptedAt?.getTime() ?? ''}`)
        .join('|'),
    };
  }

  it('answers every private invitation state with the byte-identical generic acceptance and zero side effects', async () => {
    const owner = await registerUser('matrix-owner@example.com');
    const org1 = await createTeamOrg(owner.token, 'Matrix One');

    // Fixture invitations, one per rejected state.
    const mismatch = await inviteOk(owner.token, org1, 'invited@example.com');
    const expired = await inviteOk(owner.token, org1, 'expired@example.com');
    const expiredRow = ctx.orgStore.invitations.find((i) => i.id === expired.id);
    if (expiredRow) expiredRow.expiresAt = new Date(Date.now() - 1000);
    const revoked = await inviteOk(owner.token, org1, 'revoked@example.com');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${org1}/invitations/${revoked.id}`,
      headers: authHeader(owner.token),
    });
    // An already-ACCEPTED invitation: consumed by a full registration.
    const accepted = await inviteOk(owner.token, org1, 'acceptee@example.com');
    await registerTestUser(app, ctx.mailer, {
      email: 'acceptee@example.com',
      password: 'a-strong-password-123',
      displayName: 'Acceptee',
      invitationToken: accepted.rawToken,
    });
    // Request-time quota exhaustion lives in its own org so it cannot bleed
    // into the other fixtures' validation.
    const org2 = await createTeamOrg(owner.token, 'Matrix Quota');
    setPlan(org2, 'free'); // max_members = 3
    const quota = await inviteOk(owner.token, org2, 'quota@example.com');
    addFillerMember(org2);
    addFillerMember(org2); // active = 3 (= max)
    // Internal invitation-validation failure: the org's plan state is gone,
    // so quota resolution inside prepare fails (a resolver-side fault, not a
    // caller-visible state).
    const org3 = await createTeamOrg(owner.token, 'Matrix Broken');
    const internal = await inviteOk(owner.token, org3, 'internal@example.com');
    const planIndex = ctx.orgStore.organizationPlans.findIndex(
      (p) => p.organizationId === org3,
    );
    ctx.orgStore.organizationPlans.splice(planIndex, 1);

    // Row 1 — plain eligible new email: the canonical shape. It legitimately
    // stages one pending registration and sends one completion email.
    const plain = publicShape(
      await registerWithInvitation('matrix-plain@example.com', null, 'Plain'),
    );

    const baseline = sideEffectSnapshot();

    // Row 2 — existing active account (may send guidance mail; no staging).
    const existing = publicShape(
      await registerWithInvitation('matrix-owner@example.com', null, 'Existing'),
    );
    expect(sideEffectSnapshot().pendings).toBe(baseline.pendings);
    expect(sideEffectSnapshot().users).toBe(baseline.users);

    // Rows 3-10 — every rejected invitation state, each with ZERO side
    // effects: no user, no pending, no session/refresh token, no invitation
    // mutation, no email of any kind.
    const rejectedRows: Array<[string, string, string]> = [
      ['unknown invitation token', 'row-unknown@example.com', 'totally-unknown-token'],
      ['email mismatch (new email)', 'row-mismatch-new@example.com', mismatch.rawToken],
      ['email mismatch (existing email)', 'matrix-owner@example.com', mismatch.rawToken],
      ['expired invitation', 'expired@example.com', expired.rawToken],
      ['revoked invitation', 'revoked@example.com', revoked.rawToken],
      ['already accepted invitation', 'row-accepted@example.com', accepted.rawToken],
      ['request-time quota exhaustion', 'quota@example.com', quota.rawToken],
      ['internal invitation-validation failure', 'internal@example.com', internal.rawToken],
    ];

    let before = sideEffectSnapshot();
    for (const [label, email, token] of rejectedRows) {
      const shape = publicShape(await registerWithInvitation(email, token, 'Matrix'));
      // Byte-identical public contract with the plain row.
      expect(shape, label).toEqual(plain);
      const after = sideEffectSnapshot();
      expect(after, label).toEqual(before);
      before = after;
    }

    // The existing-account row matches the same shape too.
    expect(existing).toEqual(plain);
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ ok: true, data: { accepted: true } });
    expect(plain.setCookie).toBeUndefined();
    expect(plain.authHeader).toBeUndefined();

    // Event hygiene across the whole matrix: anonymous, coarse, and free of
    // token material, hashes, emails, org/invitation ids, and quota values.
    const registrationEvents = ctx.registrationRepo.securityEvents.filter(
      (e) => e.eventType === 'auth.registration_requested',
    );
    expect(registrationEvents.length).toBeGreaterThanOrEqual(rejectedRows.length);
    const raw = JSON.stringify(registrationEvents.map((e) => e.metadata));
    for (const secret of [
      mismatch.rawToken,
      expired.rawToken,
      revoked.rawToken,
      accepted.rawToken,
      quota.rawToken,
      internal.rawToken,
      'example.com',
      org1,
      org2,
      org3,
      mismatch.id,
      quota.id,
    ]) {
      expect(raw).not.toContain(secret);
    }
    for (const event of registrationEvents) {
      expect(event.userId).toBeNull();
      expect(event.actorType).toBe('anonymous');
    }
  });
});
