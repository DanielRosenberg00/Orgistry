import { z } from 'zod';

/**
 * Auth API contracts (Sprint 2).
 *
 * These DTOs are the stable boundary between the API and any client (a future
 * web demo consumes them directly). They describe request validation and
 * response shapes only — never database rows. Two hard rules:
 *  - no response field ever carries a password hash, a raw token, or any
 *    persistence-only column;
 *  - the `AuthUser` shape and the access-token response shape are stable and
 *    must not change without a deliberate contract review.
 */

/**
 * Minimum password length. Enforced here (request validation) so a weak
 * password is rejected with a standard VALIDATION_ERROR before any hashing or
 * persistence happens.
 */
export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound guards against denial-of-service via absurdly long inputs. */
export const MAX_PASSWORD_LENGTH = 200;

const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(320)
  .email('A valid email address is required');

const displayNameSchema = z.string().trim().min(1).max(100);

/**
 * The ONE shared password policy for every surface that sets a password:
 * registration, password-reset completion, and authenticated password change
 * (Sprint 17). All three parse through this exact schema, so the policy can
 * never drift between routes. Change it here or nowhere.
 */
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

/**
 * A password submitted for VERIFICATION (login, current-password confirmation).
 * Only shape-checked — never re-validated against the policy, so accounts
 * created under an older policy can still authenticate.
 */
const submittedPasswordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);

/** POST /v1/auth/register request body.
 *
 * Sprint 18 (verification-first registration): submitting this payload STAGES
 * a registration and (where policy permits) emails a completion link — it no
 * longer creates a user or signs anyone in. See
 * `registerAcceptedResponseSchema` for the deliberately generic response.
 *
 * `invitationToken` is OPTIONAL (Sprint 9): the raw invitation token delivered
 * out-of-band in the invitation email. When present it is validated up front
 * (lifecycle, email match, quota — failures are explicit, and depend only on
 * the token + submitted email, never on account state) and the invitation is
 * accepted at COMPLETION time, after the invited mailbox has proven the email.
 */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  displayName: displayNameSchema,
  /** Optional raw invitation token to carry through to completion. */
  invitationToken: z.string().min(1).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * POST /v1/auth/register response body (Sprint 18). Deliberately carries NO
 * information beyond acknowledgment: `accepted` is true for eligible new
 * emails, already-registered emails, and every non-disclosable account state
 * alike — once validation and rate limiting have passed, the response never
 * reveals whether an account exists, whether an email was sent, or whether a
 * pending registration was staged. No user, tokens, cookie, organization,
 * membership, or invitation data is ever part of this response.
 */
export const registerAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
});
export type RegisterAcceptedResponse = z.infer<
  typeof registerAcceptedResponseSchema
>;

/**
 * POST /v1/auth/registration/complete request body (public; possession of the
 * emailed raw completion token IS the proof). The token travels in the body —
 * never a backend URL path or query string — so it cannot reach API access
 * logs.
 */
export const registrationCompleteRequestSchema = z.object({
  token: z.string().min(1).max(512),
});
export type RegistrationCompleteRequest = z.infer<
  typeof registrationCompleteRequestSchema
>;

/**
 * Invitation outcome on a completed registration. Present (non-null) only when
 * the original registration request carried an invitation:
 *  - `accepted`    — the invited-organization membership was created in the
 *    same transaction as the account;
 *  - `unavailable` — the invitation could no longer be honored at completion
 *    time (expired, revoked, already accepted, quota reached, or otherwise
 *    unusable — deliberately coarse). The account, personal workspace, and
 *    session were still created; the user can request a fresh invitation.
 */
export const registrationInvitationOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z.object({ status: z.literal('accepted') }),
    z.object({ status: z.literal('unavailable') }),
  ],
);
export type RegistrationInvitationOutcome = z.infer<
  typeof registrationInvitationOutcomeSchema
>;

/** POST /v1/auth/login request body. Password length is not re-validated here. */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: submittedPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Public representation of an authenticated user. This is the ONLY user shape
 * that crosses the API boundary — it intentionally omits `passwordHash`,
 * `normalizedEmail`, `status`, and soft-delete fields.
 */
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/**
 * Issued access-token payload returned by login and registration completion.
 * `tokenType` is always `Bearer`; `expiresIn` is the token lifetime in seconds.
 *
 * The refresh credential is NEVER part of this (or any) JSON body — it travels
 * only through the HttpOnly refresh cookie (Sprint 3). This shape is therefore
 * unchanged from Sprint 2: the cookie is an out-of-band channel.
 */
export const authTokensSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

/**
 * The authenticated-session shape: the new tokens plus the user. Returned by
 * login, and by registration COMPLETION (never by the initial registration
 * request — Sprint 18).
 */
export const authSessionResponseSchema = z.object({
  user: authUserSchema,
  tokens: authTokensSchema,
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/**
 * POST /v1/auth/registration/complete response body (Sprint 18). The normal
 * authenticated registration result — returned ONLY after a valid completion
 * token has proven the email and the account has been created. The completed
 * user is always email-verified. `invitation` is null unless the original
 * request carried an invitation (see the outcome schema above).
 */
export const registrationCompleteResponseSchema = authSessionResponseSchema.extend(
  {
    invitation: registrationInvitationOutcomeSchema.nullable(),
  },
);
export type RegistrationCompleteResponse = z.infer<
  typeof registrationCompleteResponseSchema
>;

/** GET /v1/auth/me response body. */
export const currentUserResponseSchema = z.object({
  user: authUserSchema,
});
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Session lifecycle (Sprint 3)                                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /v1/auth/refresh response body. Returns a fresh access token only; the
 * rotated refresh credential is delivered through the HttpOnly cookie, never
 * here.
 */
export const refreshResponseSchema = z.object({
  tokens: authTokensSchema,
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/** POST /v1/auth/logout response body. */
export const logoutResponseSchema = z.object({
  success: z.literal(true),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

/**
 * Public, secret-free view of a session, returned ONLY to the authenticated
 * user who owns it (the session-list/revoke endpoints are Bearer-authenticated
 * and user-scoped; cross-user access is an indistinguishable 404). It exposes
 * only non-sensitive lifecycle metadata and NEVER the refresh token hash, token
 * family id, user id, cookie, authorization header, or any persistence internal.
 *
 * `ipAddress`/`userAgent`: deliberately exposed. They are the session's own
 * client metadata, shown only to that session's owner so they can recognize and
 * revoke their devices (the standard "your active sessions" UX). This is the
 * owner's own data, not another user's, so it is acceptable to surface.
 */
export const sessionSummarySchema = z.object({
  id: z.string(),
  /** True for the session the current access token is bound to. */
  current: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  /** Best-effort client metadata captured at session creation (owner-only). */
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * GET /v1/auth/sessions response body. Cursor-paginated list of the
 * authenticated user's active sessions (revoked/expired sessions are omitted).
 */
export const sessionListResponseSchema = z.object({
  items: z.array(sessionSummarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/** DELETE /v1/auth/sessions/:sessionId response body. */
export const sessionRevocationResponseSchema = z.object({
  success: z.literal(true),
});
export type SessionRevocationResponse = z.infer<
  typeof sessionRevocationResponseSchema
>;

/* -------------------------------------------------------------------------- */
/* Email verification (Sprint 16)                                             */
/* -------------------------------------------------------------------------- */

/**
 * POST /v1/auth/email-verification/request response body (Bearer-authenticated;
 * also the resend endpoint — there is deliberately no separate resend route).
 * The endpoint takes NO body: it operates only on the authenticated user's
 * stored email, so no arbitrary address can ever be probed. `alreadyVerified`
 * true means safe success without sending (`sent` false). The raw token and
 * its hash are NEVER part of any response — the token travels only in the
 * emailed link.
 */
export const emailVerificationRequestResponseSchema = z.object({
  /** True when a verification email was handed to the mailer. */
  sent: z.boolean(),
  /** True when the account was already verified (nothing sent). */
  alreadyVerified: z.boolean(),
});
export type EmailVerificationRequestResponse = z.infer<
  typeof emailVerificationRequestResponseSchema
>;

/**
 * POST /v1/auth/email-verification/complete request body (public; possession
 * of the emailed raw token IS the verification proof). The token travels in
 * the body — never in a backend URL path — so it cannot reach API access logs.
 */
export const emailVerificationCompleteRequestSchema = z.object({
  token: z.string().min(1).max(512),
});
export type EmailVerificationCompleteRequest = z.infer<
  typeof emailVerificationCompleteRequestSchema
>;

/** POST /v1/auth/email-verification/complete response body. */
export const emailVerificationCompleteResponseSchema = z.object({
  verified: z.literal(true),
});
export type EmailVerificationCompleteResponse = z.infer<
  typeof emailVerificationCompleteResponseSchema
>;

/* -------------------------------------------------------------------------- */
/* Password recovery & credential management (Sprint 17)                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /v1/auth/password-recovery/request request body (public). Takes only an
 * email; the endpoint is enumeration-safe by contract — the response below is
 * IDENTICAL whether or not an account exists for the address.
 */
export const passwordRecoveryRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordRecoveryRequest = z.infer<
  typeof passwordRecoveryRequestSchema
>;

/**
 * POST /v1/auth/password-recovery/request response body. Deliberately carries
 * NO information: `accepted` is always true, for known and unknown emails
 * alike. It never reveals whether a user exists, whether an email was sent, or
 * whether a token row was created. The raw reset token and its hash are never
 * part of any response — the token travels only in the emailed link.
 */
export const passwordRecoveryRequestResponseSchema = z.object({
  accepted: z.literal(true),
});
export type PasswordRecoveryRequestResponse = z.infer<
  typeof passwordRecoveryRequestResponseSchema
>;

/**
 * POST /v1/auth/password-recovery/complete request body (public; possession of
 * the emailed raw token IS the proof). The token travels in the body — never a
 * backend URL path or query string — so it cannot reach API access logs. The
 * new password parses through the SAME shared policy as registration.
 */
export const passwordRecoveryCompleteRequestSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: newPasswordSchema,
});
export type PasswordRecoveryCompleteRequest = z.infer<
  typeof passwordRecoveryCompleteRequestSchema
>;

/**
 * POST /v1/auth/password-recovery/complete response body. A completed reset
 * NEVER signs the user in: no tokens, no session, no cookie. The client is
 * expected to direct the user to the login form.
 */
export const passwordRecoveryCompleteResponseSchema = z.object({
  reset: z.literal(true),
});
export type PasswordRecoveryCompleteResponse = z.infer<
  typeof passwordRecoveryCompleteResponseSchema
>;

/**
 * POST /v1/auth/change-password request body (Bearer-authenticated). The
 * current password is MANDATORY re-authentication; the new password parses
 * through the shared policy.
 */
export const changePasswordRequestSchema = z.object({
  currentPassword: submittedPasswordSchema,
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * POST /v1/auth/change-password response body. The caller's own session stays
 * active (their bearer token keeps working); every OTHER session and its
 * refresh tokens are revoked server-side.
 */
export const changePasswordResponseSchema = z.object({
  success: z.literal(true),
});
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

/**
 * POST /v1/auth/change-email request body (Bearer-authenticated). The current
 * password is MANDATORY re-authentication. The new email is normalized
 * server-side; a duplicate normalized email is rejected with the same 409 as
 * registration (an intentionally allowed disclosure for the authenticated flow).
 */
export const changeEmailRequestSchema = z.object({
  currentPassword: submittedPasswordSchema,
  newEmail: emailSchema,
});
export type ChangeEmailRequest = z.infer<typeof changeEmailRequestSchema>;

/**
 * POST /v1/auth/change-email response body: the updated current user. After a
 * change, `emailVerified` is always false — the previous verification does not
 * carry over; a fresh verification email is sent to the NEW address.
 */
export const changeEmailResponseSchema = z.object({
  user: authUserSchema,
});
export type ChangeEmailResponse = z.infer<typeof changeEmailResponseSchema>;
