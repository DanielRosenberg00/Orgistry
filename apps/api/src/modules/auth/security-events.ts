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
  // ----- Verification-first registration (Sprint 18) -----
  // The REQUEST event is always ANONYMOUS with a null user id: submitting an
  // email to a public endpoint authenticates nobody, and an attempt against
  // an existing account must never reference that account's user id. Its
  // metadata is a coarse `outcome` + `delivered` flag only — no email, no
  // email digest, no token material, no URL. (This event supersedes the
  // retired `auth.registration_succeeded` / `auth.registration_duplicate_email`
  // pair from the synchronous-registration era; historical rows keep their
  // old names.) COMPLETION events: success attributes to the newly proven
  // user (mailbox control was just demonstrated) with a coarse invitation
  // outcome; rejection attributes to no one, recording only a coarse
  // `reason`.
  registrationRequested: 'auth.registration_requested',
  registrationCompletionSucceeded: 'auth.registration_completion_succeeded',
  registrationCompletionRejected: 'auth.registration_completion_rejected',
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENT_TYPES)[keyof typeof SECURITY_EVENT_TYPES];

// The metadata sanitizer is shared with the organization member-management audit
// seam, so it lives in `lib/security-metadata`. Re-exported here so existing auth
// call sites and tests keep importing it from this module.
export { sanitizeSecurityMetadata } from '../../lib/security-metadata';
