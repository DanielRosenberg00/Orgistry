import type {
  MembershipRow,
  OrganizationRow,
  PendingRegistrationRow,
  RefreshTokenRow,
  SessionRow,
  UserRow,
} from '@orgistry/db';
import type { NewSecurityEvent } from './auth.types';

/**
 * Internal verification-first registration types (Sprint 18).
 *
 * The repository interface keeps all SQL in `registration.repo.ts` and lets
 * the service be exercised against an in-memory fake. Raw material never
 * reaches this boundary: callers hash the password (Argon2id) and the
 * completion token (SHA-256) first, and the only invitation reference that
 * crosses it is the stable invitation row ID — never the invitation token or
 * its hash.
 */

/**
 * The narrow port the registration service uses for invitation-carrying
 * registrations. The invitation service structurally satisfies this shape
 * (see `RegistrationInvitationGuard` in the invitation module) and is
 * injected at wiring time, keeping this module free of invitation imports.
 * OPTIONAL on the registration service: when absent (or when a registration
 * omits `invitationToken`), registrations behave identically minus the
 * invitation.
 */
export interface RegistrationInvitations {
  /** Request-time pre-validation. Throws precise invitation errors. */
  prepareForRegistration(
    rawToken: string,
    normalizedEmail: string,
  ): Promise<{ invitationId: string; organizationName: string }>;
  /**
   * Completion-time existence check: whether the stored invitation reference
   * still resolves. The acceptance transaction re-validates everything else
   * (lifecycle, email, quota — with the plan ceiling resolved inside that
   * transaction) authoritatively.
   */
  resolveCompletionContext(invitationId: string): Promise<boolean>;
}

/** Inputs for staging (or re-staging) a pending registration. */
export interface IssuePendingRegistrationParams {
  /** Email as the user typed it (becomes `users.email` at completion). */
  email: string;
  normalizedEmail: string;
  /** Argon2id hash of the submitted password. The raw password never crosses here. */
  passwordHash: string;
  displayName: string;
  /** SHA-256 hash of the raw completion token. The raw token never crosses here. */
  tokenHash: string;
  /** Stable invitation row ID (never the invitation token/hash), or null. */
  invitationId: string | null;
  expiresAt: Date;
  /** Current time, stamped onto invalidated predecessors. */
  now: Date;
}

/**
 * Invitation acceptance context for the completion transaction. The service
 * confirms the stored reference still RESOLVES before the transaction; when
 * it does not, it passes `null` context and the repository reports
 * `unavailable` without attempting acceptance. No plan-derived value crosses
 * this boundary — the acceptance transaction resolves the `max_members`
 * ceiling for itself (Sprint 20), so a stale pre-transaction plan read is
 * structurally impossible.
 */
export interface CompletionInvitationContext {
  invitationId: string;
  /** Non-secret request metadata for the acceptance action events. */
  eventContext: {
    requestId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  };
}

/** Inputs for the atomic registration completion. */
export interface CompleteRegistrationParams {
  /** SHA-256 hash of the presented raw completion token. */
  tokenHash: string;
  session: {
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
  };
  refreshToken: {
    /** SHA-256 hash of the raw refresh token. The raw value is never persisted. */
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  };
  /**
   * Invitation acceptance context (see above), or null for a plain
   * registration OR when the stored reference could not be resolved. The
   * repository distinguishes the two via the pending row's `invitationId`.
   */
  invitation: CompletionInvitationContext | null;
  now: Date;
}

/** How the completed registration's invitation was settled. */
export type CompletionInvitationOutcome = 'none' | 'accepted' | 'unavailable';

/**
 * Outcome of an atomic completion attempt. The repository classifies the
 * presented token purely on persisted state under a row lock; the service
 * owns the policy (which error each outcome maps to, what to record).
 *
 *  - `completed`    — the token was usable; the user (created email-VERIFIED),
 *                     personal workspace, founding Owner membership, session,
 *                     first refresh token, pending-registration consumption,
 *                     sibling invalidation, and (where applicable) invitation
 *                     acceptance all committed in ONE transaction.
 *  - `not_found`    — no pending registration matched the presented hash.
 *  - `expired`      — the (otherwise untouched) pending registration is past
 *                     its expiry.
 *  - `already_used` — the pending registration was consumed earlier, or was
 *                     invalidated/superseded by a newer request.
 *  - `email_taken`  — a user now exists for the staged normalized email (it
 *                     was taken through another path — e.g. an authenticated
 *                     email change — during the pending window). Nothing was
 *                     mutated; the service reports the generic invalid-token
 *                     error so account state is never disclosed.
 */
export type CompleteRegistrationResult =
  | {
      status: 'completed';
      user: UserRow;
      organization: OrganizationRow;
      membership: MembershipRow;
      session: SessionRow;
      refreshToken: RefreshTokenRow;
      invitation: CompletionInvitationOutcome;
    }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_used' }
  | { status: 'email_taken' };

export interface RegistrationRepository {
  findUserByNormalizedEmail(normalizedEmail: string): Promise<UserRow | null>;
  /**
   * Atomically stage one NEW usable pending-registration generation for the
   * normalized email: retire every prior unused generation (expired or not)
   * and insert the replacement, in one transaction SERIALIZED per normalized
   * email (the DB implementation takes a transaction-level advisory lock on
   * the normalized email first — invalidate-then-insert alone is not
   * race-safe under READ COMMITTED; the partial unique index on usable
   * generations is the structural backstop). After any set of concurrent
   * calls settles, exactly one usable generation exists for the email.
   */
  issuePendingRegistration(
    params: IssuePendingRegistrationParams,
  ): Promise<void>;
  /**
   * Non-locking pre-read of a pending registration by token hash, used ONLY
   * to resolve invitation completion context before the completion
   * transaction. Authoritative validation happens inside `completeRegistration`
   * under the row lock.
   */
  findPendingRegistrationByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRow | null>;
  /**
   * Atomically complete a registration by token hash. Implementations MUST
   * guarantee two concurrent calls with the same hash cannot both return
   * `completed` (row lock or equivalent), and MUST perform user creation,
   * personal-workspace provisioning, Owner-membership creation, session +
   * refresh-token persistence, invitation acceptance (where applicable),
   * pending-registration consumption, and sibling invalidation in ONE
   * transaction — a failure can never leave partial account state. Under the
   * documented invitation-unavailable policy, a failed invitation acceptance
   * rolls back ONLY the acceptance (savepoint) and the completion still
   * succeeds with `invitation: 'unavailable'`.
   */
  completeRegistration(
    params: CompleteRegistrationParams,
  ): Promise<CompleteRegistrationResult>;
  insertSecurityEvent(values: NewSecurityEvent): Promise<void>;
}
