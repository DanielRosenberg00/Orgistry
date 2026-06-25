import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import {
  insertOrganizationWithOwnerMembership,
  resolveUniqueSlug,
} from '../organization/organization.provisioning';
import { acceptInvitationWithinTransaction } from '../invitations/invitation.acceptance';
import { emailAlreadyRegisteredError } from './auth.errors';
import type {
  AuthRepository,
  ListSessionsParams,
  NewRefreshToken,
  NewSecurityEvent,
  NewSession,
  NewUser,
  RegisterAccountParams,
  RotateRefreshTokenParams,
  RotateRefreshTokenResult,
} from './auth.types';

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

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

    async insertUser(values: NewUser) {
      try {
        const [user] = await db
          .insert(schema.users)
          .values({
            email: values.email,
            normalizedEmail: values.normalizedEmail,
            passwordHash: values.passwordHash,
            displayName: values.displayName,
          })
          .returning();
        return user;
      } catch (error) {
        // The unique index on normalized_email is the authoritative guard for
        // the concurrent-registration race; surface the same public conflict.
        if (isUniqueViolation(error)) {
          throw emailAlreadyRegisteredError();
        }
        throw error;
      }
    },

    registerAccount(params: RegisterAccountParams) {
      return db.transaction(async (tx) => {
        // 1. User. The unique index on normalized_email is the authoritative
        //    guard; a violation rolls back the whole transaction.
        let user;
        try {
          [user] = await tx
            .insert(schema.users)
            .values({
              email: params.user.email,
              normalizedEmail: params.user.normalizedEmail,
              passwordHash: params.user.passwordHash,
              displayName: params.user.displayName,
            })
            .returning();
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw emailAlreadyRegisteredError();
          }
          throw error;
        }

        // 2. Personal workspace: organization + active Owner membership. Slug is
        //    resolved to a unique value inside the same transaction.
        const slug = await resolveUniqueSlug(
          tx,
          params.personalWorkspace.slugBase,
        );
        const { organization, membership } =
          await insertOrganizationWithOwnerMembership(tx, {
            type: 'personal',
            name: params.personalWorkspace.name,
            slug,
            createdByUserId: user.id,
            ownerUserId: user.id,
          });

        // 3. Session.
        const [session] = await tx
          .insert(schema.sessions)
          .values({
            userId: user.id,
            ipAddress: params.session.ipAddress,
            userAgent: params.session.userAgent,
            expiresAt: params.session.expiresAt,
          })
          .returning();

        // 4. First refresh token of a new family (hash-only).
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

        // 5. (Sprint 9) Optionally accept an invitation IN THIS TRANSACTION, so
        //    the invited membership + invitation acceptance commit together with
        //    the new account, or the WHOLE registration rolls back. A revoked /
        //    expired / quota-filled invitation (a race after the pre-check) throws
        //    here, leaving no user, session, workspace, membership, or acceptance.
        if (params.invitationAcceptance) {
          await acceptInvitationWithinTransaction(tx, {
            tokenHash: params.invitationAcceptance.tokenHash,
            acceptingUserId: user.id,
            acceptingUserNormalizedEmail: params.user.normalizedEmail,
            maxMembers: params.invitationAcceptance.maxMembers,
            ctx: {
              actorUserId: user.id,
              actorMembershipId: null,
              requestId: params.invitationAcceptance.eventContext.requestId,
              ipAddress: params.invitationAcceptance.eventContext.ipAddress,
              userAgent: params.invitationAcceptance.eventContext.userAgent,
            },
          });
        }

        return { user, organization, membership, session, refreshToken };
      });
    },

    async insertSession(values: NewSession) {
      const [session] = await db
        .insert(schema.sessions)
        .values({
          userId: values.userId,
          ipAddress: values.ipAddress,
          userAgent: values.userAgent,
          expiresAt: values.expiresAt,
        })
        .returning();
      return session;
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
      const [token] = await db
        .insert(schema.refreshTokens)
        .values({
          sessionId: values.sessionId,
          familyId: values.familyId,
          tokenHash: values.tokenHash,
          parentTokenId: values.parentTokenId,
          expiresAt: values.expiresAt,
        })
        .returning();
      return token;
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

        const [successor] = await tx
          .insert(schema.refreshTokens)
          .values({
            sessionId: token.sessionId,
            familyId: token.familyId,
            tokenHash: params.successorTokenHash,
            parentTokenId: token.id,
            expiresAt: params.successorExpiresAt,
          })
          .returning();

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
