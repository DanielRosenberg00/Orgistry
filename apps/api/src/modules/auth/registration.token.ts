import { generateOpaqueToken, hashOpaqueToken } from '@orgistry/auth-core';

/**
 * Registration-completion token generation & hashing (Sprint 18). A thin seam
 * over the shared opaque-token primitives (mirroring
 * `password-recovery.token.ts`) so the security-sensitive handling lives in
 * one named place.
 *
 * A completion token is 32 bytes of CSPRNG entropy, persisted ONLY as a
 * one-way SHA-256 hash on the pending registration; the raw value exists
 * once, out-of-band, in the completion email. SHA-256 (not Argon2) is
 * correct: the input is already high-entropy, so the threat model is
 * exfiltrated-database lookup, not offline brute force, and comparison
 * happens by unique-index hash lookup.
 */

/** Mint a new high-entropy raw completion token. Emailed, never stored. */
export function generateRegistrationCompletionToken(): string {
  return generateOpaqueToken();
}

/** Hash a raw completion token for storage/lookup (SHA-256, hex). Deterministic. */
export function hashRegistrationCompletionToken(rawToken: string): string {
  return hashOpaqueToken(rawToken);
}

/**
 * Derive the INTERNAL rate-limit key for a presented raw token: the hash of
 * the storage hash. Rate limiting must not key on the raw token (it would put
 * the secret in Redis) nor on the storage hash itself (the exact DB lookup
 * value), so completion attempts are bucketed under this second-order digest —
 * still deterministic per token, but useless for a table lookup if leaked.
 */
export function registrationCompletionRateLimitKey(rawToken: string): string {
  return hashOpaqueToken(hashOpaqueToken(rawToken));
}
