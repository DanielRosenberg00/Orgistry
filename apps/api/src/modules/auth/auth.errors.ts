import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Auth error factories.
 *
 * Centralizing these keeps every auth failure mapped to a stable public code,
 * status, and message. The messages are deliberately generic — they never
 * reveal whether an email exists or why a token was rejected.
 */

/**
 * Login failure. Identical for "unknown email" and "wrong password" so account
 * existence is never disclosed through code, status, message, or shape.
 */
export function invalidCredentialsError(): AppError {
  return new AppError(
    ERROR_CODES.INVALID_CREDENTIALS,
    401,
    'Invalid email or password.',
  );
}

/** Registration conflict on the normalized email. */
export function emailAlreadyRegisteredError(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_ALREADY_REGISTERED,
    409,
    'An account with this email already exists.',
  );
}

/** Missing, malformed, expired, or otherwise invalid access token. */
export function unauthorizedError(
  message = 'Authentication is required.',
): AppError {
  return new AppError(ERROR_CODES.UNAUTHORIZED, 401, message);
}
