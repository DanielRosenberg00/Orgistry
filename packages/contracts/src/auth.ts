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

/** POST /v1/auth/register request body. */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH),
  displayName: displayNameSchema,
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
 * always `Bearer`; `expiresIn` is the token lifetime in seconds. No refresh
 * token is issued in Sprint 2.
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
