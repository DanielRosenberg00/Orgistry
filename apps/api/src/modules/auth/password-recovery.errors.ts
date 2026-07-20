import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Password-recovery error factories (Sprint 17).
 *
 * Each describes RESET-TOKEN validity only — never account existence or user
 * state. Status mapping mirrors the email-verification token family: unknown
 * 404, expired 410, consumed/invalidated 409. A token whose account cannot
 * complete a reset (missing/disabled/soft-deleted user) maps to the same 404
 * as an unknown token, so the completion endpoint never discloses account
 * state. The public REQUEST endpoint throws none of these — it succeeds
 * identically for known and unknown emails.
 */

export function passwordResetTokenInvalidError(): AppError {
  return new AppError(
    ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
    404,
    'This password reset link is not valid. Request a new one from the sign-in page.',
  );
}

export function passwordResetTokenExpiredError(): AppError {
  return new AppError(
    ERROR_CODES.PASSWORD_RESET_TOKEN_EXPIRED,
    410,
    'This password reset link has expired. Request a new one from the sign-in page.',
  );
}

export function passwordResetTokenUsedError(): AppError {
  return new AppError(
    ERROR_CODES.PASSWORD_RESET_TOKEN_USED,
    409,
    'This password reset link has already been used or replaced by a newer one. Request a new one from the sign-in page.',
  );
}
