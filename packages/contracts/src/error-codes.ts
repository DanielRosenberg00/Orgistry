/**
 * Baseline error-code catalog.
 *
 * These are transport/application-level codes shared by every endpoint. The
 * baseline block is intentionally generic; domain sprints extend this catalog
 * deliberately and that extension is a reviewed contract change. Sprint 2 adds
 * the `auth` block below.
 *
 * Codes are stable strings: clients may branch on them, so values must not
 * change without a deliberate review.
 */
export const ERROR_CODES = {
  /** Request failed schema/validation checks. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Malformed request that is not a field-level validation failure. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Authentication is required or failed. (Behavior arrives in a later sprint.) */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated but not permitted. (Behavior arrives in a later sprint.) */
  FORBIDDEN: 'FORBIDDEN',
  /** Target resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Request conflicts with current state. */
  CONFLICT: 'CONFLICT',
  /** Client exceeded a rate limit. (Enforcement arrives in a later sprint.) */
  RATE_LIMITED: 'RATE_LIMITED',
  /** A required downstream dependency is unavailable (used by readiness). */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Catch-all for unexpected, unclassified failures. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ----- Auth (Sprint 2) -----
  /**
   * Login failed. Deliberately generic: returned identically whether the email
   * is unknown or the password is wrong, so account existence is never
   * disclosed.
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Registration rejected because the normalized email already exists. */
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',

  // ----- Session lifecycle (Sprint 3) -----
  /**
   * Refresh failed. Deliberately generic: returned identically whether the
   * refresh cookie was missing, unknown, expired, or otherwise unusable, so no
   * token state is disclosed. Distinct from `TOKEN_REUSE_DETECTED`.
   */
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  /**
   * A refresh token that was already used/replaced/revoked was presented. The
   * affected token family and its session are revoked (see the refresh design).
   */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  /** A cookie-backed mutation was missing the required custom CSRF header. */
  CSRF_REQUIRED: 'CSRF_REQUIRED',

  // ----- Organizations (Sprint 4) -----
  /**
   * Organization does not exist OR the caller has no active membership in it.
   * Deliberately identical for both cases so callers cannot probe for the
   * existence of organizations they do not belong to.
   */
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  /** A requested organization slug is already taken. */
  ORGANIZATION_SLUG_TAKEN: 'ORGANIZATION_SLUG_TAKEN',

  // ----- Roles, permissions & member management (Sprint 5) -----
  /**
   * A target membership does not exist in the requested organization. Returned
   * for member role-change/removal when the membership id is unknown or belongs
   * to a different organization — the organization id is the authority boundary.
   */
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  /**
   * The operation would leave an active organization with no active Owner. This
   * is the structural Last Owner invariant: it blocks demoting or removing the
   * last active Owner (including self-demotion / self-removal). Enforced
   * transactionally, never as only a read-before-write pre-check.
   */
  LAST_OWNER_REQUIRED: 'LAST_OWNER_REQUIRED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
