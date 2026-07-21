import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { registerTestUser } from '../auth/testing/register-test-user';
import {
  createInMemoryRateLimiter,
  createUnavailableRateLimiter,
} from '../../lib/rate-limit';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from './testing/build-organization-test-app';

/**
 * Authenticated mutation throttling — organization creation (Sprint 19,
 * ORG-PR-032). User-scoped bucket: creation provisions an organization, an
 * Owner membership, and plan state on every call. Thresholds are injected;
 * production values are never lowered for tests.
 */

let ctx: OrganizationTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function registerUser(): Promise<{ token: string }> {
  emailSeq += 1;
  const { accessToken } = await registerTestUser(app, ctx!.mailer, {
    email: `org.throttle.${emailSeq}@example.com`,
    password: 'a-strong-password-123',
    displayName: 'Org Throttler',
  });
  return { token: accessToken };
}

function createOrg(token: string, name: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
}

describe('POST /v1/organizations — per-user mutation throttle', () => {
  it('allows creation up to the per-user limit, then returns the standard envelope', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      orgRateLimits: { windowSeconds: 60, createPerUserMax: 2 },
    });
    app = ctx.app;
    const user = await registerUser();

    expect((await createOrg(user.token, 'One')).statusCode).toBe(201);
    expect((await createOrg(user.token, 'Two')).statusCode).toBe(201);
    const third = await createOrg(user.token, 'Three');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    expect(typeof third.json().error.requestId).toBe('string');
  });

  it('isolates buckets between users — one user at the limit never throttles another', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      orgRateLimits: { windowSeconds: 60, createPerUserMax: 1 },
    });
    app = ctx.app;
    const heavy = await registerUser();
    const light = await registerUser();

    expect((await createOrg(heavy.token, 'Heavy One')).statusCode).toBe(201);
    expect((await createOrg(heavy.token, 'Heavy Two')).statusCode).toBe(429);
    // The other user's bucket is untouched.
    expect((await createOrg(light.token, 'Light One')).statusCode).toBe(201);
  });

  it('still requires authentication before the limiter can be observed', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      orgRateLimits: { windowSeconds: 60, createPerUserMax: 1 },
    });
    app = ctx.app;

    const unauthenticated = await createOrg('not-a-real-token', 'Nope');
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe('UNAUTHORIZED');
  });

  it('fails closed on a limiter-store outage in production-like mode', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createUnavailableRateLimiter(),
      orgRateLimits: { windowSeconds: 60, createPerUserMax: 100 },
      rateLimitFailureMode: 'closed',
    });
    app = ctx.app;
    const user = await registerUser();

    const response = await createOrg(user.token, 'Blocked');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('member role-change/removal — per-acting-user throttle (Sprint 19 refinement)', () => {
  /** Seed an extra active member directly into the shared store. */
  function addMember(orgId: string): string {
    const now = new Date();
    const userId = createId('user');
    const membershipId = createId('mem');
    ctx!.orgStore.users.push({
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
    ctx!.orgStore.memberships.push({
      id: membershipId,
      userId,
      organizationId: orgId,
      roleId: ROLE_IDS.member,
      status: 'active',
      invitedByUserId: null,
      joinedAt: now,
      removedAt: null,
      removedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
    return membershipId;
  }

  function changeRole(token: string, orgId: string, membershipId: string, role: string) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${membershipId}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role },
    });
  }

  it('limits repeated role changes and removals through one shared bucket', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      memberRateLimits: { windowSeconds: 60, mutationPerUserMax: 2 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgResponse = await createOrg(owner.token, 'Acme');
    expect(orgResponse.statusCode).toBe(201);
    const orgId = orgResponse.json().data.organization.id;
    const membershipId = addMember(orgId);

    expect((await changeRole(owner.token, orgId, membershipId, 'admin')).statusCode).toBe(200);
    expect((await changeRole(owner.token, orgId, membershipId, 'member')).statusCode).toBe(200);

    // Third member-admin mutation in the window — role change OR removal —
    // trips the shared bucket.
    const removal = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${membershipId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(removal.statusCode).toBe(429);
    expect(removal.json().error.code).toBe('RATE_LIMITED');
  });

  it('preserves permission-first behavior: a non-member sees 404, never 429', async () => {
    ctx = await buildOrganizationTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      memberRateLimits: { windowSeconds: 60, mutationPerUserMax: 1 },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgResponse = await createOrg(owner.token, 'Acme');
    const orgId = orgResponse.json().data.organization.id;
    const membershipId = addMember(orgId);
    await changeRole(owner.token, orgId, membershipId, 'admin'); // exhaust

    const outsider = await registerUser();
    const denied = await changeRole(outsider.token, orgId, membershipId, 'member');
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
