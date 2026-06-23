import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque tokens (refresh tokens, email-verification tokens).
 *
 * Unlike JWTs, these carry no claims — they are high-entropy random strings the
 * server stores only as a one-way hash. The raw value is shown to the client
 * once and is unrecoverable from the database. Naming is explicit throughout:
 * a `rawToken` is the secret sent to the client; a `tokenHash` is what we
 * persist and look up by.
 *
 * Sprint 2 ships these primitives as foundation; refresh/verification flows
 * that mint and redeem the tokens arrive in a later sprint.
 */

const DEFAULT_TOKEN_BYTES = 32;

/** Generate a new high-entropy opaque token (URL-safe base64, no padding). */
export function generateOpaqueToken(byteLength = DEFAULT_TOKEN_BYTES): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Hash an opaque token for storage/lookup with SHA-256.
 *
 * SHA-256 (not Argon2) is correct here: the input is already high-entropy
 * random data, so the threat model is exfiltrated-database lookup, not offline
 * brute force. A fast one-way hash gives constant-cost, indexable lookups while
 * keeping the raw token unrecoverable.
 */
export function hashOpaqueToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
