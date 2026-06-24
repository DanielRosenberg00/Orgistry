import {
  ERROR_CODES,
  type EntitlementErrorDetails,
  type EntitlementKey,
  type QuotaErrorDetails,
} from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Entitlement / quota error factories.
 *
 * Centralizing these keeps every entitlement and quota failure mapped to a
 * stable public code, status, message, and structured detail shape. These are
 * deliberately distinct from permission failures: a caller can hold the
 * permission and still be quota-blocked or plan-gated.
 */

/**
 * A numeric quota for the organization's plan has been reached. The `details`
 * name the quota and report the plan limit plus current usage so a client can
 * explain the failure and prompt an upgrade. 409: the request conflicts with the
 * organization's current resource count under its plan.
 */
export function quotaExceededError(details: QuotaErrorDetails): AppError {
  return new AppError(
    ERROR_CODES.QUOTA_EXCEEDED,
    409,
    'Your plan quota has been reached.',
    details,
  );
}

/**
 * The organization's plan does not grant a required boolean feature
 * entitlement. The `details` name the missing entitlement. 403: the plan is not
 * entitled to the feature (distinct from the user lacking permission).
 */
export function entitlementRequiredError(
  entitlement: EntitlementKey,
): AppError {
  const details: EntitlementErrorDetails = { entitlement };
  return new AppError(
    ERROR_CODES.ENTITLEMENT_REQUIRED,
    403,
    'Your plan does not include this feature.',
    details,
  );
}

/**
 * The organization has no plan state. Every active organization is provisioned
 * with plan state, so this is a data-integrity failure, not a client error: the
 * resolver fails safely (assumes NO entitlements) rather than defaulting to a
 * plan. 500, with a safe generic message — no internals leak.
 */
export function planStateMissingError(): AppError {
  return new AppError(
    ERROR_CODES.PLAN_STATE_MISSING,
    500,
    'Organization plan state is unavailable.',
  );
}
