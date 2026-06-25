import { ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordedSecurityEvent } from '../organization/testing/in-memory-org-store';
import {
  buildAuditTestApp,
  type AuditTestContext,
} from './testing/build-audit-test-app';

/**
 * End-to-end Audit Log read behavior, exercised through `app.inject` over the
 * shared in-memory store. Covers authentication, the INDEPENDENT permission +
 * entitlement gates, cross-tenant isolation, cursor pagination, stable ordering,
 * filters, metadata sanitization, retention metadata, and the action/security
 * event boundary. Every assertion proves BACKEND enforcement.
 */
let ctx: AuditTestContext;
let app: FastifyInstance;
let emailSeq = 0;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(displayName = 'Audit User'): Promise<TestUser> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `audit.user.${emailSeq}@example.com`,
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

/** Enable `audit_log_access` by moving the org to the Business demo plan. */
async function enableAudit(
  ownerToken: string,
  orgId: string,
  planKey: 'pro' | 'business' = 'business',
): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/v1/organizations/${orgId}/plan/demo`,
    headers: authHeader(ownerToken),
    payload: { planKey },
  });
  expect(response.statusCode).toBe(200);
}

/** Seed an active membership directly (mirrors the projects test convention). */
function addMembership(orgId: string, userId: string, roleId: string): void {
  const now = new Date();
  ctx.orgStore.memberships.push({
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

/**
 * Clear the recorded-event slate. Enabling audit access changes the demo plan,
 * which itself records a real `plan.changed_demo` action event; tests that
 * assert exact counts over explicitly seeded events reset first so that setup
 * event does not skew them. (A dedicated test below asserts that real producer
 * events DO surface, without resetting.)
 */
function resetEvents(): void {
  ctx.orgStore.securityEvents.length = 0;
}

const BASE_MS = Date.parse('2026-06-01T00:00:00.000Z');
let seedSeq = 0;

/** Seed an audit event directly into the store with explicit id + createdAt. */
function seedEvent(
  orgId: string,
  overrides: Partial<RecordedSecurityEvent> = {},
): string {
  seedSeq += 1;
  const id = overrides.id ?? `sevt_seed_${seedSeq}`;
  const event: RecordedSecurityEvent = {
    id,
    userId: 'user_seed',
    organizationId: orgId,
    actorType: 'user',
    eventType: 'project.created',
    metadata: { targetType: 'project', targetProjectId: `prj_${seedSeq}` },
    requestId: `req_${seedSeq}`,
    createdAt: new Date(BASE_MS + seedSeq * 1000),
    ...overrides,
  };
  ctx.orgStore.securityEvents.push(event);
  return id;
}

async function listAudit(
  token: string,
  orgId: string,
  query = '',
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'GET',
    url: `/v1/organizations/${orgId}/audit-events${query}`,
    headers: authHeader(token),
  });
}

beforeEach(async () => {
  ctx = await buildAuditTestApp();
  app = ctx.app;
  seedSeq = 0;
});

afterEach(async () => {
  await app.close();
});

describe('GET …/audit-events — authentication & gates', () => {
  it('requires a Bearer token', async () => {
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-events`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires active membership (non-member gets a safe 404)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    const outsider = await registerUser('Outsider');
    const response = await listAudit(outsider.token, orgId);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('requires the audit_events.read permission (entitlement present, permission missing)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);

    // A member has audit_log_access (org-level) but NOT audit_events.read.
    const member = await registerUser('Member');
    addMembership(orgId, member.userId, ROLE_IDS.member);

    const response = await listAudit(member.token, orgId);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('requires the audit_log_access entitlement (permission present, entitlement missing)', async () => {
    // Owner HAS audit_events.read, but the default Free plan lacks audit access.
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    const response = await listAudit(owner.token, orgId);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(response.json().error.details).toMatchObject({
      entitlement: 'audit_log_access',
    });
  });

  it('lets an authorized AND entitled user read audit events', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    resetEvents();
    seedEvent(orgId);

    const response = await listAudit(owner.token, orgId);
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces a REAL producer action event end-to-end (no seeding)', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    // Enabling audit access itself records a real plan.changed_demo action event.
    await enableAudit(owner.token, orgId);

    const response = await listAudit(owner.token, orgId);
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items;
    const planEvent = items.find(
      (e: { type: string }) => e.type === 'plan.changed_demo',
    );
    expect(planEvent).toBeDefined();
    expect(planEvent.target).toEqual({
      type: 'plan',
      id: null,
      label: 'business',
    });
    expect(planEvent.actor.type).toBe('user');
  });

  it('includes the originating request id in error envelopes', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-events`,
      headers: { ...authHeader(owner.token), 'x-request-id': 'req-test-1' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['x-request-id']).toBe('req-test-1');
  });
});

describe('GET …/audit-events — tenant isolation', () => {
  it('returns only events for the route organization', async () => {
    const owner = await registerUser('Owner');
    const orgA = await createTeamOrg(owner.token, 'Acme A');
    const orgB = await createTeamOrg(owner.token, 'Acme B');
    await enableAudit(owner.token, orgA);
    await enableAudit(owner.token, orgB);
    resetEvents();

    const aId = seedEvent(orgA, { metadata: { targetProjectId: 'prj_A' } });
    seedEvent(orgB, { metadata: { targetProjectId: 'prj_B' } });

    const response = await listAudit(owner.token, orgA);
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(aId);
    expect(items[0].organizationId).toBe(orgA);
  });

  it('cross-tenant filters cannot leak another org’s events', async () => {
    const owner = await registerUser('Owner');
    const orgA = await createTeamOrg(owner.token, 'Acme A');
    const orgB = await createTeamOrg(owner.token, 'Acme B');
    await enableAudit(owner.token, orgA);
    resetEvents();

    seedEvent(orgB, { metadata: { targetProjectId: 'prj_secret' } });

    // Even filtering by a target id that exists in B returns nothing from A.
    const response = await listAudit(
      owner.token,
      orgA,
      '?targetId=prj_secret',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(0);
  });
});

describe('GET …/audit-events — pagination & ordering', () => {
  async function setupOrgWithEvents(count: number): Promise<{
    token: string;
    orgId: string;
  }> {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    resetEvents();
    for (let i = 0; i < count; i += 1) {
      seedEvent(orgId);
    }
    return { token: owner.token, orgId };
  }

  it('enforces the default page limit', async () => {
    const { token, orgId } = await setupOrgWithEvents(25);
    const response = await listAudit(token, orgId);
    const data = response.json().data;
    expect(data.items).toHaveLength(20);
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).not.toBeNull();
  });

  it('enforces the maximum page limit', async () => {
    const { token, orgId } = await setupOrgWithEvents(1);
    const tooBig = await listAudit(token, orgId, '?limit=101');
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error.code).toBe('VALIDATION_ERROR');
    const ok = await listAudit(token, orgId, '?limit=100');
    expect(ok.statusCode).toBe(200);
  });

  it('orders events created_at DESC, id DESC', async () => {
    const { token, orgId } = await setupOrgWithEvents(5);
    const response = await listAudit(token, orgId, '?limit=100');
    const items = response.json().data.items;
    const times = items.map((e: { createdAt: string }) =>
      Date.parse(e.createdAt),
    );
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it('rejects a malformed cursor with a predictable error', async () => {
    const { token, orgId } = await setupOrgWithEvents(1);
    const response = await listAudit(token, orgId, '?cursor=not-a-real-cursor');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('paginates with no duplicate and no skipped events', async () => {
    const { token, orgId } = await setupOrgWithEvents(25);
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const query: string =
        `?limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const response = await listAudit(token, orgId, query);
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      for (const item of data.items) {
        seen.push(item.id);
      }
      cursor = data.nextCursor;
      guard += 1;
      expect(guard).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('GET …/audit-events — filters', () => {
  async function setupOrg(): Promise<{ token: string; orgId: string }> {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    resetEvents();
    return { token: owner.token, orgId };
  }

  it('filters by event type (public name maps to persisted name)', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, { eventType: 'project.created' });
    seedEvent(orgId, {
      eventType: 'org.member_role_changed',
      metadata: { membershipId: 'mem_1' },
    });

    const response = await listAudit(
      token,
      orgId,
      '?eventType=member.role_changed',
    );
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('member.role_changed');
  });

  it('filters by actor type', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, { actorType: 'user' });
    seedEvent(orgId, { actorType: 'anonymous', userId: null });

    const userOnly = await listAudit(token, orgId, '?actorType=user');
    expect(userOnly.json().data.items).toHaveLength(1);
    expect(userOnly.json().data.items[0].actor.type).toBe('user');

    const unknownOnly = await listAudit(token, orgId, '?actorType=unknown');
    expect(unknownOnly.json().data.items).toHaveLength(1);
    expect(unknownOnly.json().data.items[0].actor.type).toBe('unknown');
  });

  it('filters by target type', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, {
      eventType: 'project.created',
      metadata: { targetProjectId: 'prj_1' },
    });
    seedEvent(orgId, {
      eventType: 'api_key.created',
      metadata: { targetKeyId: 'key_1' },
    });

    const projects = await listAudit(token, orgId, '?targetType=project');
    expect(projects.json().data.items).toHaveLength(1);
    expect(projects.json().data.items[0].target.type).toBe('project');

    const keys = await listAudit(token, orgId, '?targetType=api_key');
    expect(keys.json().data.items).toHaveLength(1);
    expect(keys.json().data.items[0].target.type).toBe('api_key');
  });

  it('returns an empty page when a target-type filter selects no event kind', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId);
    const response = await listAudit(token, orgId, '?targetType=organization');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(0);
  });

  it('filters by created-after and created-before', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, {
      id: 'old',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedEvent(orgId, {
      id: 'new',
      createdAt: new Date('2026-12-01T00:00:00.000Z'),
    });

    const after = await listAudit(
      token,
      orgId,
      '?createdAfter=2026-06-01T00:00:00.000Z',
    );
    expect(after.json().data.items.map((e: { id: string }) => e.id)).toEqual([
      'new',
    ]);

    const before = await listAudit(
      token,
      orgId,
      '?createdBefore=2026-06-01T00:00:00.000Z',
    );
    expect(before.json().data.items.map((e: { id: string }) => e.id)).toEqual([
      'old',
    ]);
  });

  it('filters by actor id (optional filter)', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, { userId: 'user_a' });
    seedEvent(orgId, { userId: 'user_b' });

    const response = await listAudit(token, orgId, '?actorId=user_a');
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].actor.userId).toBe('user_a');
  });

  it('filters by target id (optional filter)', async () => {
    const { token, orgId } = await setupOrg();
    seedEvent(orgId, { metadata: { targetProjectId: 'prj_target' } });
    seedEvent(orgId, { metadata: { targetProjectId: 'prj_other' } });

    const response = await listAudit(token, orgId, '?targetId=prj_target');
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].target.id).toBe('prj_target');
  });
});

describe('GET …/audit-events — metadata sanitization', () => {
  it('redacts sensitive top-level and nested metadata keys', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    resetEvents();
    seedEvent(orgId, {
      metadata: {
        name: 'Launch',
        token: 'raw-token-value',
        tokenHash: 'hash-value',
        secret: 'secret-value',
        apiKeySecret: 'aks',
        invitationTokenHash: 'ith',
        nested: { password: 'pw', cookie: 'sid=1', keep: 'ok' },
        requestBody: { authorization: 'Bearer leak', refreshToken: 'rt' },
      },
    });

    const response = await listAudit(owner.token, orgId);
    const item = response.json().data.items[0];
    expect(item.metadata.name).toBe('Launch');
    expect(item.metadata.nested).toEqual({ keep: 'ok' });

    const serialized = JSON.stringify(item).toLowerCase();
    for (const leak of [
      'raw-token-value',
      'hash-value',
      'secret-value',
      'bearer leak',
      'sid=1',
      'pw',
      'rt',
    ]) {
      expect(serialized).not.toContain(leak.toLowerCase());
    }
  });
});

describe('GET …/audit-events — retention metadata', () => {
  it('returns audit_retention_days resolved from the plan entitlements', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');

    await enableAudit(owner.token, orgId, 'business');
    const business = await listAudit(owner.token, orgId);
    expect(business.json().data.meta.auditRetentionDays).toBe(90);

    await enableAudit(owner.token, orgId, 'pro');
    const pro = await listAudit(owner.token, orgId);
    expect(pro.json().data.meta.auditRetentionDays).toBe(30);
  });
});

describe('GET …/audit-events — action/security boundary', () => {
  it('excludes auth/session and api-key auth-failure security events', async () => {
    const owner = await registerUser('Owner');
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await enableAudit(owner.token, orgId);
    resetEvents();

    const actionId = seedEvent(orgId, { eventType: 'project.created' });
    // Security events, even if attributed to the org, must never appear.
    seedEvent(orgId, {
      eventType: 'auth.login_succeeded',
      actorType: 'user',
    });
    seedEvent(orgId, {
      eventType: 'api_key.auth_unknown',
      actorType: 'anonymous',
      userId: null,
    });

    const response = await listAudit(owner.token, orgId);
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(actionId);
    expect(items[0].type).toBe('project.created');
  });
});
