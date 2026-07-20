import type { UserRow } from '@orgistry/db';
import type { NewSecurityEvent } from './auth.types';

/**
 * Internal password-recovery types (Sprint 17).
 *
 * The repository interface keeps all SQL in `password-recovery.repo.ts` and
 * lets the service be exercised against an in-memory fake. Raw tokens never
 * reach this boundary — callers hash first and pass only the SHA-256 hash.
 * Likewise raw passwords never reach it — callers pass the Argon2id hash.
 */

/** Inputs for issuing a replacement reset token. */
export interface IssueResetTokenParams {
  userId: string;
  /** SHA-256 hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  expiresAt: Date;
  /** Current time, stamped onto invalidated predecessors. */
  now: Date;
}

/** Inputs for the atomic reset completion. */
export interface CompleteResetParams {
  /** SHA-256 hash of the presented raw token. */
  tokenHash: string;
  /** Argon2id hash of the new password. The raw password is never persisted. */
  newPasswordHash: string;
  now: Date;
}

/**
 * Outcome of an atomic reset-completion attempt. The repository classifies the
 * presented token purely on persisted state under a row lock; the service owns
 * the policy (which error each outcome maps to, what to record).
 *
 *  - `reset`               — the token was usable; the user's password hash is
 *                            replaced, the token is consumed, its unused
 *                            siblings are invalidated, and EVERY active
 *                            session and refresh token of the user is revoked,
 *                            all in one transaction.
 *  - `not_found`           — no token row matched the presented hash.
 *  - `expired`             — the (otherwise untouched) token is past expiry.
 *  - `already_used`        — the token was consumed or invalidated earlier.
 *  - `user_not_recoverable`— the owning account is missing, disabled, or
 *                            soft-deleted. Nothing was mutated.
 */
export type CompleteResetResult =
  | { status: 'reset'; user: UserRow }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_used' }
  | { status: 'user_not_recoverable' };

export interface PasswordRecoveryRepository {
  findUserByNormalizedEmail(normalizedEmail: string): Promise<UserRow | null>;
  /**
   * Atomically retire every unused, un-invalidated reset token for the user
   * and insert the replacement, serializing CONCURRENT issuance for the same
   * user (the DB implementation locks the user row `FOR UPDATE` first —
   * invalidate-then-insert alone is not race-safe under READ COMMITTED).
   * After any set of concurrent calls settles, exactly one usable reset
   * token exists for the user.
   */
  issueResetToken(params: IssueResetTokenParams): Promise<void>;
  /**
   * Atomically consume a reset token by hash. Implementations MUST guarantee
   * two concurrent calls with the same hash cannot both return `reset` (row
   * lock or equivalent), and MUST perform the password update, token
   * consumption, sibling invalidation, and session + refresh-token revocation
   * in one transaction — a crash can never leave a new password with old
   * sessions still alive.
   */
  completeReset(params: CompleteResetParams): Promise<CompleteResetResult>;
  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
