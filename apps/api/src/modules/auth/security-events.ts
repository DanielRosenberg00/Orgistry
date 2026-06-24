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
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENT_TYPES)[keyof typeof SECURITY_EVENT_TYPES];

// The metadata sanitizer is shared with the organization member-management audit
// seam, so it lives in `lib/security-metadata`. Re-exported here so existing auth
// call sites and tests keep importing it from this module.
export { sanitizeSecurityMetadata } from '../../lib/security-metadata';
