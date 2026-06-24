import type { Database, DbExecutor, OrganizationPlanRow } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import { planStateMissingError } from './entitlement.errors';
import { PLAN_EVENT_TYPES, type PlanEventType } from './plan.events';
import type {
  ChangeOrganizationPlanParams,
  ChangeOrganizationPlanResult,
  EntitlementRepository,
  OrganizationPlanState,
} from './entitlement.types';

/** Stable target type recorded on every plan action event. */
const PLAN_TARGET_TYPE = 'organization_plan';

/** Normalize a persistence row to the service-layer plan-state shape. */
function toPlanState(row: OrganizationPlanRow): OrganizationPlanState {
  return {
    organizationId: row.organizationId,
    planKey: row.planKey,
    assignedAt: row.assignedAt,
    updatedAt: row.updatedAt,
    changedByUserId: row.changedByUserId,
  };
}

/**
 * Drizzle-backed implementation of the entitlement persistence boundary. All
 * plan-state SQL and the resource COUNTS quota resolution needs live here; the
 * service depends only on `EntitlementRepository`.
 *
 * This repository counts and writes data. It does NOT own entitlement or quota
 * policy — it never compares a count to a plan limit. Counting active projects
 * and active members lives here only because counting is a data operation.
 */
export function createDbEntitlementRepository(
  db: Database,
): EntitlementRepository {
  /**
   * Record a plan action event in the SAME transaction as the plan-state
   * mutation, on the existing organization-scoped `security_events` seam. Actor
   * membership, target type, and the plan transition live in sanitized metadata;
   * secrets never appear here.
   */
  async function recordPlanEvent(
    executor: DbExecutor,
    input: {
      organizationId: string;
      eventType: PlanEventType;
      actorUserId: string;
      actorMembershipId: string;
      previousPlanKey: string;
      newPlanKey: string;
      ctx: ChangeOrganizationPlanParams['ctx'];
    },
  ): Promise<void> {
    await executor.insert(schema.securityEvents).values({
      id: createId('sevt'),
      userId: input.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata({
        actorMembershipId: input.actorMembershipId,
        targetType: PLAN_TARGET_TYPE,
        previousPlanKey: input.previousPlanKey,
        newPlanKey: input.newPlanKey,
      }),
      ipAddress: input.ctx.ipAddress,
      userAgent: input.ctx.userAgent,
      requestId: input.ctx.requestId,
    });
  }

  return {
    async findOrganizationPlanState(organizationId) {
      const [row] = await db
        .select()
        .from(schema.organizationPlans)
        .where(eq(schema.organizationPlans.organizationId, organizationId))
        .limit(1);
      return row ? toPlanState(row) : null;
    },

    async countActiveProjects(organizationId) {
      const [row] = await db
        .select({ value: count() })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, organizationId),
            isNull(schema.projects.deletedAt),
          ),
        );
      return row?.value ?? 0;
    },

    async countActiveMembers(organizationId) {
      const [row] = await db
        .select({ value: count() })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.organizationId, organizationId),
            eq(schema.memberships.status, 'active'),
          ),
        );
      return row?.value ?? 0;
    },

    async changeOrganizationPlan(
      params: ChangeOrganizationPlanParams,
    ): Promise<ChangeOrganizationPlanResult> {
      return db.transaction(async (tx) => {
        // Lock the plan-state row so concurrent demo changes serialize and the
        // recorded previous->new transition is always consistent.
        const [current] = await tx
          .select()
          .from(schema.organizationPlans)
          .where(
            eq(schema.organizationPlans.organizationId, params.organizationId),
          )
          .for('update')
          .limit(1);
        if (!current) {
          throw planStateMissingError();
        }

        const previousPlanKey = current.planKey;
        const now = new Date();
        const [updated] = await tx
          .update(schema.organizationPlans)
          .set({
            planKey: params.targetPlanKey,
            changedByUserId: params.actor.userId,
            // `assignedAt` marks when the CURRENT plan took effect.
            assignedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.organizationPlans.id, current.id))
          .returning();

        await recordPlanEvent(tx, {
          organizationId: params.organizationId,
          eventType: PLAN_EVENT_TYPES.changedDemo,
          actorUserId: params.actor.userId,
          actorMembershipId: params.actor.membershipId,
          previousPlanKey,
          newPlanKey: params.targetPlanKey,
          ctx: params.ctx,
        });

        return { previousPlanKey, planState: toPlanState(updated) };
      });
    },
  };
}
