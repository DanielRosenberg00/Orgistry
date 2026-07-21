import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerTestUser } from '../auth/testing/register-test-user';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import {
  buildEntitlementsTestApp,
  type EntitlementsTestContext,
} from './testing/build-entitlements-test-app';

/**
 * Authenticated mutation throttling — demo plan change (Sprint 19,
 * ORG-PR-032). Organization-scoped bucket: each change rewrites the org's
 * entitlement state and writes an audit event, and the plan is org state
 * regardless of which member flips it.
 */

let ctx: EntitlementsTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function registerUser(): Promise<{ token: string }> {
  emailSeq += 1;
  const { accessToken } = await registerTestUser(app, ctx!.mailer, {
    email: `plan.throttle.${emailSeq}@example.com`,
    password: 'a-strong-password-123',
    displayName: 'Plan Throttler',
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

function changePlan(token: string, orgId: string, planKey: string) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/organizations/${orgId}/plan/demo`,
    headers: authHeader(token),
    payload: { planKey },
  });
}

describe('PATCH /v1/organizations/:id/plan/demo — per-organization throttle', () => {
  it('limits repeated changes for one organization with the standard envelope', async () => {
    ctx = await buildEntitlementsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      planRateLimits: { windowSeconds: 60, changePerOrgMax: 2 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');

    expect((await changePlan(owner.token, orgId, 'pro')).statusCode).toBe(200);
    expect((await changePlan(owner.token, orgId, 'free')).statusCode).toBe(200);
    const third = await changePlan(owner.token, orgId, 'pro');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });

  it('isolates buckets between organizations', async () => {
    ctx = await buildEntitlementsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      planRateLimits: { windowSeconds: 60, changePerOrgMax: 1 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgA = await createTeamOrg(owner.token, 'Org A');
    const orgB = await createTeamOrg(owner.token, 'Org B');

    expect((await changePlan(owner.token, orgA, 'pro')).statusCode).toBe(200);
    expect((await changePlan(owner.token, orgA, 'free')).statusCode).toBe(429);
    // The second organization's bucket is untouched.
    expect((await changePlan(owner.token, orgB, 'pro')).statusCode).toBe(200);
  });

  it('preserves permission-first behavior: a non-member sees 404, never 429', async () => {
    ctx = await buildEntitlementsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      planRateLimits: { windowSeconds: 60, changePerOrgMax: 1 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // Exhaust the org's bucket.
    await changePlan(owner.token, orgId, 'pro');

    const outsider = await registerUser();
    const denied = await changePlan(outsider.token, orgId, 'free');
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
