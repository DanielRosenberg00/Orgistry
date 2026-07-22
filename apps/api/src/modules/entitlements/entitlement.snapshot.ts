import type { DbExecutor } from '@orgistry/db';
import { schema } from '@orgistry/db';
import {
  entitlementsForPlan,
  type EntitlementValues,
  type PlanKey,
} from '@orgistry/contracts';
import { eq } from 'drizzle-orm';
import { planStateMissingError } from './entitlement.errors';

/**
 * Transaction-aware entitlement resolution (Sprint 20 correctness refinement,
 * ORG-PR-029).
 *
 * Plan assignment is MUTABLE at runtime (`changeOrganizationPlan` rewrites the
 * `organization_plans` row under `FOR UPDATE`), so a plan-derived ceiling
 * resolved before a quota-protected transaction can be stale by the time the
 * transaction counts and writes. The authoritative quota decision therefore
 * resolves the plan INSIDE the protected transaction, through this seam.
 *
 * The plan row is read `FOR SHARE`:
 *  - `FOR SHARE` blocks `changeOrganizationPlan`'s `FOR UPDATE` until the
 *    quota transaction commits, so a plan change can never interleave between
 *    the ceiling read and the protected write — the snapshot, count,
 *    comparison, and insert all see ONE plan state;
 *  - `FOR SHARE` is compatible with other `FOR SHARE` holders, so
 *    quota transactions for DIFFERENT quota kinds of the same organization
 *    (already independent via their advisory locks) do not serialize on the
 *    plan row — only a concurrent plan MUTATION waits.
 *
 * LOCK ORDER: call this INSIDE an open transaction, AFTER the organization's
 * quota advisory lock (`acquireOrganizationQuotaLock`) and BEFORE any
 * flow-specific row locks (invitation rows). `changeOrganizationPlan` takes
 * only the plan row (no advisory or invitation locks), so no cycle exists.
 * See docs/production-readiness/sprint-20-quota-race-audit.md.
 *
 * Fail-safe like the service resolver: a missing plan row is a
 * data-integrity bug and throws `PLAN_STATE_MISSING` rather than assuming a
 * default plan.
 */

/** The plan state a quota-protected transaction resolved for itself. */
export interface OrganizationEntitlementSnapshot {
  planKey: PlanKey;
  values: EntitlementValues;
}

export async function lockOrganizationEntitlements(
  tx: DbExecutor,
  organizationId: string,
): Promise<OrganizationEntitlementSnapshot> {
  const [row] = await tx
    .select({ planKey: schema.organizationPlans.planKey })
    .from(schema.organizationPlans)
    .where(eq(schema.organizationPlans.organizationId, organizationId))
    .for('share')
    .limit(1);
  if (!row) {
    throw planStateMissingError();
  }
  return { planKey: row.planKey, values: entitlementsForPlan(row.planKey) };
}
