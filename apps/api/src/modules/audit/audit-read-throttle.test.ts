import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import { registerTestUser } from '../auth/testing/register-test-user';
import {
  buildAuditTestApp,
  type AuditTestContext,
} from './testing/build-audit-test-app';

/**
 * Audit-log READ throttling (Sprint 22, ORG-PR-055).
 *
 * The audit list is the only read whose cost is not bounded by its page size:
 * the `targetId` filter compares against un-indexed JSONB metadata keys, so a
 * filter that matches nothing walks the organization's whole slice of
 * `security_events`. These tests prove the two ceilings fire, that they are
 * scoped to the dimensions they claim, that legitimate reading stays possible
 * below them, and that throttling never precedes (and so never leaks) an
 * authorization decision.
 */

let ctx: AuditTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(): Promise<TestUser> {
  emailSeq += 1;
  const result = await registerTestUser(app, ctx!.mailer, {
    email: `audit.throttle.${emailSeq}@example.com`,
    password: 'a-strong-password-123',
    displayName: 'Audit Reader',
  });
  return { token: result.accessToken, userId: result.userId };
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

/** Enable `audit_log_access` by moving the org to the Business demo plan. */
async function enableAudit(ownerToken: string, orgId: string): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/v1/organizations/${orgId}/plan/demo`,
    headers: authHeader(ownerToken),
    payload: { planKey: 'business' },
  });
  expect(response.statusCode).toBe(200);
}

/** Seed an active membership directly (mirrors the audit route test convention). */
function addMembership(orgId: string, userId: string, roleId: string): void {
  const now = new Date();
  ctx!.orgStore.memberships.push({
    id: createId('mem'),
    userId,
    organizationId: orgId,
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

function listAudit(token: string, orgId: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/organizations/${orgId}/audit-events${query}`,
    headers: authHeader(token),
  });
}

describe('GET /v1/organizations/:id/audit-events — read throttling', () => {
  it('limits one actor to the configured per-user ceiling with the standard envelope', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 2,
        perOrgMax: 100,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    expect((await listAudit(owner.token, orgId)).statusCode).toBe(200);
    expect((await listAudit(owner.token, orgId)).statusCode).toBe(200);

    const limited = await listAudit(owner.token, orgId);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('bounds the expensive targetId filter, not just unfiltered pages', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 1,
        perOrgMax: 100,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    // A targetId that matches nothing is the worst case: it scans the whole
    // organization slice and returns an empty page.
    const scan = await listAudit(owner.token, orgId, '?targetId=prj_nonexistent');
    expect(scan.statusCode).toBe(200);
    expect(scan.json().data.items).toEqual([]);

    const limited = await listAudit(owner.token, orgId, '?targetId=prj_other');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('isolates per-user buckets between members of the same organization', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 1,
        perOrgMax: 100,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    const admin = await registerUser();
    addMembership(orgId, admin.userId, ROLE_IDS.admin);

    expect((await listAudit(owner.token, orgId)).statusCode).toBe(200);
    expect((await listAudit(owner.token, orgId)).statusCode).toBe(429);
    // A different member's allowance is untouched — one noisy client cannot
    // deny the audit surface to their colleagues.
    expect((await listAudit(admin.token, orgId)).statusCode).toBe(200);
  });

  it('applies the per-organization ceiling across distinct members', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 100,
        perOrgMax: 2,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    const admin = await registerUser();
    addMembership(orgId, admin.userId, ROLE_IDS.admin);

    expect((await listAudit(owner.token, orgId)).statusCode).toBe(200);
    expect((await listAudit(admin.token, orgId)).statusCode).toBe(200);
    // Both members are well under their own ceilings; the tenant bucket is what
    // stops the third read.
    const limited = await listAudit(owner.token, orgId);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('isolates buckets between organizations', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 100,
        perOrgMax: 1,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgA = await createTeamOrg(owner.token, 'Org A');
    const orgB = await createTeamOrg(owner.token, 'Org B');
    await enableAudit(owner.token, orgA);
    await enableAudit(owner.token, orgB);

    expect((await listAudit(owner.token, orgA)).statusCode).toBe(200);
    expect((await listAudit(owner.token, orgA)).statusCode).toBe(429);
    // The second organization's bucket is untouched.
    expect((await listAudit(owner.token, orgB)).statusCode).toBe(200);
  });

  it('leaves legitimate reading possible below the ceiling', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 5,
        perOrgMax: 100,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await listAudit(owner.token, orgId);
      expect(response.statusCode).toBe(200);
    }
  });

  it('preserves gate-first behavior: a non-member sees 404, never 429', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 1,
        perOrgMax: 1,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    // Exhaust both buckets for this organization.
    expect((await listAudit(owner.token, orgId)).statusCode).toBe(200);

    const outsider = await registerUser();
    const denied = await listAudit(outsider.token, orgId);
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('preserves entitlement-first behavior: a member without the plan sees 403, never 429', async () => {
    ctx = await buildAuditTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      auditReadRateLimits: {
        windowSeconds: 60,
        perUserMax: 1,
        perOrgMax: 1,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // Audit access is deliberately NOT enabled: the org stays on the Free plan.

    const first = await listAudit(owner.token, orgId);
    expect(first.statusCode).toBe(403);
    expect(first.json().error.code).toBe('ENTITLEMENT_REQUIRED');

    // Repeated denials keep returning the entitlement error: the limiter sits
    // behind the gate, so a blocked caller never consumes the allowance and
    // never learns the ceiling exists.
    const second = await listAudit(owner.token, orgId);
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('ENTITLEMENT_REQUIRED');
  });
});
