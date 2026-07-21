import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Registration-completion error factories (Sprint 18).
 *
 * These describe COMPLETION-TOKEN validity only — never account existence or
 * user state. The status mapping mirrors the email-verification and
 * password-reset token families exactly (unknown 404, expired 410,
 * consumed/superseded 409) so clients handle all three families identically.
 *
 * There is deliberately NO public-registration duplicate-email error any
 * more: the request endpoint answers `{ accepted: true }` for every
 * post-validation outcome (see the registration service).
 */

/**
 * The presented completion token does not resolve to a usable pending
 * registration. Also returned — indistinguishably, on purpose — when the
 * staged email has meanwhile been taken by an account created through another
 * path (e.g. an authenticated email change): account state is never disclosed
 * through a token error.
 */
export function registrationTokenInvalidError(): AppError {
  return new AppError(
    ERROR_CODES.REGISTRATION_TOKEN_INVALID,
    404,
    'This registration link is not valid. Please register again to receive a new one.',
  );
}

/** The completion token has passed its expiry. */
export function registrationTokenExpiredError(): AppError {
  return new AppError(
    ERROR_CODES.REGISTRATION_TOKEN_EXPIRED,
    410,
    'This registration link has expired. Please register again to receive a new one.',
  );
}

/**
 * The completion token was already consumed, or was superseded/invalidated by
 * a newer registration request for the same email. Single-use invariant.
 */
export function registrationTokenUsedError(): AppError {
  return new AppError(
    ERROR_CODES.REGISTRATION_TOKEN_USED,
    409,
    'This registration link has already been used or was replaced by a newer one.',
  );
}
