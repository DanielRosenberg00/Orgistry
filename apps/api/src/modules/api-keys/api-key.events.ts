/**
 * API key event types (Sprint 8). Two CONCEPTUALLY DISTINCT kinds of event live
 * here and must never be blurred:
 *
 *  1. `API_KEY_EVENT_TYPES` — organization ACTION events for the key lifecycle
 *     (create/revoke). These are administrative actions performed by a USER, the
 *     direct analogue of the Sprint 5/6/7 member/project/plan actions. They are
 *     written INSIDE the same transaction as the mutation (the record and the
 *     change commit together) with a `user` actor, an actor membership, and the
 *     target key id.
 *
 *  2. `API_KEY_SECURITY_EVENT_TYPES` — SECURITY events for FAILED external
 *     authentication (malformed/unknown/revoked/expired key, missing scope,
 *     missing entitlement, rate limited). These are best-effort, machine-actor
 *     records of a rejected request — NOT lifecycle actions.
 *
 * Physical storage is SHARED: both kinds are persisted to the existing
 * `security_events` table, which already carries an `organization_id` column.
 * That sharing is an INTERNAL IMPLEMENTATION DETAIL inherited from Sprints 5–7
 * (the table is the durable internal event sink); it is NOT a conceptual merge.
 * The two kinds are written by SEPARATE repository methods with separate input
 * types (`recordKeyEvent` for actions, `recordAuthEvent` for security failures),
 * carry different actor types (`user` vs `api_key`/`anonymous`), and use disjoint
 * dotted event-name namespaces. A future audit-log reader can therefore project
 * the action events without dragging in auth-failure noise. Sprint 8 deliberately
 * does NOT add a user-facing audit-log read API; this is only the writer seam.
 *
 * Metadata is sanitized (`sanitizeSecurityMetadata`) before persistence and must
 * NEVER contain the raw secret, the secret hash, Authorization headers, cookies,
 * or sensitive request bodies.
 *
 * Event names are dotted and stable, mirroring `SECURITY_EVENT_TYPES`,
 * `MEMBER_EVENT_TYPES`, `PROJECT_EVENT_TYPES`, and `PLAN_EVENT_TYPES`.
 */

/**
 * Key lifecycle ACTION events (not security/authentication events), recorded
 * with the `user` actor that performed them, in the mutation's transaction.
 */
export const API_KEY_EVENT_TYPES = {
  created: 'api_key.created',
  revoked: 'api_key.revoked',
} as const;

export type ApiKeyEventType =
  (typeof API_KEY_EVENT_TYPES)[keyof typeof API_KEY_EVENT_TYPES];

/**
 * Failed external authentication SECURITY events. Attribution follows the
 * Sprint 8 rules: malformed/unknown keys carry NO key id (and no token
 * material); revoked/expired/scope/entitlement/rate-limit events carry the
 * safely-resolved key id and organization id only.
 */
export const API_KEY_SECURITY_EVENT_TYPES = {
  authMalformed: 'api_key.auth_malformed',
  authUnknown: 'api_key.auth_unknown',
  authRevoked: 'api_key.auth_revoked',
  authExpired: 'api_key.auth_expired',
  authOrganizationInactive: 'api_key.auth_organization_inactive',
  authEntitlementMissing: 'api_key.auth_entitlement_missing',
  authScopeMissing: 'api_key.auth_scope_missing',
  rateLimitExceeded: 'api_key.rate_limit_exceeded',
} as const;

export type ApiKeySecurityEventType =
  (typeof API_KEY_SECURITY_EVENT_TYPES)[keyof typeof API_KEY_SECURITY_EVENT_TYPES];
