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

  // ----- Projects (Sprint 6) -----
  /**
   * A project does not exist as an addressable resource of the requested
   * organization. Returned identically when the project id is unknown, belongs
   * to a DIFFERENT organization, or has been soft-deleted. The organization id
   * is the authority boundary — a project in another tenant is never
   * addressable here, so this also prevents cross-tenant existence probing.
   */
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',

  // ----- Entitlements, plans & quotas (Sprint 7) -----
  /**
   * A numeric quota for the organization's plan has been reached. Returned when
   * a write would exceed a `max_*` ceiling (e.g. creating a project at or above
   * `max_projects`). The `details` payload (see `quotaErrorDetailsSchema`) names
   * the quota and reports the limit and current usage. This is distinct from
   * authorization: the caller may HAVE the permission and still be quota-blocked.
   */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /**
   * The organization's plan does not grant a required boolean feature
   * entitlement (e.g. `api_keys_access`). The `details` payload (see
   * `entitlementErrorDetailsSchema`) names the missing entitlement. Distinct
   * from a permission denial: the user may be authorized while the plan is not
   * entitled.
   */
  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  /**
   * The organization has no plan state. Every active organization is provisioned
   * with plan state, so this signals a data-integrity failure rather than a
   * client error; the entitlement resolver fails safely (no entitlements are
   * assumed) instead of defaulting to a plan.
   */
  PLAN_STATE_MISSING: 'PLAN_STATE_MISSING',

  // ----- API keys & external API (Sprint 8) -----
  /**
   * An API key does not exist as an addressable resource of the requested
   * organization. Returned identically (404) for management revoke when the key
   * id is unknown or belongs to a DIFFERENT organization — the organization id
   * is the authority boundary, so this also prevents cross-tenant probing.
   */
  API_KEY_NOT_FOUND: 'API_KEY_NOT_FOUND',
  /**
   * External API key authentication failed. Deliberately generic (401): returned
   * IDENTICALLY whether the Authorization header was missing, the credential was
   * malformed, the key was unknown, revoked, expired, or its organization is
   * inactive — so a caller cannot probe which keys exist or why a key failed.
   * Browser session/JWT tokens are not API keys and fail here too.
   */
  API_KEY_UNAUTHORIZED: 'API_KEY_UNAUTHORIZED',
  /**
   * An authenticated API key lacks the scope a route requires (e.g. the external
   * Projects endpoint requires `projects:read`). 403, with `details` naming the
   * required scope (see `apiKeyScopeErrorDetailsSchema`). Distinct from
   * `API_KEY_UNAUTHORIZED`: the key authenticated successfully but is not scoped
   * for this action.
   */
  API_KEY_SCOPE_REQUIRED: 'API_KEY_SCOPE_REQUIRED',

  // ----- Invitations (Sprint 9) -----
  /**
   * The presented invitation token does not resolve to an invitation. Returned
   * (404) when the token is unknown or malformed — the token is a high-entropy
   * secret, so an attacker without it learns nothing, and a holder of a real
   * token sees a precise result. Distinct from the more specific lifecycle codes
   * below, which apply only once a token HAS resolved to a row.
   */
  INVITATION_INVALID: 'INVITATION_INVALID',
  /**
   * The invitation has passed its `expires_at`. Expiry is DERIVED at
   * inspect/accept/list time (there is no background expiration job), so a
   * still-`pending` row whose deadline has passed is treated as expired
   * everywhere. 410.
   */
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  /** The invitation was revoked by an organization administrator. 409. */
  INVITATION_REVOKED: 'INVITATION_REVOKED',
  /**
   * The invitation has already been accepted (single-use invariant). A second
   * acceptance never creates a second membership. 409.
   */
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
  /**
   * The accepting account's normalized email does not match the invitation's
   * normalized invited email. 403. Acceptance is bound to the invited address so
   * a leaked token cannot be redeemed by a different account.
   */
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',

  // ----- Email verification (Sprint 16) -----
  // These three codes describe TOKEN validity only — never account existence
  // or user state. A token whose user is missing or inactive reports
  // EMAIL_VERIFICATION_TOKEN_INVALID, indistinguishable from an unknown token.
  /**
   * The presented verification token does not resolve to a usable row. Returned
   * (404) when the token is unknown, malformed, or its account cannot complete
   * verification — the token is a high-entropy secret, so an attacker without
   * one learns nothing.
   */
  EMAIL_VERIFICATION_TOKEN_INVALID: 'EMAIL_VERIFICATION_TOKEN_INVALID',
  /** The verification token has passed its `expires_at`. 410. */
  EMAIL_VERIFICATION_TOKEN_EXPIRED: 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
  /**
   * The verification token was already consumed by a successful verification,
   * or was invalidated when a newer token was issued (resend) or a sibling
   * completed. Single-use invariant: reuse never verifies twice. 409.
   */
  EMAIL_VERIFICATION_TOKEN_USED: 'EMAIL_VERIFICATION_TOKEN_USED',

  // ----- Password recovery (Sprint 17) -----
  // These three codes describe RESET-TOKEN validity only — never account
  // existence or user state. A token whose user is missing or not recoverable
  // reports PASSWORD_RESET_TOKEN_INVALID, indistinguishable from an unknown
  // token. Status mapping mirrors the email-verification token family:
  // unknown 404, expired 410, consumed/invalidated 409.
  /**
   * The presented reset token does not resolve to a usable row. Returned (404)
   * when the token is unknown, malformed, or its account cannot complete a
   * reset — the token is a high-entropy secret, so an attacker without one
   * learns nothing.
   */
  PASSWORD_RESET_TOKEN_INVALID: 'PASSWORD_RESET_TOKEN_INVALID',
  /** The reset token has passed its `expires_at`. 410. */
  PASSWORD_RESET_TOKEN_EXPIRED: 'PASSWORD_RESET_TOKEN_EXPIRED',
  /**
   * The reset token was already consumed by a successful reset, or was
   * invalidated when a newer token was issued or a sibling completed.
   * Single-use invariant: a token never resets a password twice. 409.
   */
  PASSWORD_RESET_TOKEN_USED: 'PASSWORD_RESET_TOKEN_USED',

  // ----- Verification-first registration (Sprint 18) -----
  // These three codes describe COMPLETION-TOKEN validity only — never account
  // existence or user state. A token whose staged email has been taken by an
  // account created through another path reports REGISTRATION_TOKEN_INVALID,
  // indistinguishable from an unknown token. Status mapping mirrors the other
  // token families: unknown 404, expired 410, consumed/invalidated 409. Note
  // that PUBLIC REGISTRATION ITSELF never returns a duplicate-email error —
  // `EMAIL_ALREADY_REGISTERED` remains only for the AUTHENTICATED email-change
  // flow, where the caller has re-proved the account password.
  /**
   * The presented registration-completion token does not resolve to a usable
   * pending registration. Returned (404) when the token is unknown, malformed,
   * or its staged registration can no longer be completed — the token is a
   * high-entropy secret, so an attacker without one learns nothing.
   */
  REGISTRATION_TOKEN_INVALID: 'REGISTRATION_TOKEN_INVALID',
  /** The registration-completion token has passed its `expires_at`. 410. */
  REGISTRATION_TOKEN_EXPIRED: 'REGISTRATION_TOKEN_EXPIRED',
  /**
   * The registration-completion token was already consumed by a successful
   * completion, or was invalidated when a newer registration request for the
   * same email superseded it. Single-use invariant: a token never creates two
   * accounts, and only the newest emailed link stays usable. 409.
   */
  REGISTRATION_TOKEN_USED: 'REGISTRATION_TOKEN_USED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
