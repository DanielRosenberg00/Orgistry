import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { ERROR_CODES } from '@orgistry/contracts';
import { AppError } from '../../lib/errors';
import { acceptInvitationWithinTransaction } from '../invitations/invitation.acceptance';
import {
  insertOrganizationWithOwnerMembership,
  personalWorkspaceName,
  personalWorkspaceSlugBase,
  resolveUniqueSlug,
} from '../organization/organization.provisioning';
import type {
  CompleteRegistrationParams,
  CompleteRegistrationResult,
  CompletionInvitationOutcome,
  IssuePendingRegistrationParams,
  RegistrationRepository,
} from './registration.types';

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';
/** The one-account-per-normalized-email unique index on `users`. */
const USERS_EMAIL_CONSTRAINT = 'uq_users_normalized_email';

function isUsersEmailUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION &&
    'constraint_name' in error &&
    (error as { constraint_name?: unknown }).constraint_name ===
      USERS_EMAIL_CONSTRAINT
  );
}

/**
 * The invitation-unavailable classification (Sprint 18 documented policy):
 * these stable codes mean "the invitation itself can no longer be honored" —
 * lifecycle (invalid/expired/revoked/accepted), email binding, quota, or an
 * already-active membership. Any of them rolls back ONLY the acceptance
 * savepoint; the account creation still commits. Anything else is an
 * unexpected failure and aborts the whole completion.
 */
const INVITATION_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.INVITATION_INVALID,
  ERROR_CODES.INVITATION_EXPIRED,
  ERROR_CODES.INVITATION_REVOKED,
  ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
  ERROR_CODES.INVITATION_EMAIL_MISMATCH,
  ERROR_CODES.QUOTA_EXCEEDED,
  ERROR_CODES.CONFLICT,
]);

export function isInvitationUnavailableError(error: unknown): boolean {
  return error instanceof AppError && INVITATION_UNAVAILABLE_CODES.has(error.code);
}

/**
 * Drizzle-backed verification-first registration persistence (Sprint 18). All
 * SQL for the pending-registration lifecycle lives here; the service depends
 * only on `RegistrationRepository`.
 *
 * Concurrency model:
 *  - ISSUANCE is serialized per normalized email by a TRANSACTION-LEVEL
 *    ADVISORY LOCK (there is no user row to lock — the whole point is that no
 *    user exists yet). Two concurrent requests for the same email queue on
 *    the lock; the second then sees (and retires) the first generation, so
 *    exactly one usable generation survives. The partial unique index
 *    `uq_pending_registrations_usable_email` is the structural backstop.
 *  - COMPLETION locks the pending row `SELECT … FOR UPDATE`, so two
 *    concurrent completions of the same token serialize — the second observes
 *    `used_at` set and classifies as `already_used`. Exactly one attempt can
 *    ever create the account.
 */
export function createDbRegistrationRepository(
  db: Database,
): RegistrationRepository {
  return {
    async findUserByNormalizedEmail(normalizedEmail) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.normalizedEmail, normalizedEmail))
        .limit(1);
      return user ?? null;
    },

    async issuePendingRegistration(params: IssuePendingRegistrationParams) {
      await db.transaction(async (tx) => {
        // Serialize issuance per normalized email (see the module doc). The
        // lock key is derived from the email INSIDE PostgreSQL via
        // hashtextextended; the email itself is a bind parameter, never
        // interpolated, and nothing about the lock persists past commit.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_registration:' + params.normalizedEmail}, 0))`,
        );

        // Retire EVERY prior unused generation — expired or not — so the
        // partial unique index never blocks the replacement insert and older
        // emailed links fail safely as superseded.
        await tx
          .update(schema.pendingRegistrations)
          .set({ invalidatedAt: params.now })
          .where(
            and(
              eq(
                schema.pendingRegistrations.normalizedEmail,
                params.normalizedEmail,
              ),
              isNull(schema.pendingRegistrations.usedAt),
              isNull(schema.pendingRegistrations.invalidatedAt),
            ),
          );

        await tx.insert(schema.pendingRegistrations).values({
          email: params.email,
          normalizedEmail: params.normalizedEmail,
          passwordHash: params.passwordHash,
          displayName: params.displayName,
          tokenHash: params.tokenHash,
          invitationId: params.invitationId,
          expiresAt: params.expiresAt,
        });
      });
    },

    async findPendingRegistrationByTokenHash(tokenHash) {
      const [pending] = await db
        .select()
        .from(schema.pendingRegistrations)
        .where(eq(schema.pendingRegistrations.tokenHash, tokenHash))
        .limit(1);
      return pending ?? null;
    },

    async completeRegistration(
      params: CompleteRegistrationParams,
    ): Promise<CompleteRegistrationResult> {
      try {
        return await db.transaction(async (tx) => {
          // Row lock serializes concurrent completions of the same token.
          const [pending] = await tx
            .select()
            .from(schema.pendingRegistrations)
            .where(eq(schema.pendingRegistrations.tokenHash, params.tokenHash))
            .limit(1)
            .for('update');
          if (!pending) {
            return { status: 'not_found' };
          }
          if (pending.usedAt !== null || pending.invalidatedAt !== null) {
            return { status: 'already_used' };
          }
          if (pending.expiresAt.getTime() <= params.now.getTime()) {
            return { status: 'expired' };
          }

          // Completion-time invariant: no user may exist for this email. The
          // pending window admits an account arriving through another path
          // (an authenticated email change). Friendly pre-check here; the
          // unique index on users.normalized_email is the authoritative guard
          // (a violation is mapped to the same outcome below).
          const [existing] = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.normalizedEmail, pending.normalizedEmail))
            .limit(1);
          if (existing) {
            return { status: 'email_taken' };
          }

          // 1. User — created EMAIL-VERIFIED: completing the emailed token IS
          //    the proof of mailbox control, so no separate verification pass
          //    is ever needed for a verification-first account.
          const [user] = await tx
            .insert(schema.users)
            .values({
              email: pending.email,
              normalizedEmail: pending.normalizedEmail,
              passwordHash: pending.passwordHash,
              displayName: pending.displayName,
              emailVerifiedAt: params.now,
            })
            .returning();

          // 2. Personal workspace: organization + active Owner membership +
          //    default plan state, via the shared provisioning seam.
          const slug = await resolveUniqueSlug(
            tx,
            personalWorkspaceSlugBase(pending.displayName),
          );
          const { organization, membership } =
            await insertOrganizationWithOwnerMembership(tx, {
              type: 'personal',
              name: personalWorkspaceName(pending.displayName),
              slug,
              createdByUserId: user.id,
              ownerUserId: user.id,
            });

          // 3. Session + first refresh token of a new family (hash-only).
          const [session] = await tx
            .insert(schema.sessions)
            .values({
              userId: user.id,
              ipAddress: params.session.ipAddress,
              userAgent: params.session.userAgent,
              expiresAt: params.session.expiresAt,
            })
            .returning();
          const [refreshToken] = await tx
            .insert(schema.refreshTokens)
            .values({
              sessionId: session.id,
              familyId: params.refreshToken.familyId,
              tokenHash: params.refreshToken.tokenHash,
              parentTokenId: null,
              expiresAt: params.refreshToken.expiresAt,
            })
            .returning();

          // 4. Invitation acceptance — inside a SAVEPOINT (nested
          //    transaction) so the documented invitation-unavailable policy
          //    holds: a no-longer-honorable invitation rolls back only the
          //    acceptance, never the account. The invitation lifecycle,
          //    email match, duplicate membership, and quota are all
          //    re-checked by the shared acceptance seam under a row lock.
          const invitationOutcome = await settleInvitation(
            tx,
            pending.invitationId,
            params,
            user.id,
            pending.normalizedEmail,
          );

          // 5. Consume the pending registration and retire any sibling
          //    generation that somehow remains unused (issuance already
          //    invalidates predecessors; this is the structural guarantee).
          await tx
            .update(schema.pendingRegistrations)
            .set({ usedAt: params.now })
            .where(eq(schema.pendingRegistrations.id, pending.id));
          await tx
            .update(schema.pendingRegistrations)
            .set({ invalidatedAt: params.now })
            .where(
              and(
                eq(
                  schema.pendingRegistrations.normalizedEmail,
                  pending.normalizedEmail,
                ),
                ne(schema.pendingRegistrations.id, pending.id),
                isNull(schema.pendingRegistrations.usedAt),
                isNull(schema.pendingRegistrations.invalidatedAt),
              ),
            );

          return {
            status: 'completed',
            user,
            organization,
            membership,
            session,
            refreshToken,
            invitation: invitationOutcome,
          };
        });
      } catch (error) {
        // The users unique index caught a race the pre-check missed (an
        // account for this email committed concurrently). The transaction has
        // rolled back — nothing was created — and the service reports the
        // same non-disclosing outcome as the pre-check.
        if (isUsersEmailUniqueViolation(error)) {
          return { status: 'email_taken' };
        }
        throw error;
      }
    },

    async insertSecurityEvent(values) {
      await db.insert(schema.securityEvents).values({
        userId: values.userId,
        sessionId: values.sessionId,
        actorType: values.actorType,
        eventType: values.eventType,
        metadata: values.metadata,
        ipAddress: values.ipAddress,
        userAgent: values.userAgent,
        requestId: values.requestId,
      });
    },
  };
}

type CompletionTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

/**
 * Settle the invitation side of a completion (see step 4 above). Returns:
 *  - 'none'        — the pending registration carried no invitation;
 *  - 'accepted'    — the membership was created and the invitation marked
 *                    accepted, atomically with the account;
 *  - 'unavailable' — the stored reference no longer resolves, the caller
 *                    could not supply completion context, or the shared
 *                    acceptance seam rejected it for a lifecycle/quota
 *                    reason. Only the acceptance savepoint is rolled back.
 */
async function settleInvitation(
  tx: CompletionTransaction,
  pendingInvitationId: string | null,
  params: CompleteRegistrationParams,
  newUserId: string,
  normalizedEmail: string,
): Promise<CompletionInvitationOutcome> {
  if (pendingInvitationId === null) {
    return 'none';
  }
  const context = params.invitation;
  if (context === null || context.invitationId !== pendingInvitationId) {
    return 'unavailable';
  }
  try {
    await tx.transaction(async (savepoint) => {
      await acceptInvitationWithinTransaction(savepoint, {
        selector: { invitationId: pendingInvitationId },
        acceptingUserId: newUserId,
        acceptingUserNormalizedEmail: normalizedEmail,
        maxMembers: context.maxMembers,
        ctx: {
          actorUserId: newUserId,
          actorMembershipId: null,
          requestId: context.eventContext.requestId,
          ipAddress: context.eventContext.ipAddress,
          userAgent: context.eventContext.userAgent,
        },
      });
    });
    return 'accepted';
  } catch (error) {
    if (isInvitationUnavailableError(error)) {
      return 'unavailable';
    }
    throw error;
  }
}
