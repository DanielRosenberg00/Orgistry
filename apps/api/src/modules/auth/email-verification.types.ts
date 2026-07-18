import type { UserRow } from '@orgistry/db';
import type { NewSecurityEvent } from './auth.types';

/**
 * Internal email-verification types (Sprint 16).
 *
 * The repository interface keeps all SQL in `email-verification.repo.ts` and
 * lets the service be exercised against an in-memory fake. Raw tokens never
 * reach this boundary — callers hash first and pass only the SHA-256 hash.
 */

/** Inputs for issuing a replacement verification token. */
export interface IssueVerificationTokenParams {
  userId: string;
  /** SHA-256 hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  expiresAt: Date;
  /** Current time, stamped onto invalidated predecessors. */
  now: Date;
}

/**
 * Outcome of an atomic completion attempt. The repository classifies the
 * presented token purely on persisted state under a row lock; the service owns
 * the policy (which error each outcome maps to, what to record).
 *
 *  - `verified`            — the token was usable; it is now consumed, its
 *                            unused siblings are invalidated, and the user's
 *                            `email_verified_at` is set (if not already), all
 *                            in one transaction.
 *  - `not_found`           — no token row matched the presented hash.
 *  - `expired`             — the (otherwise untouched) token is past expiry.
 *  - `already_used`        — the token was consumed or invalidated earlier.
 *  - `user_not_verifiable` — the owning account is missing, disabled, or
 *                            soft-deleted. Nothing was mutated.
 */
export type CompleteVerificationResult =
  | { status: 'verified'; user: UserRow; alreadyVerified: boolean }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_used' }
  | { status: 'user_not_verifiable' };

export interface EmailVerificationRepository {
  findUserById(id: string): Promise<UserRow | null>;
  /**
   * Atomically retire every unused, un-invalidated verification token for the
   * user and insert the replacement. Implementations MUST run both writes in
   * one transaction so at most one usable token generation exists afterwards.
   */
  issueVerificationToken(params: IssueVerificationTokenParams): Promise<void>;
  /**
   * Atomically consume a verification token by hash. Implementations MUST
   * guarantee two concurrent calls with the same hash cannot both return
   * `verified` (row lock or equivalent), and MUST perform token consumption,
   * sibling invalidation, and the user timestamp update in one transaction.
   */
  completeVerification(params: {
    tokenHash: string;
    now: Date;
  }): Promise<CompleteVerificationResult>;
  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
