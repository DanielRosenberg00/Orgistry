/**
 * Baseline error-code catalog.
 *
 * These are transport/application-level codes shared by every endpoint. They
 * are intentionally generic — no domain-specific codes (auth, billing, orgs,
 * etc.) belong here. Domain sprints extend this catalog deliberately and that
 * extension is a reviewed contract change.
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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
