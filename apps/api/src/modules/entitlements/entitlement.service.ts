import {
  ENTITLEMENT_KEYS,
  entitlementsForPlan,
  type EntitlementValues,
  type PlanKey,
} from '@orgistry/contracts';
import { planStateMissingError } from './entitlement.errors';
import { evaluateCountQuota, requireEntitlement, requireQuota } from './quota';
import type {
  ChangeOrganizationPlanResult,
  EntitlementRepository,
  OrganizationPlanState,
  PlanActionContext,
  PlanChangeActor,
} from './entitlement.types';

/**
 * Organization-level entitlement, quota & plan service.
 *
 * This is the reusable capability layer that resolves an ORGANIZATION'S plan to
 * its entitlement values and enforces numeric quotas. It is deliberately:
 *  - organization-scoped, never user-scoped — it takes an organization id and
 *    NEVER a role or permission. Entitlements are a property of the
 *    organization's plan, not of who is asking;
 *  - free of HTTP and RBAC concerns — the plan ROUTES (`plan.service.ts`) layer
 *    membership + permission checks on top before calling this;
 *  - fail-safe — when an organization has no plan state it throws
 *    `PLAN_STATE_MISSING` rather than assuming a default plan.
 *
 * Because it has no RBAC dependency, future API key and audit modules can resolve
 * `api_keys_access` / `max_api_keys` / `audit_log_access` / `audit_retention_days`
 * through it without any change to the plan model.
 */

/** A resolved entitlement set: the plan key and its fixed values. */
export interface EntitlementResolution {
  planKey: PlanKey;
  values: EntitlementValues;
}

/** The API-key entitlements a future API key module will consume (readiness). */
export interface ApiKeyEntitlements {
  /** Whether the plan grants API key access at all. */
  access: boolean;
  /** The maximum number of API keys the plan allows. */
  max: number;
}

/** The audit entitlements a future audit module will consume (readiness). */
export interface AuditEntitlements {
  /** Whether the plan grants audit log access. */
  access: boolean;
  /** Modeled retention window in days (not enforced by a deletion job in v1). */
  retentionDays: number;
}

export interface EntitlementService {
  /** The organization's plan state, or throw `PLAN_STATE_MISSING`. */
  getPlanState(organizationId: string): Promise<OrganizationPlanState>;

  /** Resolve the organization's plan to its entitlement values (fail-safe). */
  resolveEntitlements(organizationId: string): Promise<EntitlementResolution>;

  /**
   * Require that creating one more project fits under `max_projects`, or reject
   * with `QUOTA_EXCEEDED`. Resolves entitlements (fail-safe) then compares the
   * active project count to the plan ceiling.
   */
  requireProjectCreationQuota(organizationId: string): Promise<void>;

  /**
   * Require that adding one more member fits under `max_members`, or reject with
   * `QUOTA_EXCEEDED`. The reusable membership-creation quota boundary: invitation
   * ACCEPTANCE composes this (it counts only active members), and it is checked
   * again at the moment a membership is created.
   */
  requireMemberAdditionQuota(organizationId: string): Promise<void>;

  /**
   * The organization plan's `max_members` ceiling. Exposed so the invitation
   * acceptance transaction can re-check the active-member count against the limit
   * atomically with the membership insert (the count happens inside the
   * transaction; this only resolves the plan-derived limit).
   */
  getMaxMembers(organizationId: string): Promise<number>;

  /**
   * Require that RESERVING one more seat fits under `max_members`, or reject with
   * `QUOTA_EXCEEDED`. This is the Sprint 9 v1 reservation policy for invitation
   * CREATION: a pending invitation reserves a seat, so creation is blocked when
   * `active members + pending invitations >= max_members`. The pending count is
   * supplied by the caller (the invitation repository owns it); this method
   * resolves the limit, counts active members, and compares the reserved total.
   */
  requireMemberReservationQuota(
    organizationId: string,
    pendingInvitationCount: number,
  ): Promise<void>;

  /** Resolve API-key entitlements (access flag + max quota). */
  resolveApiKeyEntitlements(organizationId: string): Promise<ApiKeyEntitlements>;

  /**
   * Require that the organization's plan grants `api_keys_access`, or reject
   * with `ENTITLEMENT_REQUIRED`. The boolean feature gate for API keys — checked
   * AFTER the user permission and BEFORE the quota, and re-checked on every
   * external API request so a downgraded plan disables existing keys.
   */
  requireApiKeysAccess(organizationId: string): Promise<void>;

  /**
   * Require that creating one more API key fits under `max_api_keys`, or reject
   * with `QUOTA_EXCEEDED`. The active-key count is supplied by the caller (the
   * API key repository owns that count); this method owns only the policy
   * comparison, keeping the entitlement/quota model unchanged.
   */
  requireApiKeyCreationQuota(
    organizationId: string,
    activeApiKeyCount: number,
  ): Promise<void>;

  /** Resolve audit entitlements (readiness for a future audit module). */
  resolveAuditEntitlements(organizationId: string): Promise<AuditEntitlements>;

  /**
   * Change the organization's plan (demo control) and resolve the new
   * entitlements. Records `plan.changed_demo`. Performs NO permission check —
   * the caller (plan routes) authorizes first.
   */
  changePlan(params: {
    organizationId: string;
    targetPlanKey: PlanKey;
    actor: PlanChangeActor;
    ctx: PlanActionContext;
  }): Promise<{
    result: ChangeOrganizationPlanResult;
    resolution: EntitlementResolution;
  }>;
}

export interface EntitlementServiceOptions {
  repo: EntitlementRepository;
}

export function createEntitlementService(
  options: EntitlementServiceOptions,
): EntitlementService {
  const { repo } = options;

  async function getPlanState(
    organizationId: string,
  ): Promise<OrganizationPlanState> {
    const state = await repo.findOrganizationPlanState(organizationId);
    if (!state) {
      // Fail safe: never assume a plan when state is missing.
      throw planStateMissingError();
    }
    return state;
  }

  async function resolveEntitlements(
    organizationId: string,
  ): Promise<EntitlementResolution> {
    const state = await getPlanState(organizationId);
    return {
      planKey: state.planKey,
      values: entitlementsForPlan(state.planKey),
    };
  }

  return {
    getPlanState,
    resolveEntitlements,

    async requireProjectCreationQuota(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      const current = await repo.countActiveProjects(organizationId);
      requireQuota(
        ENTITLEMENT_KEYS.maxProjects,
        evaluateCountQuota(current, values.max_projects),
      );
    },

    async requireMemberAdditionQuota(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      const current = await repo.countActiveMembers(organizationId);
      requireQuota(
        ENTITLEMENT_KEYS.maxMembers,
        evaluateCountQuota(current, values.max_members),
      );
    },

    async getMaxMembers(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      return values.max_members;
    },

    async requireMemberReservationQuota(organizationId, pendingInvitationCount) {
      const { values } = await resolveEntitlements(organizationId);
      const activeMembers = await repo.countActiveMembers(organizationId);
      // A pending invitation reserves a seat, so the reserved total is active
      // members PLUS outstanding invitations. Creation is blocked when admitting
      // one more reservation would cross the ceiling.
      const reserved = activeMembers + pendingInvitationCount;
      requireQuota(
        ENTITLEMENT_KEYS.maxMembers,
        evaluateCountQuota(reserved, values.max_members),
      );
    },

    async resolveApiKeyEntitlements(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      return { access: values.api_keys_access, max: values.max_api_keys };
    },

    async requireApiKeysAccess(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      requireEntitlement(values, ENTITLEMENT_KEYS.apiKeysAccess);
    },

    async requireApiKeyCreationQuota(organizationId, activeApiKeyCount) {
      const { values } = await resolveEntitlements(organizationId);
      requireQuota(
        ENTITLEMENT_KEYS.maxApiKeys,
        evaluateCountQuota(activeApiKeyCount, values.max_api_keys),
      );
    },

    async resolveAuditEntitlements(organizationId) {
      const { values } = await resolveEntitlements(organizationId);
      return {
        access: values.audit_log_access,
        retentionDays: values.audit_retention_days,
      };
    },

    async changePlan(params) {
      const result = await repo.changeOrganizationPlan({
        organizationId: params.organizationId,
        targetPlanKey: params.targetPlanKey,
        actor: params.actor,
        ctx: params.ctx,
      });
      return {
        result,
        resolution: {
          planKey: result.planState.planKey,
          values: entitlementsForPlan(result.planState.planKey),
        },
      };
    },
  };
}
