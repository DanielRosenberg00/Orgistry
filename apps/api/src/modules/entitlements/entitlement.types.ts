import type { PlanKey } from '@orgistry/contracts';

/**
 * Internal entitlements-module types.
 *
 * The persistence rows (`PlanRow`, `OrganizationPlanRow`) live in `@orgistry/db`
 * and are used INSIDE this module only; they are never returned from a route —
 * the service maps an organization's plan state to resolved entitlement VALUES
 * (from the fixed catalog) and to the public `@orgistry/contracts` DTOs first.
 */

/**
 * An organization's current plan state, normalized for the service layer. This
 * is plan STATE, not a billing subscription — there is no provider, status,
 * period, or price. `changedByUserId` records who last set the plan.
 */
export interface OrganizationPlanState {
  organizationId: string;
  planKey: PlanKey;
  assignedAt: Date;
  updatedAt: Date;
  changedByUserId: string | null;
}

/**
 * Server-derived actor identity for a plan mutation. Resolved from the
 * authenticated user + organization membership; never supplied by the client.
 */
export interface PlanChangeActor {
  userId: string;
  membershipId: string;
}

/** Per-request, non-secret metadata attached to a plan action event. */
export interface PlanActionContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Inputs for a transactional demo plan change. */
export interface ChangeOrganizationPlanParams {
  organizationId: string;
  /** The validated target plan key (one of the fixed catalog keys). */
  targetPlanKey: PlanKey;
  actor: PlanChangeActor;
  ctx: PlanActionContext;
}

/** Result of a demo plan change: the previous key and the updated state. */
export interface ChangeOrganizationPlanResult {
  previousPlanKey: PlanKey;
  planState: OrganizationPlanState;
}

/**
 * Persistence boundary for entitlement/quota resolution and the demo plan
 * change. Defined as an interface so the service is unit-testable with an
 * in-memory fake and all plan SQL stays in `plan.repo.ts`.
 *
 * The repository may READ plan state and COUNT resources. It does NOT own
 * entitlement or quota POLICY — comparing counts to plan limits is the service's
 * job (see `entitlement.service.ts`). Counting lives here only because counting
 * is a data operation; the limit and the comparison never do.
 */
export interface EntitlementRepository {
  /** The organization's current plan state, or null when none exists. */
  findOrganizationPlanState(
    organizationId: string,
  ): Promise<OrganizationPlanState | null>;

  /** Count the organization's ACTIVE (non-deleted) projects. */
  countActiveProjects(organizationId: string): Promise<number>;

  /** Count the organization's ACTIVE memberships (removed members excluded). */
  countActiveMembers(organizationId: string): Promise<number>;

  /**
   * Change the organization's plan to `targetPlanKey` and record a
   * `plan.changed_demo` action event in the SAME transaction. Returns the
   * previous plan key and the updated state. Throws `PLAN_STATE_MISSING` when
   * the organization has no plan state to update.
   */
  changeOrganizationPlan(
    params: ChangeOrganizationPlanParams,
  ): Promise<ChangeOrganizationPlanResult>;
}
