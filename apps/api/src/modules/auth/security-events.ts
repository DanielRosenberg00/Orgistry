/**
 * Auth security event types.
 *
 * Security events are DURABLE records of auth/security activity (persisted to
 * `security_events`), distinct from request logs. Event names are dotted and
 * stable so they stay understandable to whoever reads them later. The metadata
 * sanitizer used before persistence lives in `lib/security-metadata` and is
 * re-exported at the bottom of this module for existing call sites. Organization
 * member-management events use a parallel catalog in
 * `modules/organization/member.events.ts`.
 */

export const SECURITY_EVENT_TYPES = {
  registrationSucceeded: 'auth.registration_succeeded',
  loginSucceeded: 'auth.login_succeeded',
  loginFailed: 'auth.login_failed',
  accessTokenRejected: 'auth.access_token_rejected',
  // ----- Session lifecycle (Sprint 3) -----
  refreshTokenRotated: 'auth.refresh_token_rotated',
  refreshTokenReuseDetected: 'auth.refresh_token_reuse_detected',
  refreshFailed: 'auth.refresh_failed',
  logoutSucceeded: 'auth.logout_succeeded',
  sessionRevoked: 'auth.session_revoked',
  rateLimitExceeded: 'auth.rate_limit_exceeded',
  // ----- Email verification (Sprint 16) -----
  // Metadata is minimal and sanitized: NEVER the raw token, its hash, or the
  // verification URL. Failed completions attribute to no user (the token is
  // unproven), recording only a coarse `reason`.
  emailVerificationRequested: 'auth.email_verification_requested',
  emailVerificationSucceeded: 'auth.email_verification_succeeded',
  emailVerificationFailed: 'auth.email_verification_failed',
  // ----- Credential lifecycle (Sprint 17) -----
  // Metadata is minimal and sanitized: NEVER a password, hash, raw token,
  // token hash, or reset URL. Requested/completed attribute to the resolved
  // user; rejected completions attribute to no user (the token is unproven),
  // recording only a coarse `reason`.
  passwordResetRequested: 'auth.password_reset_requested',
  passwordResetCompleted: 'auth.password_reset_completed',
  passwordResetRejected: 'auth.password_reset_rejected',
  passwordChanged: 'auth.password_changed',
  passwordChangeRejected: 'auth.password_change_rejected',
  emailChanged: 'auth.email_changed',
  emailChangeRejected: 'auth.email_change_rejected',
  // Public registration hit an existing normalized email. Attributed to an
  // ANONYMOUS actor with a null user id — the caller is unproven, and the
  // event must never read as an action by (or a reference to) the existing
  // account. Metadata is a coarse reason only: no email, no email digest.
  // Named for what HAPPENED, not for a suppression that does not occur.
  registrationDuplicateEmail: 'auth.registration_duplicate_email',
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENT_TYPES)[keyof typeof SECURITY_EVENT_TYPES];

// The metadata sanitizer is shared with the organization member-management audit
// seam, so it lives in `lib/security-metadata`. Re-exported here so existing auth
// call sites and tests keep importing it from this module.
export { sanitizeSecurityMetadata } from '../../lib/security-metadata';
