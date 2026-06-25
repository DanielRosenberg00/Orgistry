import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Invitation error factories.
 *
 * Centralizing these keeps every invitation failure mapped to a stable public
 * code, status, and message. The lifecycle codes are deliberately DISTINCT (the
 * token is a high-entropy secret, so a holder of a real token is told precisely
 * why acceptance failed; an attacker without the token only ever sees the
 * uniform `INVITATION_INVALID`).
 */

/**
 * The presented token does not resolve to an invitation (unknown or malformed),
 * OR — for the organization-scoped revoke surface — an invitation id is unknown
 * or belongs to a different organization. The organization id is the authority
 * boundary, so a cross-tenant invitation is never addressable and surfaces this
 * same uniform 404, preventing existence probing.
 */
export function invitationInvalidError(): AppError {
  return new AppError(
    ERROR_CODES.INVITATION_INVALID,
    404,
    'Invitation not found.',
  );
}

/** The invitation has passed its expiry (derived from `expires_at`). 410. */
export function invitationExpiredError(): AppError {
  return new AppError(
    ERROR_CODES.INVITATION_EXPIRED,
    410,
    'This invitation has expired.',
  );
}

/** The invitation was revoked by an administrator. 409. */
export function invitationRevokedError(): AppError {
  return new AppError(
    ERROR_CODES.INVITATION_REVOKED,
    409,
    'This invitation has been revoked.',
  );
}

/** The invitation has already been accepted (single-use invariant). 409. */
export function invitationAlreadyAcceptedError(): AppError {
  return new AppError(
    ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
    409,
    'This invitation has already been accepted.',
  );
}

/**
 * The accepting account's normalized email does not match the invitation's
 * invited email. 403. The message is intentionally generic and reveals nothing
 * about account existence — only that the token does not belong to this account.
 */
export function invitationEmailMismatchError(): AppError {
  return new AppError(
    ERROR_CODES.INVITATION_EMAIL_MISMATCH,
    403,
    'This invitation was issued to a different email address.',
  );
}

/**
 * A pending invitation already exists for this organization + email. 409. The
 * partial unique index is the authoritative guard for the create-time race; the
 * service does a friendly pre-check that surfaces this same conflict.
 */
export function duplicatePendingInvitationError(): AppError {
  return new AppError(
    ERROR_CODES.CONFLICT,
    409,
    'A pending invitation already exists for this email.',
  );
}

/**
 * The invited email already belongs to an ACTIVE member of the organization.
 * 409. Inviting an existing active member is a no-op the create flow rejects up
 * front rather than creating a redundant invitation.
 */
export function alreadyActiveMemberError(): AppError {
  return new AppError(
    ERROR_CODES.CONFLICT,
    409,
    'This email already belongs to an active member of the organization.',
  );
}
