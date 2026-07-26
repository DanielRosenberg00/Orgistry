import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { requireRow } from '../../lib/db-rows';
import { isUniqueViolation } from '../../lib/pg-errors';
import { emailAlreadyRegisteredError } from './auth.errors';
import type {
  AuthRepository,
  ChangeEmailParams,
  ChangePasswordParams,
  ListSessionsParams,
  NewRefreshToken,
  NewSecurityEvent,
  NewSession,
  RotateRefreshTokenParams,
  RotateRefreshTokenResult,
} from './auth.types';

/**
 * Drizzle-backed implementation of the auth persistence boundary. All SQL for
 * the auth module lives here; the service depends only on `AuthRepository`.
 */
export function createDbAuthRepository(db: Database): AuthRepository {
  return {
    async findUserByNormalizedEmail(normalizedEmail) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.normalizedEmail, normalizedEmail))
        .limit(1);
      return user ?? null;
    },

    async findUserById(id) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      return user ?? null;
    },

    async insertSession(values: NewSession) {
      const inserted = await db
        .insert(schema.sessions)
        .values({
          userId: values.userId,
          ipAddress: values.ipAddress,
          userAgent: values.userAgent,
          expiresAt: values.expiresAt,
        })
        .returning();
      return requireRow(inserted, 'sessions insert');
    },

    async findSessionById(id) {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .limit(1);
      return session ?? null;
    },

    async insertRefreshToken(values: NewRefreshToken) {
      const inserted = await db
        .insert(schema.refreshTokens)
        .values({
          sessionId: values.sessionId,
          familyId: values.familyId,
          tokenHash: values.tokenHash,
          parentTokenId: values.parentTokenId,
          expiresAt: values.expiresAt,
        })
        .returning();
      return requireRow(inserted, 'refresh_tokens insert');
    },

    async findRefreshTokenByHash(tokenHash) {
      const [token] = await db
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return token ?? null;
    },

    /**
     * Atomic rotation. The presented token row is locked `FOR UPDATE` for the
     * duration of the transaction, so two concurrent refreshes serialize: the
     * first marks the row used and inserts a successor; the second then sees a
     * used row and is classified as `reuse`. Exactly one successor can ever be
     * minted per presented token.
     */
    rotateRefreshToken(
      params: RotateRefreshTokenParams,
    ): Promise<RotateRefreshTokenResult> {
      return db.transaction(async (tx) => {
        const [token] = await tx
          .select()
          .from(schema.refreshTokens)
          .where(eq(schema.refreshTokens.tokenHash, params.presentedTokenHash))
          .for('update')
          .limit(1);

        if (!token) {
          return { status: 'not_found' };
        }

        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, token.sessionId))
          .limit(1);

        // Already consumed in any way -> the whole family is compromised.
        const alreadyConsumed =
          token.usedAt !== null ||
          token.revokedAt !== null ||
          token.replacementTokenId !== null;
        if (alreadyConsumed) {
          return {
            status: 'reuse',
            familyId: token.familyId,
            sessionId: token.sessionId,
            userId: session?.userId ?? null,
          };
        }

        // A token whose session is gone/revoked/expired is treated as reuse.
        const sessionInvalid =
          !session ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= params.now.getTime();
        if (sessionInvalid) {
          return {
            status: 'reuse',
            familyId: token.familyId,
            sessionId: token.sessionId,
            userId: session?.userId ?? null,
          };
        }

        if (token.expiresAt.getTime() <= params.now.getTime()) {
          return { status: 'expired' };
        }

        const successor = requireRow(
          await tx
            .insert(schema.refreshTokens)
            .values({
              sessionId: token.sessionId,
              familyId: token.familyId,
              tokenHash: params.successorTokenHash,
              parentTokenId: token.id,
              expiresAt: params.successorExpiresAt,
            })
            .returning(),
          'refresh_tokens successor insert',
        );

        await tx
          .update(schema.refreshTokens)
          .set({ usedAt: params.now, replacementTokenId: successor.id })
          .where(eq(schema.refreshTokens.id, token.id));

        await tx
          .update(schema.sessions)
          .set({ updatedAt: params.now })
          .where(eq(schema.sessions.id, session.id));

        return { status: 'rotated', successor, session };
      });
    },

    async revokeRefreshTokenFamily(familyId, reason) {
      await db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(
          and(
            eq(schema.refreshTokens.familyId, familyId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );
    },

    async revokeRefreshTokensForSession(sessionId, reason) {
      await db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(
          and(
            eq(schema.refreshTokens.sessionId, sessionId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );
    },

    async revokeSession(sessionId, reason) {
      const now = new Date();
      await db
        .update(schema.sessions)
        .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            isNull(schema.sessions.revokedAt),
          ),
        );
    },

    async listActiveSessionsForUser(params: ListSessionsParams) {
      const now = new Date();
      // Keyset pagination on (created_at desc, id desc). The cursor is the last
      // row of the previous page; rows strictly "after" it (older) come next.
      const cursorClause = params.cursor
        ? or(
            lt(
              schema.sessions.createdAt,
              new Date(params.cursor.createdAtMs),
            ),
            and(
              eq(
                schema.sessions.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.sessions.id, params.cursor.id),
            ),
          )
        : undefined;

      return db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, params.userId),
            isNull(schema.sessions.revokedAt),
            gt(schema.sessions.expiresAt, now),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id))
        .limit(params.limit + 1);
    },

    // Sprint 17: password change keeping ONLY the caller's session. One
    // transaction swaps the hash and revokes everything else, so a partial
    // failure can never leave a new password with foreign sessions alive.
    async changePasswordKeepingCurrentSession(params: ChangePasswordParams) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.users)
          .set({ passwordHash: params.newPasswordHash, updatedAt: params.now })
          .where(eq(schema.users.id, params.userId));

        // Every OTHER active session dies…
        await tx
          .update(schema.sessions)
          .set({
            revokedAt: params.now,
            revokedReason: params.revokeReason,
            updatedAt: params.now,
          })
          .where(
            and(
              eq(schema.sessions.userId, params.userId),
              ne(schema.sessions.id, params.currentSessionId),
              isNull(schema.sessions.revokedAt),
            ),
          );

        // …together with every refresh token NOT belonging to the surviving
        // session (including tokens of sessions revoked earlier for other
        // reasons — nothing pre-change may refresh except the caller's own
        // still-valid chain).
        const otherSessionIds = tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.userId, params.userId),
              ne(schema.sessions.id, params.currentSessionId),
            ),
          );
        await tx
          .update(schema.refreshTokens)
          .set({ revokedAt: params.now, revokedReason: params.revokeReason })
          .where(
            and(
              inArray(schema.refreshTokens.sessionId, otherSessionIds),
              isNull(schema.refreshTokens.revokedAt),
            ),
          );
      });
    },

    // Sprint 17: direct email change. The same transaction clears the
    // verification state and retires every outstanding verification token, so
    // a committed change can never leave the old address verified or
    // verifiable.
    async changeEmail(params: ChangeEmailParams) {
      return db.transaction(async (tx) => {
        let updatedRows;
        try {
          updatedRows = await tx
            .update(schema.users)
            .set({
              email: params.email,
              normalizedEmail: params.normalizedEmail,
              emailVerifiedAt: null,
              updatedAt: params.now,
            })
            .where(eq(schema.users.id, params.userId))
            .returning();
        } catch (error) {
          // The unique index on normalized_email is the authoritative guard;
          // surface the same public conflict as registration.
          if (isUniqueViolation(error)) {
            throw emailAlreadyRegisteredError();
          }
          throw error;
        }

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

        return requireRow(updatedRows, 'users email update');
      });
    },

    async insertSecurityEvent(values: NewSecurityEvent) {
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
