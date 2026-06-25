import { generateOpaqueToken, hashOpaqueToken } from '@orgistry/auth-core';

/**
 * Invitation token generation & hashing.
 *
 * An invitation token is an OPAQUE secret — a high-entropy random string the
 * server stores only as a one-way SHA-256 hash, exactly like refresh and
 * email-verification tokens. The raw value is delivered ONCE, out-of-band, in
 * the invitation email and is unrecoverable from the database.
 *
 * This module is a thin, intention-revealing seam over the shared auth-core
 * opaque-token primitives so the security-sensitive token handling lives in one
 * named place the reviewer can audit:
 *  - `generateInvitationToken()` mints the raw token (returned to the mailer);
 *  - `hashInvitationToken(raw)` derives the only persisted/lookup-able form.
 *
 * SHA-256 (not Argon2) is correct here: the input is already high-entropy random
 * data, so the threat model is exfiltrated-database lookup, not offline brute
 * force — a fast one-way hash gives constant-cost, indexable lookups while
 * keeping the raw token unrecoverable.
 */

/** Mint a new high-entropy raw invitation token. Returned ONLY to the mailer. */
export function generateInvitationToken(): string {
  return generateOpaqueToken();
}

/** Hash a raw invitation token for storage/lookup (SHA-256, hex). Deterministic. */
export function hashInvitationToken(rawToken: string): string {
  return hashOpaqueToken(rawToken);
}
