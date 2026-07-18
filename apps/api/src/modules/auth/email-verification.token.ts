import { generateOpaqueToken, hashOpaqueToken } from '@orgistry/auth-core';

/**
 * Email-verification token generation & hashing (Sprint 16).
 *
 * A verification token is an OPAQUE secret — 32 bytes of CSPRNG entropy the
 * server stores only as a one-way SHA-256 hash, exactly like refresh and
 * invitation tokens. The raw value is delivered ONCE, out-of-band, in the
 * verification email and is unrecoverable from the database.
 *
 * This is a thin, intention-revealing seam over the shared auth-core
 * opaque-token primitives (mirroring `invitation.token.ts`) so the
 * security-sensitive handling lives in one named place:
 *  - `generateEmailVerificationToken()` mints the raw token (goes only into
 *    the emailed link);
 *  - `hashEmailVerificationToken(raw)` derives the only persisted/lookup-able
 *    form.
 *
 * SHA-256 (not Argon2) is correct here: the input is already high-entropy
 * random data, so the threat model is exfiltrated-database lookup, not offline
 * brute force. Comparison happens by unique-index hash lookup, never by
 * comparing raw values.
 */

/** Mint a new high-entropy raw verification token. Emailed, never stored. */
export function generateEmailVerificationToken(): string {
  return generateOpaqueToken();
}

/** Hash a raw verification token for storage/lookup (SHA-256, hex). Deterministic. */
export function hashEmailVerificationToken(rawToken: string): string {
  return hashOpaqueToken(rawToken);
}
