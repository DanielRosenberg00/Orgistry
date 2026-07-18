import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type {
  CompleteVerificationResult,
  EmailVerificationRepository,
  IssueVerificationTokenParams,
} from './email-verification.types';

/**
 * Drizzle-backed email-verification persistence (Sprint 16). All SQL for the
 * verification lifecycle lives here; the service depends only on
 * `EmailVerificationRepository`.
 *
 * Concurrency model for completion: the token row is read with
 * `SELECT … FOR UPDATE`, so two concurrent completions of the same token
 * serialize at the database — the second transaction blocks until the first
 * commits, then observes `used_at`/`invalidated_at` set and classifies as
 * `already_used`. The user timestamp update is additionally conditional
 * (`email_verified_at IS NULL`), so it is set exactly once, ever.
 */
export function createDbEmailVerificationRepository(
  db: Database,
): EmailVerificationRepository {
  return {
    async findUserById(id) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      return user ?? null;
    },

    async issueVerificationToken(params: IssueVerificationTokenParams) {
      await db.transaction(async (tx) => {
        // Resend replacement policy: retire EVERY unused, un-invalidated
        // predecessor in the same transaction that inserts the replacement, so
        // at most one usable token generation ever exists per user.
        await tx
          .update(schema.emailVerificationTokens)
          .set({ invalidatedAt: params.now })
          .where(
            and(
              eq(schema.emailVerificationTokens.userId, params.userId),
              isNull(schema.emailVerificationTokens.usedAt),
              isNull(schema.emailVerificationTokens.invalidatedAt),
            ),
          );
        await tx.insert(schema.emailVerificationTokens).values({
          userId: params.userId,
          tokenHash: params.tokenHash,
          expiresAt: params.expiresAt,
        });
      });
    },

    async completeVerification(params): Promise<CompleteVerificationResult> {
      return db.transaction(async (tx) => {
        // Row lock serializes concurrent completions of the same token.
        const [token] = await tx
          .select()
          .from(schema.emailVerificationTokens)
          .where(eq(schema.emailVerificationTokens.tokenHash, params.tokenHash))
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
          return { status: 'user_not_verifiable' };
        }

        await tx
          .update(schema.emailVerificationTokens)
          .set({ usedAt: params.now })
          .where(eq(schema.emailVerificationTokens.id, token.id));
        // Retire any other still-active token for this user (single-use family).
        await tx
          .update(schema.emailVerificationTokens)
          .set({ invalidatedAt: params.now })
          .where(
            and(
              eq(schema.emailVerificationTokens.userId, token.userId),
              ne(schema.emailVerificationTokens.id, token.id),
              isNull(schema.emailVerificationTokens.usedAt),
              isNull(schema.emailVerificationTokens.invalidatedAt),
            ),
          );

        const alreadyVerified = user.emailVerifiedAt !== null;
        if (!alreadyVerified) {
          // Conditional: set-once semantics even if a competing path raced us.
          await tx
            .update(schema.users)
            .set({ emailVerifiedAt: params.now, updatedAt: params.now })
            .where(
              and(
                eq(schema.users.id, user.id),
                isNull(schema.users.emailVerifiedAt),
              ),
            );
        }

        return { status: 'verified', user, alreadyVerified };
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
