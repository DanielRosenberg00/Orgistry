import {
  ERROR_CODES,
  type ApiKeyScope,
  type ApiKeyScopeErrorDetails,
} from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * API key error factories.
 *
 * Centralizing these keeps every API key failure mapped to a stable public
 * code, status, and message. The external authentication failures collapse to a
 * single GENERIC 401 (`API_KEY_UNAUTHORIZED`) so a caller can never distinguish
 * "missing" from "malformed" from "unknown" from "revoked" from "expired".
 */

/**
 * An API key does not exist as an addressable resource of the requested
 * organization. Returned identically (management revoke) when the key id is
 * unknown or belongs to a different organization — the organization id is the
 * authority boundary, so this also prevents cross-tenant existence probing.
 */
export function apiKeyNotFoundError(): AppError {
  return new AppError(ERROR_CODES.API_KEY_NOT_FOUND, 404, 'API key not found.');
}

/**
 * External API key authentication failed. Deliberately GENERIC: the same 401 is
 * returned whether the Authorization header was missing, the credential was
 * malformed, the key was unknown, revoked, expired, or its organization is
 * inactive. No detail about the cause leaks to the caller.
 */
export function apiKeyUnauthorizedError(): AppError {
  return new AppError(
    ERROR_CODES.API_KEY_UNAUTHORIZED,
    401,
    'API key authentication failed.',
  );
}

/**
 * An authenticated API key lacks a required scope. 403, with `details` naming
 * the scope, so a client can explain the failure. Distinct from
 * `API_KEY_UNAUTHORIZED`: the key authenticated but is not scoped for this
 * action.
 */
export function apiKeyScopeRequiredError(requiredScope: ApiKeyScope): AppError {
  const details: ApiKeyScopeErrorDetails = { requiredScope };
  return new AppError(
    ERROR_CODES.API_KEY_SCOPE_REQUIRED,
    403,
    'This API key is missing a required scope.',
    details,
  );
}

/**
 * The external API rate limit for this key or its organization has been
 * exceeded. 429, standard envelope. Rate limiting is separate from auth
 * correctness (Redis fails open), so this is only reached when the limiter is
 * reachable and the bucket is genuinely over its ceiling.
 */
export function apiKeyRateLimitedError(): AppError {
  return new AppError(
    ERROR_CODES.RATE_LIMITED,
    429,
    'Too many requests. Please slow down and try again later.',
  );
}
