import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Organization error factories.
 *
 * Centralizing these keeps every organization failure mapped to a stable public
 * code, status, and message.
 */

/**
 * Organization does not exist OR the caller has no active membership in it. The
 * two cases are intentionally indistinguishable so a caller cannot probe for
 * organizations they do not belong to. This is the authorization boundary for
 * read access — it is keyed on organization ID, never slug.
 */
export function organizationNotFoundError(): AppError {
  return new AppError(
    ERROR_CODES.ORGANIZATION_NOT_FOUND,
    404,
    'Organization not found.',
  );
}

/** A requested organization slug is already taken by another organization. */
export function organizationSlugTakenError(): AppError {
  return new AppError(
    ERROR_CODES.ORGANIZATION_SLUG_TAKEN,
    409,
    'That organization slug is already taken.',
  );
}
