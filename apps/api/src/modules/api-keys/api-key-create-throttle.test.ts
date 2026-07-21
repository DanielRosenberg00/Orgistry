import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerTestUser } from '../auth/testing/register-test-user';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import {
  buildApiKeysTestApp,
  type ApiKeysTestContext,
} from './testing/build-api-keys-test-app';

/**
 * Authenticated mutation throttling — API-key creation (Sprint 19,
 * ORG-PR-032). User-scoped bucket: every create mints a live credential and
 * writes an audit event, so a runaway client must hit a wall quickly. The
 * bucket runs AFTER permission AND leaves entitlement/quota behavior intact.
 */

let ctx: ApiKeysTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function registerUser(): Promise<{ token: string }> {
  emailSeq += 1;
  const { accessToken } = await registerTestUser(app, ctx!.mailer, {
    email: `key.throttle.${emailSeq}@example.com`,
    password: 'a-strong-password-123',
    displayName: 'Key Throttler',
  });
  return { token: accessToken };
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

function setPlan(organizationId: string, planKey = 'pro'): void {
  const state = ctx!.orgStore.organizationPlans.find(
    (p) => p.organizationId === organizationId,
  );
  if (!state) {
    throw new Error(`No plan state for organization ${organizationId}.`);
  }
  state.planKey = planKey as typeof state.planKey;
}

function createKey(token: string, orgId: string, name: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/api-keys`,
    headers: authHeader(token),
    payload: { name, scopes: ['projects:read'] },
  });
}

describe('POST /v1/organizations/:id/api-keys — per-user throttle', () => {
  it('limits repeated key creation with the standard envelope, after permission checks', async () => {
    ctx = await buildApiKeysTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      apiKeyMutationRateLimits: { windowSeconds: 60, createPerUserMax: 2 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    setPlan(orgId);

    expect((await createKey(owner.token, orgId, 'k1')).statusCode).toBe(201);
    expect((await createKey(owner.token, orgId, 'k2')).statusCode).toBe(201);
    const third = await createKey(owner.token, orgId, 'k3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');

    // Cross-tenant behavior is unchanged even with an exhausted bucket: an
    // outsider probing this org still gets the uniform 404.
    const outsider = await registerUser();
    const denied = await createKey(outsider.token, orgId, 'nope');
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('keeps entitlement enforcement intact under the limiter (free plan still blocked)', async () => {
    ctx = await buildApiKeysTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      apiKeyMutationRateLimits: { windowSeconds: 60, createPerUserMax: 100 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // No plan upgrade: free lacks api_keys_access.

    const blocked = await createKey(owner.token, orgId, 'k1');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ENTITLEMENT_REQUIRED');
  });
});
