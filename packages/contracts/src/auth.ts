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

/** POST /v1/auth/register request body.
 *
 * `invitationToken` is OPTIONAL (Sprint 9): when present, the new account also
 * joins the inviting organization with the invited role. It is the raw
 * invitation token delivered out-of-band in the invitation email. Omitting it
 * preserves the exact Sprint 2 registration behavior, so existing clients are
 * unaffected. The token is validated server-side; the registration email must
 * match the invitation's invited email.
 */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH),
  displayName: displayNameSchema,
  /** Optional raw invitation token to accept during registration. */
  invitationToken: z.string().min(1).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** POST /v1/auth/login request body. Password length is not re-validated here. */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
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
 * Issued access-token payload returned by register and login. `tokenType` is
 * always `Bearer`; `expiresIn` is the token lifetime in seconds.
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

/** Register and login share one response shape: the new tokens plus the user. */
export const authSessionResponseSchema = z.object({
  user: authUserSchema,
  tokens: authTokensSchema,
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

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
