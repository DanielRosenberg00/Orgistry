import {
  type EmailVerificationTokenRow,
  type RefreshTokenRow,
  type SessionRow,
  type UserRow,
} from '@orgistry/db';
import { createId } from '@orgistry/shared';
import {
  createInMemoryOrgStore,
  type InMemoryOrgStore,
} from '../../organization/testing/in-memory-org-store';
import { emailAlreadyRegisteredError } from '../auth.errors';
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
} from '../auth.types';

/**
 * In-memory `AuthRepository` for unit tests.
 *
 * It mirrors the database repository's observable behavior — generating
 * prefixed IDs and timestamps, enforcing the normalized-email uniqueness
 * constraint, and applying the same refresh-rotation classification — so the
 * auth workflows can be exercised end-to-end through the HTTP layer with no
 * PostgreSQL. Persisted state is exposed for assertions.
 *
 * Rotation atomicity: `rotateRefreshToken` performs its read-classify-write
 * with NO intervening `await`, so under Node's single-threaded model two
 * concurrent calls serialize exactly as the DB's `FOR UPDATE` lock would — the
 * second sees a used row and is classified as reuse.
 */
export interface InMemoryAuthRepository extends AuthRepository {
  readonly users: UserRow[];
  readonly sessions: SessionRow[];
  readonly refreshTokens: RefreshTokenRow[];
  readonly securityEvents: NewSecurityEvent[];
  /** Shared organization persistence (also read by the organization repo). */
  readonly orgStore: InMemoryOrgStore;
}

export function createInMemoryAuthRepository(options?: {
  /**
   * Organization store registration writes its personal workspace into. Pass a
   * shared store so the organization repo sees registrations; defaults to a
   * private store for auth-only suites that don't inspect organizations.
   */
  orgStore?: InMemoryOrgStore;
  /**
   * Shared email-verification token table (the verification repo's `tokens`).
   * `changeEmail` invalidates outstanding tokens here, mirroring the DB
   * transaction. Defaults to a private array for suites that don't verify.
   */
  emailVerificationTokens?: EmailVerificationTokenRow[];
}): InMemoryAuthRepository {
  const sessions: SessionRow[] = [];
  const refreshTokens: RefreshTokenRow[] = [];
  const securityEvents: NewSecurityEvent[] = [];
  const emailVerificationTokens = options?.emailVerificationTokens ?? [];
  const orgStore = options?.orgStore ?? createInMemoryOrgStore();
  // One shared user table, exactly like the database: registration writes users
  // here and the organization repo joins them for member listings.
  const users = orgStore.users;

  function makeSession(values: NewSession): SessionRow {
    const now = new Date();
    return {
      id: createId('sess'),
      userId: values.userId,
      ipAddress: values.ipAddress,
      userAgent: values.userAgent,
      clientName: null,
      expiresAt: values.expiresAt,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    users,
    sessions,
    refreshTokens,
    securityEvents,
    orgStore,

    async findUserByNormalizedEmail(normalizedEmail) {
      return (
        users.find((user) => user.normalizedEmail === normalizedEmail) ?? null
      );
    },

    async findUserById(id) {
      return users.find((user) => user.id === id) ?? null;
    },

    async insertSession(values: NewSession) {
      const session = makeSession(values);
      sessions.push(session);
      return session;
    },

    async findSessionById(id) {
      return sessions.find((session) => session.id === id) ?? null;
    },

    async insertRefreshToken(values: NewRefreshToken) {
      const token: RefreshTokenRow = {
        id: createId('rtok'),
        sessionId: values.sessionId,
        tokenHash: values.tokenHash,
        familyId: values.familyId,
        parentTokenId: values.parentTokenId,
        replacementTokenId: null,
        usedAt: null,
        expiresAt: values.expiresAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: new Date(),
      };
      refreshTokens.push(token);
      return token;
    },

    async findRefreshTokenByHash(tokenHash) {
      return (
        refreshTokens.find((token) => token.tokenHash === tokenHash) ?? null
      );
    },

    // Synchronous body (no await) -> atomic under the single-threaded loop.
    async rotateRefreshToken(
      params: RotateRefreshTokenParams,
    ): Promise<RotateRefreshTokenResult> {
      const token = refreshTokens.find(
        (candidate) => candidate.tokenHash === params.presentedTokenHash,
      );
      if (!token) {
        return { status: 'not_found' };
      }

      const session = sessions.find((s) => s.id === token.sessionId);

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

      const successor: RefreshTokenRow = {
        id: createId('rtok'),
        sessionId: token.sessionId,
        tokenHash: params.successorTokenHash,
        familyId: token.familyId,
        parentTokenId: token.id,
        replacementTokenId: null,
        usedAt: null,
        expiresAt: params.successorExpiresAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: new Date(),
      };
      refreshTokens.push(successor);

      token.usedAt = params.now;
      token.replacementTokenId = successor.id;
      session.updatedAt = params.now;

      return { status: 'rotated', successor, session };
    },

    async revokeRefreshTokenFamily(familyId, reason) {
      const now = new Date();
      for (const token of refreshTokens) {
        if (token.familyId === familyId && token.revokedAt === null) {
          token.revokedAt = now;
          token.revokedReason = reason;
        }
      }
    },

    async revokeRefreshTokensForSession(sessionId, reason) {
      const now = new Date();
      for (const token of refreshTokens) {
        if (token.sessionId === sessionId && token.revokedAt === null) {
          token.revokedAt = now;
          token.revokedReason = reason;
        }
      }
    },

    async revokeSession(sessionId, reason) {
      const session = sessions.find((s) => s.id === sessionId);
      if (session && session.revokedAt === null) {
        const now = new Date();
        session.revokedAt = now;
        session.revokedReason = reason;
        session.updatedAt = now;
      }
    },

    async listActiveSessionsForUser(params: ListSessionsParams) {
      const now = Date.now();
      const ordered = sessions
        .filter(
          (session) =>
            session.userId === params.userId &&
            session.revokedAt === null &&
            session.expiresAt.getTime() > now,
        )
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          return byCreated !== 0 ? byCreated : (a.id < b.id ? 1 : -1);
        });

      const afterCursor = params.cursor
        ? ordered.filter((session) => {
            const created = session.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs &&
              session.id < params.cursor!.id
            );
          })
        : ordered;

      return afterCursor.slice(0, params.limit + 1);
    },

    // Synchronous body (no await) -> atomic under the single-threaded loop,
    // mirroring the DB repo's single transaction.
    async changePasswordKeepingCurrentSession(params: ChangePasswordParams) {
      const user = users.find((candidate) => candidate.id === params.userId);
      if (!user) {
        return;
      }
      user.passwordHash = params.newPasswordHash;
      user.updatedAt = params.now;

      const otherSessionIds = new Set<string>();
      for (const session of sessions) {
        if (
          session.userId === params.userId &&
          session.id !== params.currentSessionId
        ) {
          otherSessionIds.add(session.id);
          if (session.revokedAt === null) {
            session.revokedAt = params.now;
            session.revokedReason = params.revokeReason;
            session.updatedAt = params.now;
          }
        }
      }
      for (const token of refreshTokens) {
        if (otherSessionIds.has(token.sessionId) && token.revokedAt === null) {
          token.revokedAt = params.now;
          token.revokedReason = params.revokeReason;
        }
      }
    },

    // Mirrors the DB transaction: email swap + verification reset + token
    // invalidation applied together, with the uniqueness check first.
    async changeEmail(params: ChangeEmailParams) {
      const duplicate = users.some(
        (candidate) =>
          candidate.normalizedEmail === params.normalizedEmail &&
          candidate.id !== params.userId,
      );
      if (duplicate) {
        throw emailAlreadyRegisteredError();
      }
      const user = users.find((candidate) => candidate.id === params.userId);
      if (!user) {
        throw new Error(`changeEmail: unknown user ${params.userId}`);
      }
      user.email = params.email;
      user.normalizedEmail = params.normalizedEmail;
      user.emailVerifiedAt = null;
      user.updatedAt = params.now;

      for (const token of emailVerificationTokens) {
        if (
          token.userId === params.userId &&
          token.usedAt === null &&
          token.invalidatedAt === null
        ) {
          token.invalidatedAt = params.now;
        }
      }
      return user;
    },

    async insertSecurityEvent(values: NewSecurityEvent) {
      securityEvents.push(values);
    },
  };
}
