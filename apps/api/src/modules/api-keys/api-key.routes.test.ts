import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_KEY_EVENT_TYPES } from './api-key.events';
import {
  buildApiKeysTestApp,
  type ApiKeysTestContext,
} from './testing/build-api-keys-test-app';

/**
 * End-to-end API key MANAGEMENT route behavior over the shared in-memory store.
 * Covers user authentication, membership + permission gating (by permission key),
 * the entitlement (api_keys_access) and quota (max_api_keys) gates, hash-only
 * storage, one-time secret display, tenant-scoped revoke, and the action-event
 * seam. Every assertion proves BACKEND enforcement.
 */
let ctx: ApiKeysTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Key User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `key.user.${emailSeq}@example.com`,
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

/** Move the org onto a plan that grants API keys (Free grants none by default). */
function setPlan(organizationId: string, planKey = 'pro'): void {
  const state = ctx.orgStore.organizationPlans.find(
    (p) => p.organizationId === organizationId,
  );
  if (!state) {
    throw new Error(`No plan state for organization ${organizationId}.`);
  }
  state.planKey = planKey as typeof state.planKey;
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

async function createKey(
  token: string,
  organizationId: string,
  name = 'CI reader',
): Promise<{ id: string; secret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/api-keys`,
    headers: authHeader(token),
    payload: { name, scopes: ['projects:read'] },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().data.apiKey.id,
    secret: response.json().data.secret,
  };
}

beforeEach(async () => {
  ctx = await buildApiKeysTestApp();
  app = ctx.app;
});

afterEach(async () => {
  await app.close();
});

describe('POST …/api-keys (create)', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      payload: { name: 'k', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (a stranger gets a uniform 404)', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(stranger.token),
      payload: { name: 'k', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('requires api_keys.create — a Viewer is forbidden (permission before entitlement)', async () => {
    const owner = await registerUser('Owner');
    const viewer = await registerUser('Viewer');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    addMembership(orgId, viewer.userId, ROLE_IDS.viewer);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(viewer.token),
      payload: { name: 'k', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('requires the api_keys_access entitlement (Free plan is blocked)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // Default plan is Free — api_keys_access is false.
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'k', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(response.json().error.details.entitlement).toBe('api_keys_access');
  });

  it('enforces the max_api_keys quota', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'pro'); // max_api_keys = 5
    for (let i = 0; i < 5; i += 1) {
      await createKey(owner.token, orgId, `key ${i}`);
    }
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'over quota', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(response.json().error.details.quota).toBe('max_api_keys');
    expect(response.json().error.details.limit).toBe(5);
  });

  it('creates a key, stores ONLY the hash, returns the raw secret once, and records api_key.created', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'CI reader', scopes: ['projects:read'] },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json().data;

    // The raw secret is returned exactly once, in this response only.
    expect(typeof body.secret).toBe('string');
    expect(body.secret.startsWith('orgistry_')).toBe(true);

    // The DTO exposes display/status, never the secret or its hash.
    expect(body.apiKey.id).toMatch(/^key_/);
    expect(body.apiKey.organizationId).toBe(orgId);
    expect(body.apiKey.displayPrefix.startsWith('orgistry_')).toBe(true);
    expect(body.apiKey.status).toBe('active');
    expect(body.apiKey.scopes).toEqual(['projects:read']);
    expect(body.apiKey.lastUsedAt).toBeNull();
    expect('secret' in body.apiKey).toBe(false);
    expect('secretHash' in body.apiKey).toBe(false);

    // Persistence stores the hash, NOT the raw secret.
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === body.apiKey.id)!;
    expect(stored.secretHash).toBeTruthy();
    expect(stored.secretHash).not.toBe(body.secret);
    expect(JSON.stringify(stored)).not.toContain(body.secret);

    // The id was GENERATED by the real service/repository path (not supplied by
    // the client), and carries the key_ prefix.
    expect(body.apiKey.id).toMatch(/^key_/);

    // The lifecycle ACTION event is recorded with the full actor attribution and
    // safe metadata only — and it is a `user` action, not a security event.
    const events = ctx.orgStore.securityEvents.filter(
      (e) => e.eventType === API_KEY_EVENT_TYPES.created,
    );
    expect(events).toHaveLength(1);
    expect(events[0].actorType).toBe('user');
    expect(events[0].organizationId).toBe(orgId);
    expect(events[0].userId).toBe(owner.userId);
    expect(events[0].metadata.actorMembershipId).toMatch(/^mem_/);
    expect(events[0].metadata.targetKeyId).toBe(body.apiKey.id);
    expect(typeof events[0].requestId).toBe('string');
    const eventJson = JSON.stringify(events[0]);
    expect(eventJson).not.toContain(body.secret);
    expect(eventJson).not.toContain(stored.secretHash);
  });

  it('creates under the ROUTE organization, ignoring a smuggled body org', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    setPlan(orgId);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: {
        name: 'k',
        scopes: ['projects:read'],
        organizationId: otherOrgId,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.apiKey.organizationId).toBe(orgId);
  });

  it('rejects an invalid scope and a past expiresAt', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);

    const badScope = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'k', scopes: ['projects:write'] },
    });
    expect(badScope.statusCode).toBe(400);
    expect(badScope.json().error.code).toBe('VALIDATION_ERROR');

    const pastExpiry = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: {
        name: 'k',
        scopes: ['projects:read'],
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    });
    expect(pastExpiry.statusCode).toBe(400);
    expect(pastExpiry.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('max_api_keys quota counts only active, non-expired keys', () => {
  it('an active non-expired key counts toward the quota', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'pro'); // max_api_keys = 5
    for (let i = 0; i < 5; i += 1) {
      await createKey(owner.token, orgId, `key ${i}`);
    }
    // All five are active and non-expired → the sixth is blocked.
    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'over', scopes: ['projects:read'] },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('a revoked key does NOT count toward the quota', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'pro'); // max_api_keys = 5
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      keys.push((await createKey(owner.token, orgId, `key ${i}`)).id);
    }
    // Revoke one: the active count drops to 4, so a new key may be created.
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${keys[0]}`,
      headers: authHeader(owner.token),
    });
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'replacement', scopes: ['projects:read'] },
    });
    expect(created.statusCode).toBe(201);
  });

  it('an expired key does NOT count toward the quota', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'pro'); // max_api_keys = 5
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      keys.push((await createKey(owner.token, orgId, `key ${i}`)).id);
    }
    // Expire one in the past (non-revoked): it can no longer authenticate and
    // must not occupy a quota slot, so a new key may be created.
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === keys[0])!;
    stored.expiresAt = new Date(Date.now() - 1000);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
      payload: { name: 'after-expiry', scopes: ['projects:read'] },
    });
    expect(created.statusCode).toBe(201);
  });
});

describe('GET …/api-keys (list)', () => {
  it('requires the api_keys_access entitlement', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // Free plan — listing is entitlement-gated like every key operation.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ENTITLEMENT_REQUIRED');
  });

  it('returns only the org\'s keys, with display/status/last-used and no secret material', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const created = await createKey(owner.token, orgId, 'Mine');

    // A separate org whose keys must NOT appear here.
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    setPlan(otherOrgId);
    const foreign = await createKey(other.token, otherOrgId, 'Theirs');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items as Array<Record<string, unknown>>;
    const ids = items.map((k) => k.id);
    expect(ids).toContain(created.id);
    expect(ids).not.toContain(foreign.id);

    const item = items[0];
    expect(item.displayPrefix).toBeTruthy();
    expect(item.status).toBe('active');
    expect(item).toHaveProperty('lastUsedAt');

    // No raw secret or hash anywhere in the list response.
    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain(created.secret);
    expect(raw).not.toContain('secretHash');
    expect(raw).not.toContain('secret_hash');
  });

  it('paginates with an opaque cursor', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'business'); // larger quota
    for (let i = 0; i < 4; i += 1) {
      await createKey(owner.token, orgId, `key ${i}`);
    }
    const first = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys?limit=2`,
      headers: authHeader(owner.token),
    });
    expect(first.json().data.items).toHaveLength(2);
    expect(first.json().data.hasMore).toBe(true);
    const cursor = first.json().data.nextCursor;

    const second = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: authHeader(owner.token),
    });
    const firstIds = first.json().data.items.map((k: { id: string }) => k.id);
    const secondIds = second.json().data.items.map((k: { id: string }) => k.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });
});

describe('DELETE …/api-keys/:apiKeyId (revoke)', () => {
  it('requires api_keys.revoke — a Member is forbidden', async () => {
    const owner = await registerUser('Owner');
    const member = await registerUser('Member');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    addMembership(orgId, member.userId, ROLE_IDS.member);
    const key = await createKey(owner.token, orgId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: authHeader(member.token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('revokes a key, sets markers, and records api_key.revoked with full attribution', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ id: key.id, revoked: true });

    const stored = ctx.orgStore.apiKeys.find((k) => k.id === key.id)!;
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.revokedByUserId).toBe(owner.userId);

    const revokeEvents = ctx.orgStore.securityEvents.filter(
      (e) => e.eventType === API_KEY_EVENT_TYPES.revoked,
    );
    expect(revokeEvents).toHaveLength(1);
    expect(revokeEvents[0].actorType).toBe('user');
    expect(revokeEvents[0].organizationId).toBe(orgId);
    expect(revokeEvents[0].userId).toBe(owner.userId);
    expect(revokeEvents[0].metadata.actorMembershipId).toMatch(/^mem_/);
    expect(revokeEvents[0].metadata.targetKeyId).toBe(key.id);
  });

  it('is idempotent: a repeated revoke does not overwrite markers or duplicate the event', async () => {
    const owner = await registerUser('Owner');
    // A second Owner-equivalent admin who ALSO holds api_keys.revoke, used to
    // prove the repeated revoke does not re-attribute revoked_by_user_id.
    const admin = await registerUser('Admin');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    addMembership(orgId, admin.userId, ROLE_IDS.admin);
    const key = await createKey(owner.token, orgId);

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: authHeader(owner.token),
    });
    expect(first.statusCode).toBe(200);

    const stored = ctx.orgStore.apiKeys.find((k) => k.id === key.id)!;
    const revokedAtAfterFirst = stored.revokedAt?.getTime();
    expect(revokedAtAfterFirst).toBeTruthy();
    expect(stored.revokedByUserId).toBe(owner.userId);

    // A different authorized actor revokes again: still a safe success, but the
    // original markers are preserved and no second event is written.
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: authHeader(admin.token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual({ id: key.id, revoked: true });

    expect(stored.revokedAt?.getTime()).toBe(revokedAtAfterFirst); // not overwritten
    expect(stored.revokedByUserId).toBe(owner.userId); // not re-attributed to admin

    const revokeEvents = ctx.orgStore.securityEvents.filter(
      (e) => e.eventType === API_KEY_EVENT_TYPES.revoked,
    );
    expect(revokeEvents).toHaveLength(1); // no duplicate
  });

  it('returns a safe API_KEY_NOT_FOUND for a cross-tenant revoke', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const other = await registerUser('Other');
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    setPlan(otherOrgId);
    const foreign = await createKey(other.token, otherOrgId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${foreign.id}`,
      headers: authHeader(owner.token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('API_KEY_NOT_FOUND');

    // The foreign key is untouched.
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === foreign.id)!;
    expect(stored.revokedAt).toBeNull();
  });
});
