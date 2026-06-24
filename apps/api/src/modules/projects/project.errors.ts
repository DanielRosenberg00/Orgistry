import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';

/**
 * Project error factories.
 *
 * Centralizing these keeps every project failure mapped to a stable public
 * code, status, and message.
 */

/**
 * A project does not exist as an addressable resource of the requested
 * organization. Returned IDENTICALLY when the project id is unknown, belongs to
 * a different organization, or has been soft-deleted. The organization id is the
 * authority boundary — a project in another tenant is never addressable here, so
 * the uniform 404 also prevents cross-tenant existence probing.
 */
export function projectNotFoundError(): AppError {
  return new AppError(ERROR_CODES.PROJECT_NOT_FOUND, 404, 'Project not found.');
}
