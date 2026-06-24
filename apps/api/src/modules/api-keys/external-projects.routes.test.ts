import { createId } from '@orgistry/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiKeyRow } from '@orgistry/db';
import { generateApiKeySecret, parseApiKey } from './api-key-secret';
import { API_KEY_SECURITY_EVENT_TYPES } from './api-key.events';
import {
  buildApiKeysTestApp,
  type ApiKeysTestContext,
  type BuildApiKeysAppOptions,
} from './testing/build-api-keys-test-app';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';

/**
 * End-to-end EXTERNAL read-only Projects API behavior over the shared in-memory
 * store. Proves API-key authentication (missing/malformed/unknown/revoked/
 * expired/inactive-org/missing-entitlement/missing-scope), that the tenant is
 * derived from the key (no org id in the route, no browser JWT), tenant
 * isolation, soft-delete omission, cursor pagination, rate limiting, and
 * last-used throttling. Every assertion proves BACKEND enforcement.
 */
let ctx: ApiKeysTestContext;
let app: FastifyInstance;
let emailSeq = 0;

async function setup(options?: BuildApiKeysAppOptions): Promise<void> {
  ctx = await buildApiKeysTestApp(options);
  app = ctx.app;
}

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

async function registerUser(): Promise<{ token: string; userId: string }> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `ext.user.${emailSeq}@example.com`,
      password: 'a-strong-password-123',
      displayName: 'Ext User',
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    token: response.json().data.tokens.accessToken,
    userId: response.json().data.user.id,
  };
}

function userAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function keyAuth(rawKey: string): Record<string, string> {
  return { authorization: `Bearer ${rawKey}` };
}

async function createTeamOrg(token: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: userAuth(token),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.organization.id;
}

function setPlan(organizationId: string, planKey = 'pro'): void {
  const state = ctx.orgStore.organizationPlans.find(
    (p) => p.organizationId === organizationId,
  );
  if (!state) {
    throw new Error(`No plan state for organization ${organizationId}.`);
  }
  state.planKey = planKey as typeof state.planKey;
}

/** Create a key via the management API and return its id + raw secret. */
async function createKey(
  token: string,
  organizationId: string,
): Promise<{ id: string; secret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/api-keys`,
    headers: userAuth(token),
    payload: { name: 'reader', scopes: ['projects:read'] },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().data.apiKey.id,
    secret: response.json().data.secret,
  };
}

async function createProject(
  token: string,
  organizationId: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/projects`,
    headers: userAuth(token),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.project.id;
}

async function externalList(rawKey: string | null, query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/external/projects${query}`,
    headers: rawKey ? keyAuth(rawKey) : {},
  });
}

describe('GET /v1/external/projects — authentication', () => {
  it('rejects a missing Authorization header', async () => {
    await setup();
    const response = await externalList(null);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('API_KEY_UNAUTHORIZED');
    expect(typeof response.json().error.requestId).toBe('string');
  });

  it('rejects a malformed credential and records a security event', async () => {
    await setup();
    const response = await externalList('not-an-orgistry-key');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('API_KEY_UNAUTHORIZED');
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authMalformed,
      ),
    ).toBe(true);
  });

  it('does NOT accept a browser access token (JWT) as an API key', async () => {
    await setup();
    const user = await registerUser();
    const response = await externalList(user.token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('API_KEY_UNAUTHORIZED');
  });

  it('rejects an unknown (well-formed but unrecognized) key', async () => {
    await setup();
    const stranger = generateApiKeySecret();
    const response = await externalList(stranger.raw);
    expect(response.statusCode).toBe(401);
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authUnknown,
      ),
    ).toBe(true);
  });

  it('rejects a revoked key (auth correctness does not depend on the rate limiter)', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: userAuth(owner.token),
    });

    const response = await externalList(key.secret);
    expect(response.statusCode).toBe(401);
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authRevoked,
      ),
    ).toBe(true);
  });

  it('rejects an expired key and does not update last_used_at', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    // Force expiry in the past.
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === key.id)!;
    stored.expiresAt = new Date(Date.now() - 1000);

    const response = await externalList(key.secret);
    expect(response.statusCode).toBe(401);
    expect(stored.lastUsedAt).toBeNull();
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authExpired,
      ),
    ).toBe(true);
  });

  it('rejects a key whose organization is no longer active', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    ctx.orgStore.organizations.find((o) => o.id === orgId)!.status =
      'archived' as never;

    const response = await externalList(key.secret);
    expect(response.statusCode).toBe(401);
    expect(
      ctx.orgStore.securityEvents.some(
        (e) =>
          e.eventType ===
          API_KEY_SECURITY_EVENT_TYPES.authOrganizationInactive,
      ),
    ).toBe(true);
  });

  it('rejects a key when the plan no longer grants api_keys_access', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId, 'pro');
    const key = await createKey(owner.token, orgId);

    // Downgrade to Free: api_keys_access is now false.
    setPlan(orgId, 'free');

    const response = await externalList(key.secret);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(
      ctx.orgStore.securityEvents.some(
        (e) =>
          e.eventType === API_KEY_SECURITY_EVENT_TYPES.authEntitlementMissing,
      ),
    ).toBe(true);
  });

  it('rejects a key that lacks the projects:read scope', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);

    // Insert a scope-less key directly (the create API cannot make one — only
    // projects:read exists — so this exercises the authenticator's scope gate).
    const generated = generateApiKeySecret();
    const now = new Date();
    const scopeless: ApiKeyRow = {
      id: createId('key'),
      organizationId: orgId,
      name: 'scopeless',
      displayPrefix: generated.displayPrefix,
      secretHash: generated.secretHash,
      scopes: [],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      createdByUserId: owner.userId,
      createdAt: now,
      updatedAt: now,
    };
    ctx.orgStore.apiKeys.push(scopeless);

    const response = await externalList(generated.raw);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('API_KEY_SCOPE_REQUIRED');
    expect(response.json().error.details.requiredScope).toBe('projects:read');
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authScopeMissing,
      ),
    ).toBe(true);
  });
});

describe('GET /v1/external/projects — security event attribution & sanitization', () => {
  it('attributes events safely and never stores token material', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === key.id)!;
    const storedHash = stored.secretHash;
    const keySecretComponent = parseApiKey(key.secret)!.secretComponent;
    const unknown = generateApiKeySecret(); // well-formed, never persisted

    // A malformed attempt (no orgistry_ scheme → fails to parse), an unknown-key
    // attempt (well-formed but unrecognized), then a revoked-key attempt.
    await externalList('not-an-orgistry-key');
    await externalList(unknown.raw);
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/api-keys/${key.id}`,
      headers: userAuth(owner.token),
    });
    await externalList(key.secret);

    const securityEvents = ctx.orgStore.securityEvents.filter((e) =>
      e.eventType.startsWith('api_key.auth'),
    );

    // Malformed: NO invented key attribution (anonymous actor, no key/org id).
    const malformed = securityEvents.find(
      (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authMalformed,
    )!;
    expect(malformed.actorType).toBe('anonymous');
    expect(malformed.organizationId).toBeNull();
    expect(malformed.metadata.targetKeyId).toBeUndefined();

    // Unknown: also no invented attribution.
    const unknownEvent = securityEvents.find(
      (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authUnknown,
    )!;
    expect(unknownEvent.actorType).toBe('anonymous');
    expect(unknownEvent.organizationId).toBeNull();
    expect(unknownEvent.metadata.targetKeyId).toBeUndefined();

    // Revoked: key id and organization id are SAFELY resolved, so they appear.
    const revokedEvent = securityEvents.find(
      (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.authRevoked,
    )!;
    expect(revokedEvent.actorType).toBe('api_key');
    expect(revokedEvent.organizationId).toBe(orgId);
    expect(revokedEvent.metadata.targetKeyId).toBe(key.id);

    // No raw secret, secret component, hash, or Authorization material anywhere.
    const allJson = JSON.stringify(securityEvents).toLowerCase();
    expect(allJson).not.toContain(key.secret.toLowerCase());
    expect(allJson).not.toContain(keySecretComponent.toLowerCase());
    expect(allJson).not.toContain(unknown.raw.toLowerCase());
    expect(allJson).not.toContain(storedHash.toLowerCase());
    expect(allJson).not.toContain('authorization');
    expect(allJson).not.toContain('bearer ');
    expect(allJson).not.toContain('secret_hash');
  });
});

describe('GET /v1/external/projects — reads', () => {
  it('returns ONLY the key organization\'s active projects (tenant derived from key, no org id in route)', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    await createProject(owner.token, orgId, 'Alpha');
    const dropId = await createProject(owner.token, orgId, 'Drop');
    await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${dropId}`,
      headers: userAuth(owner.token),
    });

    // A different organization whose projects must never appear.
    const other = await registerUser();
    const otherOrgId = await createTeamOrg(other.token, 'Other');
    setPlan(otherOrgId);
    await createProject(other.token, otherOrgId, 'Foreign');

    const key = await createKey(owner.token, orgId);
    const response = await externalList(key.secret);
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items as Array<Record<string, unknown>>;
    const names = items.map((p) => p.name);
    expect(names).toContain('Alpha');
    expect(names).not.toContain('Drop'); // soft-deleted, omitted
    expect(names).not.toContain('Foreign'); // other tenant

    // Every returned project belongs to the key's org, and the DTO exposes no
    // internal/persistence fields.
    for (const item of items) {
      expect(item.organizationId).toBe(orgId);
    }
    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain('deletedAt');
    expect(raw).not.toContain('deleted_at');
    expect(raw).not.toContain('createdByUserId');
  });

  it('paginates with an opaque cursor', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    for (let i = 0; i < 4; i += 1) {
      await createProject(owner.token, orgId, `P${i}`);
    }
    const key = await createKey(owner.token, orgId);

    const first = await externalList(key.secret, '?limit=2');
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items).toHaveLength(2);
    expect(first.json().data.hasMore).toBe(true);
    const cursor = first.json().data.nextCursor;

    const second = await externalList(
      key.secret,
      `?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    const firstIds = first.json().data.items.map((p: { id: string }) => p.id);
    const secondIds = second.json().data.items.map((p: { id: string }) => p.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('only exposes a read surface (no create/update/delete on the external path)', async () => {
    await setup();
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/external/projects',
        headers: keyAuth(key.secret),
        payload: { name: 'nope' },
      });
      // No such route is registered → 404 from the router (never a write).
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('GET /v1/external/projects — last-used throttling', () => {
  it('updates last_used_at on first use, throttles within the window, writes again after it', async () => {
    let nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    const clock = {
      now: () => new Date(nowMs),
      epochMillis: () => nowMs,
    };
    await setup({ clock, lastUsedThrottleSeconds: 60 });

    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);
    const stored = ctx.orgStore.apiKeys.find((k) => k.id === key.id)!;

    // First use writes last_used_at.
    await externalList(key.secret);
    const firstUsedAt = stored.lastUsedAt?.getTime();
    expect(firstUsedAt).toBe(nowMs);

    // A second use 30s later is INSIDE the 60s window → no write.
    nowMs += 30_000;
    await externalList(key.secret);
    expect(stored.lastUsedAt?.getTime()).toBe(firstUsedAt);

    // Past the window → a fresh write.
    nowMs += 40_000; // total 70s since first use
    await externalList(key.secret);
    expect(stored.lastUsedAt?.getTime()).toBe(nowMs);
  });
});

describe('GET /v1/external/projects — rate limits (Redis-backed limiter)', () => {
  it('enforces the per-key bucket and returns RATE_LIMITED with a request id', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      externalRateLimits: {
        windowSeconds: 60,
        perKeyMax: 2,
        perOrgMax: 1000,
      },
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const key = await createKey(owner.token, orgId);

    expect((await externalList(key.secret)).statusCode).toBe(200);
    expect((await externalList(key.secret)).statusCode).toBe(200);
    const third = await externalList(key.secret);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    expect(typeof third.json().error.requestId).toBe('string');
    expect(
      ctx.orgStore.securityEvents.some(
        (e) => e.eventType === API_KEY_SECURITY_EVENT_TYPES.rateLimitExceeded,
      ),
    ).toBe(true);
  });

  it('enforces the per-organization bucket across multiple keys', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      externalRateLimits: {
        windowSeconds: 60,
        perKeyMax: 1000,
        perOrgMax: 2,
      },
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);
    const keyA = await createKey(owner.token, orgId);
    const keyB = await createKey(owner.token, orgId);

    // Two different keys share the per-organization bucket.
    expect((await externalList(keyA.secret)).statusCode).toBe(200);
    expect((await externalList(keyB.secret)).statusCode).toBe(200);
    const third = await externalList(keyA.secret);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });
});
