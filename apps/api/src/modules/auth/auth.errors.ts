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

/**
 * Refresh failure. Deliberately generic — returned identically whether the
 * refresh cookie was missing, unknown, or expired, so no token state leaks.
 */
export function invalidRefreshTokenError(): AppError {
  return new AppError(
    ERROR_CODES.INVALID_REFRESH_TOKEN,
    401,
    'The session could not be refreshed.',
  );
}

/**
 * A used/replaced/revoked refresh token was presented. The affected family and
 * its session are revoked before this is thrown. The message stays generic so
 * it does not confirm token state to an attacker.
 */
export function tokenReuseDetectedError(): AppError {
  return new AppError(
    ERROR_CODES.TOKEN_REUSE_DETECTED,
    401,
    'The session has been invalidated. Please sign in again.',
  );
}

/** A cookie-backed mutation arrived without the required custom CSRF header. */
export function csrfRequiredError(): AppError {
  return new AppError(
    ERROR_CODES.CSRF_REQUIRED,
    403,
    'A required security header is missing.',
  );
}

/** A rate-limit bucket was exceeded. */
export function rateLimitedError(): AppError {
  return new AppError(
    ERROR_CODES.RATE_LIMITED,
    429,
    'Too many requests. Please slow down and try again later.',
  );
}

/**
 * Current-password re-authentication failed on an authenticated credential
 * mutation (change password / change email). Same generic INVALID_CREDENTIALS
 * code as login (the credential-error convention), but status 400 — NOT 401:
 * the caller's session is perfectly valid, and a 401 would make API clients
 * treat it as an expired session (the web client would silently refresh and
 * then drop the user to the login screen over a typo).
 */
export function currentPasswordIncorrectError(): AppError {
  return new AppError(
    ERROR_CODES.INVALID_CREDENTIALS,
    400,
    'The current password is incorrect.',
  );
}

/** The new password must actually change the credential (reuse rejection). */
export function passwordUnchangedError(): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_ERROR,
    400,
    'The new password must be different from the current password.',
  );
}

/** The new email is the same (after normalization) as the current one. */
export function emailUnchangedError(): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_ERROR,
    400,
    'The new email address must be different from the current one.',
  );
}

/**
 * A session was not found OR is not owned by the caller. The two are
 * intentionally indistinguishable so a caller cannot probe for other users'
 * session ids.
 */
export function sessionNotFoundError(): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 404, 'Session not found.');
}
