import { PLAN_CATALOG, type PlanKey } from '@orgistry/contracts';
import { type OrganizationRow, ROLE_IDS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  createInMemoryOrgStore,
  provisionDefaultOrganizationPlan,
  type InMemoryOrgStore,
} from '../organization/testing/in-memory-org-store';
import { createEntitlementService } from './entitlement.service';
import { createInMemoryEntitlementRepository } from './testing/in-memory-plan-repo';

/**
 * Entitlement service unit tests over the in-memory repository.
 *
 * Proves the organization-level capability layer in isolation: plan → values
 * resolution for every plan, fail-safe behavior when plan state is missing, and
 * numeric quota enforcement for projects and members. No HTTP, no RBAC — those
 * are layered on by the plan routes.
 */

function makeOrg(store: InMemoryOrgStore, planKey: PlanKey): string {
  const now = new Date();
  const userId = createId('user');
  const org: OrganizationRow = {
    id: createId('org'),
    name: 'Acme',
    slug: `acme-${createId('org').slice(4, 10).toLowerCase()}`,
    type: 'team',
    status: 'active',
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  store.organizations.push(org);
  // Default Free plan state, then set the requested plan to mirror a later change.
  const state = provisionDefaultOrganizationPlan(store, org.id, userId);
  state.planKey = planKey;
  return org.id;
}

function addActiveProjects(
  store: InMemoryOrgStore,
  organizationId: string,
  count: number,
): void {
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    store.projects.push({
      id: createId('prj'),
      organizationId,
      name: `P${i}`,
      createdByUserId: createId('user'),
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function addActiveMembers(
  store: InMemoryOrgStore,
  organizationId: string,
  count: number,
): void {
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    store.memberships.push({
      id: createId('mem'),
      userId: createId('user'),
      organizationId,
      roleId: ROLE_IDS.member,
      status: 'active',
      invitedByUserId: null,
      joinedAt: now,
      removedAt: null,
      removedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function buildService() {
  const store = createInMemoryOrgStore();
  const service = createEntitlementService({
    repo: createInMemoryEntitlementRepository(store),
  });
  return { store, service };
}

describe('resolveEntitlements', () => {
  it.each(['free', 'pro', 'business'] as PlanKey[])(
    'resolves the fixed catalog values for the %s plan',
    async (planKey) => {
      const { store, service } = buildService();
      const orgId = makeOrg(store, planKey);
      const resolution = await service.resolveEntitlements(orgId);
      expect(resolution.planKey).toBe(planKey);
      expect(resolution.values).toEqual(PLAN_CATALOG[planKey].entitlements);
    },
  );

  it('fails safely with PLAN_STATE_MISSING when the organization has no plan state', async () => {
    const { service } = buildService();
    await expect(
      service.resolveEntitlements('org_without_state'),
    ).rejects.toMatchObject({ code: 'PLAN_STATE_MISSING', statusCode: 500 });
  });

  it('does not depend on user role or client state — only the organization id', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'pro');
    // No membership, role, or actor is supplied; resolution still succeeds.
    const resolution = await service.resolveEntitlements(orgId);
    expect(resolution.values.max_projects).toBe(20);
  });
});

describe('requireProjectCreationQuota', () => {
  it('allows when the active project count is below max_projects', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_projects = 3
    addActiveProjects(store, orgId, 2);
    await expect(
      service.requireProjectCreationQuota(orgId),
    ).resolves.toBeUndefined();
  });

  it('rejects with QUOTA_EXCEEDED when the count is at max_projects', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_projects = 3
    addActiveProjects(store, orgId, 3);
    await expect(
      service.requireProjectCreationQuota(orgId),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { quota: 'max_projects', limit: 3, current: 3 },
    });
  });

  it('counts only active projects — soft-deleted ones do not count', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_projects = 3
    addActiveProjects(store, orgId, 3);
    // Soft-delete one: now 2 active, so a creation is allowed again.
    store.projects.find((p) => p.organizationId === orgId)!.deletedAt =
      new Date();
    await expect(
      service.requireProjectCreationQuota(orgId),
    ).resolves.toBeUndefined();
  });

  it('a plan upgrade raises the ceiling and re-allows creation', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free');
    addActiveProjects(store, orgId, 3);
    await expect(
      service.requireProjectCreationQuota(orgId),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    // Upgrade to Pro (max_projects = 20): the same usage now fits.
    store.organizationPlans.find((p) => p.organizationId === orgId)!.planKey =
      'pro';
    await expect(
      service.requireProjectCreationQuota(orgId),
    ).resolves.toBeUndefined();
  });
});

describe('requireMemberAdditionQuota', () => {
  it('allows when the active member count is below max_members', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_members = 3
    addActiveMembers(store, orgId, 2);
    await expect(
      service.requireMemberAdditionQuota(orgId),
    ).resolves.toBeUndefined();
  });

  it('rejects with QUOTA_EXCEEDED when the active member count reaches max_members', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_members = 3
    addActiveMembers(store, orgId, 3);
    await expect(
      service.requireMemberAdditionQuota(orgId),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { quota: 'max_members', limit: 3, current: 3 },
    });
  });

  it('removed memberships do not count toward max_members', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free'); // max_members = 3
    addActiveMembers(store, orgId, 3);
    // Remove one: 2 active remain, so an addition is allowed again.
    const removed = store.memberships.find(
      (m) => m.organizationId === orgId,
    )!;
    removed.status = 'removed';
    removed.removedAt = new Date();
    await expect(
      service.requireMemberAdditionQuota(orgId),
    ).resolves.toBeUndefined();
  });
});

describe('API key & audit entitlement readiness', () => {
  it('resolves api_keys_access / max_api_keys without an API key lifecycle', async () => {
    const { store, service } = buildService();
    const freeOrg = makeOrg(store, 'free');
    const proOrg = makeOrg(store, 'pro');
    expect(await service.resolveApiKeyEntitlements(freeOrg)).toEqual({
      access: false,
      max: 0,
    });
    expect(await service.resolveApiKeyEntitlements(proOrg)).toEqual({
      access: true,
      max: 5,
    });
  });

  it('resolves audit_log_access / audit_retention_days without an audit read API', async () => {
    const { store, service } = buildService();
    const businessOrg = makeOrg(store, 'business');
    expect(await service.resolveAuditEntitlements(businessOrg)).toEqual({
      access: true,
      retentionDays: 90,
    });
  });
});

describe('changePlan', () => {
  it('updates plan state, records plan.changed_demo, and resolves the new entitlements', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free');
    const { result, resolution } = await service.changePlan({
      organizationId: orgId,
      targetPlanKey: 'business',
      actor: { userId: 'user_actor', membershipId: 'mem_actor' },
      ctx: { requestId: 'req_1', ipAddress: null, userAgent: null },
    });

    expect(result.previousPlanKey).toBe('free');
    expect(result.planState.planKey).toBe('business');
    expect(resolution.values).toEqual(PLAN_CATALOG.business.entitlements);

    const events = store.securityEvents.filter(
      (e) => e.eventType === 'plan.changed_demo',
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      previousPlanKey: 'free',
      newPlanKey: 'business',
    });
  });

  it('moves assignedAt forward, bumps updatedAt, and records the actor on a demo change', async () => {
    const { store, service } = buildService();
    const orgId = makeOrg(store, 'free');

    // Pin the provisioned timestamps into the past so the change is observable
    // regardless of clock resolution: assignedAt = "when the CURRENT plan took
    // effect" must advance, and updatedAt must advance with it.
    const past = new Date('2020-01-01T00:00:00.000Z');
    const stateRow = store.organizationPlans.find(
      (p) => p.organizationId === orgId,
    )!;
    stateRow.assignedAt = past;
    stateRow.updatedAt = past;

    const { result } = await service.changePlan({
      organizationId: orgId,
      targetPlanKey: 'pro',
      actor: { userId: 'user_actor', membershipId: 'mem_actor' },
      ctx: { requestId: 'req_1', ipAddress: null, userAgent: null },
    });

    expect(result.planState.assignedAt.getTime()).toBeGreaterThan(
      past.getTime(),
    );
    expect(result.planState.updatedAt.getTime()).toBeGreaterThan(
      past.getTime(),
    );
    // changedByUserId reflects the demo-change actor.
    expect(result.planState.changedByUserId).toBe('user_actor');
  });

  it('fails safely with PLAN_STATE_MISSING when changing a plan that does not exist', async () => {
    const { service } = buildService();
    await expect(
      service.changePlan({
        organizationId: 'org_missing',
        targetPlanKey: 'pro',
        actor: { userId: 'user_actor', membershipId: 'mem_actor' },
        ctx: { requestId: null, ipAddress: null, userAgent: null },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
