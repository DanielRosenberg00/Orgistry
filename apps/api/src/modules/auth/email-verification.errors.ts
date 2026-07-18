import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Email-verification error factories (Sprint 16).
 *
 * Each describes TOKEN validity only — never account existence or user state.
 * Status mapping mirrors the invitation-token family: unknown 404, expired
 * 410, consumed/invalidated 409. A token whose account cannot complete
 * verification (missing/disabled/soft-deleted user) maps to the same 404 as an
 * unknown token, so the completion endpoint never discloses account state.
 */

export function emailVerificationTokenInvalidError(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_VERIFICATION_TOKEN_INVALID,
    404,
    'This verification link is not valid. Request a new verification email and try again.',
  );
}

export function emailVerificationTokenExpiredError(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_VERIFICATION_TOKEN_EXPIRED,
    410,
    'This verification link has expired. Request a new verification email and try again.',
  );
}

export function emailVerificationTokenUsedError(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_VERIFICATION_TOKEN_USED,
    409,
    'This verification link has already been used or replaced by a newer one. Request a new verification email if your address is still unverified.',
  );
}
