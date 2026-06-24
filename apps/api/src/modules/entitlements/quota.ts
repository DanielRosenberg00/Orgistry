import type { EntitlementKey, EntitlementValues } from '@orgistry/contracts';
import { entitlementRequiredError, quotaExceededError } from './entitlement.errors';

/**
 * Quota & entitlement helper PRIMITIVES — pure, side-effect-free policy.
 *
 * These functions own the entitlement/quota POLICY layer that sits between
 * permission checks and tenant-scoped writes:
 *
 *   requireMembership → requirePermission
 *     → requireEntitlement (boolean feature gate)   ← here
 *     → requireQuota       (numeric usage ceiling)  ← here
 *       → tenant-scoped write
 *
 * They are deliberately decoupled from persistence and from RBAC: they take
 * already-resolved values and counts and decide allowed / exceeded. The IO
 * (reading plan state, counting resources) lives in `entitlement.service.ts`,
 * which composes these primitives. Keeping policy pure makes the
 * permission-vs-entitlement-vs-quota separation explicit and unit-testable.
 */

/** The outcome of evaluating a numeric quota against current usage. */
export type QuotaStatus = 'allowed' | 'exceeded';

/**
 * A structured quota evaluation. `current` is the active usage; `limit` is the
 * plan ceiling. `status` is `exceeded` when admitting one more would cross the
 * ceiling (i.e. `current >= limit`), otherwise `allowed`.
 */
export interface QuotaEvaluation {
  status: QuotaStatus;
  limit: number;
  current: number;
}

/**
 * Evaluate whether ONE more of a counted resource fits under a numeric ceiling.
 *
 * `current >= limit` is `exceeded` (the next unit would not fit). A `limit` of 0
 * means the capability is unavailable, so any creation is exceeded. This never
 * throws — it returns a structured result the caller maps to a response.
 */
export function evaluateCountQuota(
  current: number,
  limit: number,
): QuotaEvaluation {
  const status: QuotaStatus = current >= limit ? 'exceeded' : 'allowed';
  return { status, limit, current };
}

/**
 * Require that a counted resource fits under its ceiling, or reject with a
 * standard `QUOTA_EXCEEDED` error carrying the quota key, limit, and current
 * usage. A no-op when the evaluation is `allowed`.
 */
export function requireQuota(
  quota: EntitlementKey,
  evaluation: QuotaEvaluation,
): void {
  if (evaluation.status === 'exceeded') {
    throw quotaExceededError({
      quota,
      limit: evaluation.limit,
      current: evaluation.current,
    });
  }
}

/**
 * Require that the organization's plan grants a boolean feature entitlement, or
 * reject with a standard `ENTITLEMENT_REQUIRED` error naming the entitlement.
 *
 * Only the boolean feature-access entitlements are meaningful here
 * (`api_keys_access`, `audit_log_access`); passing a numeric key is a
 * programming error and is treated as not-granted.
 */
export function requireEntitlement(
  values: EntitlementValues,
  entitlement: Extract<
    EntitlementKey,
    'api_keys_access' | 'audit_log_access'
  >,
): void {
  if (values[entitlement] !== true) {
    throw entitlementRequiredError(entitlement);
  }
}
