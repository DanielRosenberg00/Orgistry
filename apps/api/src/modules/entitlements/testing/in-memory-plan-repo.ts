import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import { planStateMissingError } from '../entitlement.errors';
import { PLAN_EVENT_TYPES } from '../plan.events';
import type {
  ChangeOrganizationPlanParams,
  ChangeOrganizationPlanResult,
  EntitlementRepository,
  OrganizationPlanState,
} from '../entitlement.types';

/** Stable target type recorded on every plan action event. */
const PLAN_TARGET_TYPE = 'organization_plan';

/**
 * In-memory `EntitlementRepository` for unit/route tests.
 *
 * Mirrors the database repository's observable behavior — plan-state lookup,
 * active-resource counts, the plan-change transition, and the `plan.changed_demo`
 * action-event write — over the shared `InMemoryOrgStore`, so entitlement, quota,
 * and demo plan-change workflows can be exercised end-to-end through the HTTP
 * layer with no PostgreSQL.
 */
export function createInMemoryEntitlementRepository(
  store: InMemoryOrgStore,
): EntitlementRepository {
  function findPlanStateRow(organizationId: string) {
    return store.organizationPlans.find(
      (row) => row.organizationId === organizationId,
    );
  }

  function toPlanState(
    row: NonNullable<ReturnType<typeof findPlanStateRow>>,
  ): OrganizationPlanState {
    return {
      organizationId: row.organizationId,
      planKey: row.planKey,
      assignedAt: row.assignedAt,
      updatedAt: row.updatedAt,
      changedByUserId: row.changedByUserId,
    };
  }

  return {
    async findOrganizationPlanState(organizationId) {
      const row = findPlanStateRow(organizationId);
      return row ? toPlanState(row) : null;
    },

    async countActiveProjects(organizationId) {
      return store.projects.filter(
        (p) => p.organizationId === organizationId && p.deletedAt === null,
      ).length;
    },

    async countActiveMembers(organizationId) {
      return store.memberships.filter(
        (m) => m.organizationId === organizationId && m.status === 'active',
      ).length;
    },

    // Synchronous read-classify-write (no await before the mutation) -> atomic
    // under Node's single-threaded loop, mirroring the DB transaction + row lock.
    async changeOrganizationPlan(
      params: ChangeOrganizationPlanParams,
    ): Promise<ChangeOrganizationPlanResult> {
      const row = findPlanStateRow(params.organizationId);
      if (!row) {
        throw planStateMissingError();
      }

      const previousPlanKey = row.planKey;
      const now = new Date();
      row.planKey = params.targetPlanKey;
      row.changedByUserId = params.actor.userId;
      row.assignedAt = now;
      row.updatedAt = now;

      store.securityEvents.push({
        userId: params.actor.userId,
        organizationId: params.organizationId,
        actorType: 'user',
        eventType: PLAN_EVENT_TYPES.changedDemo,
        metadata: sanitizeSecurityMetadata({
          actorMembershipId: params.actor.membershipId,
          targetType: PLAN_TARGET_TYPE,
          previousPlanKey,
          newPlanKey: params.targetPlanKey,
        }),
        requestId: params.ctx.requestId,
      });

      return { previousPlanKey, planState: toPlanState(row) };
    },
  };
}
