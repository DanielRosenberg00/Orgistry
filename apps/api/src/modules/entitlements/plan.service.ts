import {
  PERMISSION_KEYS,
  PLAN_CATALOG,
  type DemoPlanChangeResponse,
  type EntitlementsResponse,
  type OrganizationPlanResponse,
  type Plan,
  type PlanKey,
} from '@orgistry/contracts';
import {
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from '../organization/access-control';
import type { AccessControlRepository } from '../organization/organization.types';
import type {
  EntitlementResolution,
  EntitlementService,
} from './entitlement.service';
import type { OrganizationPlanState, PlanActionContext } from './entitlement.types';

/**
 * Plan & entitlements HTTP workflows (read plan / read entitlements / change
 * demo plan).
 *
 * Every method composes the standard organization-scoped pipeline, then defers
 * capability resolution to the organization-level `EntitlementService`:
 *
 *   requireMembership   (active member of this org? -> OrganizationActor)
 *     -> requirePermission (plan.read | plan.change_demo)
 *       -> EntitlementService (resolve plan/entitlements, or change the plan)
 *         -> map to the public DTO (never a raw plan/plan-state row)
 *
 * The split is deliberate and is the core Sprint 7 separation made concrete:
 *  - PERMISSION is checked here (a user-level capability, by permission key);
 *  - ENTITLEMENT/QUOTA is resolved by the EntitlementService (an
 *    organization-level, plan-derived capability — independent of role).
 *
 * The service never returns a persistence row and never exposes any billing
 * provider state (there is none).
 */

/** Per-request security metadata threaded from the route into action events. */
export interface PlanRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ReadPlanInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
}

export interface ReadEntitlementsInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
}

export interface ChangeDemoPlanInput {
  userId: string;
  organizationId: string;
  targetPlanKey: PlanKey;
  ctx: PlanRequestContext;
}

export interface PlanService {
  getPlan(input: ReadPlanInput): Promise<OrganizationPlanResponse>;
  getEntitlements(input: ReadEntitlementsInput): Promise<EntitlementsResponse>;
  changeDemoPlan(input: ChangeDemoPlanInput): Promise<DemoPlanChangeResponse>;
}

export interface PlanServiceOptions {
  /** Resolves active membership + effective permissions (the org repo satisfies this). */
  accessControl: AccessControlRepository;
  /** Organization-level entitlement/quota/plan capability service. */
  entitlements: EntitlementService;
}

/** Build the public Plan DTO from a plan key using the fixed catalog metadata. */
function toPlanDto(planKey: PlanKey): Plan {
  const entry = PLAN_CATALOG[planKey];
  return { key: entry.key, name: entry.name, description: entry.description };
}

/** Build the organization-plan response from normalized plan state. */
function toOrganizationPlanResponse(
  state: OrganizationPlanState,
): OrganizationPlanResponse {
  return {
    organizationId: state.organizationId,
    plan: toPlanDto(state.planKey),
    assignedAt: state.assignedAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

/** Build the entitlements response from a resolved entitlement set. */
function toEntitlementsResponse(
  organizationId: string,
  resolution: EntitlementResolution,
): EntitlementsResponse {
  return {
    organizationId,
    planKey: resolution.planKey,
    entitlements: resolution.values,
  };
}

export function createPlanService(options: PlanServiceOptions): PlanService {
  const { accessControl, entitlements } = options;

  /** Resolve the actor (active membership + effective permissions) for a request. */
  async function actorFor(input: {
    userId: string;
    organizationId: string;
    requestId: string | null;
  }): Promise<OrganizationActor> {
    return requireMembership(accessControl, {
      userId: input.userId,
      organizationId: input.organizationId,
      requestId: input.requestId,
    });
  }

  return {
    async getPlan(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.planRead);

      const state = await entitlements.getPlanState(actor.organizationId);
      return toOrganizationPlanResponse(state);
    },

    async getEntitlements(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.planRead);

      const resolution = await entitlements.resolveEntitlements(
        actor.organizationId,
      );
      return toEntitlementsResponse(actor.organizationId, resolution);
    },

    async changeDemoPlan(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.planChangeDemo);

      const ctx: PlanActionContext = {
        requestId: input.ctx.requestId,
        ipAddress: input.ctx.ipAddress,
        userAgent: input.ctx.userAgent,
      };
      const { result, resolution } = await entitlements.changePlan({
        organizationId: actor.organizationId,
        targetPlanKey: input.targetPlanKey,
        actor: { userId: actor.userId, membershipId: actor.membershipId },
        ctx,
      });

      return {
        organizationId: actor.organizationId,
        plan: toPlanDto(result.planState.planKey),
        entitlements: resolution.values,
      };
    },
  };
}
