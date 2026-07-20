import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type {
  CompleteResetParams,
  CompleteResetResult,
  IssueResetTokenParams,
  PasswordRecoveryRepository,
} from './password-recovery.types';

/** Reason stamped on sessions/refresh tokens revoked by a completed reset. */
const REVOKE_REASON_PASSWORD_RESET = 'password_reset';

/**
 * Drizzle-backed password-recovery persistence (Sprint 17). All SQL for the
 * reset lifecycle lives here; the service depends only on
 * `PasswordRecoveryRepository`.
 *
 * Concurrency model for completion: the token row is read with
 * `SELECT … FOR UPDATE`, so two concurrent completions of the same token
 * serialize at the database — the second transaction blocks until the first
 * commits, then observes `used_at`/`invalidated_at` set and classifies as
 * `already_used`. Exactly one attempt can ever replace the password.
 */
export function createDbPasswordRecoveryRepository(
  db: Database,
): PasswordRecoveryRepository {
  return {
    async findUserByNormalizedEmail(normalizedEmail) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.normalizedEmail, normalizedEmail))
        .limit(1);
      return user ?? null;
    },

    async issueResetToken(params: IssueResetTokenParams) {
      await db.transaction(async (tx) => {
        // Serialize concurrent issuance per user: under READ COMMITTED, two
        // concurrent invalidate-then-insert transactions could each miss the
        // other's uncommitted insert and BOTH leave a usable token. Locking
        // the user row first makes the second transaction wait until the
        // first commits, so its invalidation step then sees (and retires)
        // the first generation — exactly one usable token survives.
        await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, params.userId))
          .limit(1)
          .for('update');

        await tx
          .update(schema.passwordResetTokens)
          .set({ invalidatedAt: params.now })
          .where(
            and(
              eq(schema.passwordResetTokens.userId, params.userId),
              isNull(schema.passwordResetTokens.usedAt),
              isNull(schema.passwordResetTokens.invalidatedAt),
            ),
          );
        await tx.insert(schema.passwordResetTokens).values({
          userId: params.userId,
          tokenHash: params.tokenHash,
          expiresAt: params.expiresAt,
        });
      });
    },

    async completeReset(params: CompleteResetParams): Promise<CompleteResetResult> {
      return db.transaction(async (tx) => {
        // Row lock serializes concurrent completions of the same token.
        const [token] = await tx
          .select()
          .from(schema.passwordResetTokens)
          .where(eq(schema.passwordResetTokens.tokenHash, params.tokenHash))
          .limit(1)
          .for('update');
        if (!token) {
          return { status: 'not_found' };
        }
        if (token.usedAt !== null || token.invalidatedAt !== null) {
          return { status: 'already_used' };
        }
        if (token.expiresAt.getTime() <= params.now.getTime()) {
          return { status: 'expired' };
        }

        const [user] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, token.userId))
          .limit(1)
          .for('update');
        if (!user || user.status !== 'active' || user.deletedAt !== null) {
          // Leave the token untouched; the transaction writes nothing.
          return { status: 'user_not_recoverable' };
        }

        // 1. Replace the password.
        await tx
          .update(schema.users)
          .set({ passwordHash: params.newPasswordHash, updatedAt: params.now })
          .where(eq(schema.users.id, user.id));

        // 2. Consume the presented token.
        await tx
          .update(schema.passwordResetTokens)
          .set({ usedAt: params.now })
          .where(eq(schema.passwordResetTokens.id, token.id));

        // 3. Retire any other still-active reset token for this user.
        await tx
          .update(schema.passwordResetTokens)
          .set({ invalidatedAt: params.now })
          .where(
            and(
              eq(schema.passwordResetTokens.userId, token.userId),
              ne(schema.passwordResetTokens.id, token.id),
              isNull(schema.passwordResetTokens.usedAt),
              isNull(schema.passwordResetTokens.invalidatedAt),
            ),
          );

        // 4. Revoke EVERY active session — the reset invalidates all prior
        //    authentication; the user must sign in again with the new password.
        const userSessionIds = tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.userId, user.id));
        await tx
          .update(schema.sessions)
          .set({
            revokedAt: params.now,
            revokedReason: REVOKE_REASON_PASSWORD_RESET,
            updatedAt: params.now,
          })
          .where(
            and(
              eq(schema.sessions.userId, user.id),
              isNull(schema.sessions.revokedAt),
            ),
          );

        // 5. Revoke every refresh token of every session of the user (revoked
        //    or not — an unrevoked token hanging off an old revoked session
        //    must also die), so no pre-reset cookie can ever mint a new access
        //    token.
        await tx
          .update(schema.refreshTokens)
          .set({
            revokedAt: params.now,
            revokedReason: REVOKE_REASON_PASSWORD_RESET,
          })
          .where(
            and(
              inArray(schema.refreshTokens.sessionId, userSessionIds),
              isNull(schema.refreshTokens.revokedAt),
            ),
          );

        return { status: 'reset', user };
      });
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
