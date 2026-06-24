import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Member-management error factories.
 *
 * Centralizing these keeps every member-management failure mapped to a stable
 * public code, status, and message.
 */

/**
 * A target membership does not exist as an addressable member of the requested
 * organization. Returned when the membership id is unknown, belongs to a
 * different organization, or (for role changes) is not active. The organization
 * id is the authority boundary — a membership in another organization is never
 * addressable here, so this also prevents cross-organization probing.
 */
export function memberNotFoundError(): AppError {
  return new AppError(ERROR_CODES.MEMBER_NOT_FOUND, 404, 'Member not found.');
}

/**
 * The operation would leave an active organization with no active Owner. This is
 * the structural Last Owner invariant. It is enforced transactionally (the
 * active-owner set is locked for the duration of the mutation), never as only a
 * read-before-write pre-check.
 */
export function lastOwnerRequiredError(): AppError {
  return new AppError(
    ERROR_CODES.LAST_OWNER_REQUIRED,
    409,
    'An organization must always have at least one active Owner.',
  );
}

/**
 * The caller's active membership lacks the permission required for an
 * organization-scoped action. Authorization is by permission key, never role
 * name (the sole exception is the structural Last Owner invariant above).
 */
export function permissionDeniedError(): AppError {
  return new AppError(
    ERROR_CODES.FORBIDDEN,
    403,
    'You do not have permission to perform this action.',
  );
}
