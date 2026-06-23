/**
 * `@orgistry/auth-core` — reusable authentication & security primitives.
 *
 * This package owns ONLY pure primitives: password hashing, access-token
 * signing/verification, opaque-token generation/hashing, email normalization,
 * and redaction. It has no knowledge of HTTP, Fastify, the database, or any
 * registration/login/session workflow — those live in `apps/api`. Secrets and
 * TTLs are passed in by the caller (from `@orgistry/config`); this package
 * never reads configuration itself.
 */
export { hashPassword, verifyPassword } from './password';
export {
  signAccessToken,
  verifyAccessToken,
  AccessTokenError,
  type AccessTokenClaims,
  type SignAccessTokenParams,
} from './access-token';
export { generateOpaqueToken, hashOpaqueToken } from './opaque-token';
export { normalizeEmail } from './email';
export { redactSecret, redactAuthorizationHeader } from './redaction';
