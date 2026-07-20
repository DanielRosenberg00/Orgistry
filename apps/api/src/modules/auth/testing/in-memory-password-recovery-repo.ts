import type {
  PasswordResetTokenRow,
  RefreshTokenRow,
  SessionRow,
  UserRow,
} from '@orgistry/db';
import { createId } from '@orgistry/shared';
import type { NewSecurityEvent } from '../auth.types';
import type {
  CompleteResetParams,
  CompleteResetResult,
  IssueResetTokenParams,
  PasswordRecoveryRepository,
} from '../password-recovery.types';

/** Mirrors the DB repo's revocation reason for reset-driven revocations. */
const REVOKE_REASON_PASSWORD_RESET = 'password_reset';

/**
 * In-memory `PasswordRecoveryRepository` for unit tests.
 *
 * Mirrors the database repository's observable behavior over SHARED auth
 * tables (pass the auth repo's `users`, `sessions`, and `refreshTokens` so a
 * completed reset revokes the very sessions the auth flows created). Persisted
 * state is exposed for assertions.
 *
 * Atomicity model: issuance and completion bodies have NO intervening
 * `await`, so under Node's single-threaded event loop each call runs to
 * completion before another starts — the same OBSERVABLE invariants the DB
 * repo enforces with `FOR UPDATE` locks (one usable token per user after
 * concurrent issuance; at most one successful completion per token). This
 * models the invariant for unit tests; it does NOT prove PostgreSQL
 * concurrency — that proof lives in `password-recovery.integration.test.ts`.
 */
export interface InMemoryPasswordRecoveryRepository
  extends PasswordRecoveryRepository {
  readonly tokens: PasswordResetTokenRow[];
  readonly securityEvents: NewSecurityEvent[];
}

export function createInMemoryPasswordRecoveryRepository(options: {
  /** Shared auth tables (the auth repo's arrays). */
  users: UserRow[];
  sessions: SessionRow[];
  refreshTokens: RefreshTokenRow[];
  /** Shared event sink; defaults to a private array. */
  securityEvents?: NewSecurityEvent[];
}): InMemoryPasswordRecoveryRepository {
  const { users, sessions, refreshTokens } = options;
  const tokens: PasswordResetTokenRow[] = [];
  const securityEvents = options.securityEvents ?? [];

  return {
    tokens,
    securityEvents,

    async findUserByNormalizedEmail(normalizedEmail) {
      return (
        users.find((user) => user.normalizedEmail === normalizedEmail) ?? null
      );
    },

    async issueResetToken(params: IssueResetTokenParams) {
      for (const token of tokens) {
        if (
          token.userId === params.userId &&
          token.usedAt === null &&
          token.invalidatedAt === null
        ) {
          token.invalidatedAt = params.now;
        }
      }
      tokens.push({
        id: createId('prtok'),
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        usedAt: null,
        invalidatedAt: null,
        createdAt: params.now,
      });
    },

    // Synchronous body (no await) -> atomic under the single-threaded loop.
    async completeReset(
      params: CompleteResetParams,
    ): Promise<CompleteResetResult> {
      const token = tokens.find(
        (candidate) => candidate.tokenHash === params.tokenHash,
      );
      if (!token) {
        return { status: 'not_found' };
      }
      if (token.usedAt !== null || token.invalidatedAt !== null) {
        return { status: 'already_used' };
      }
      if (token.expiresAt.getTime() <= params.now.getTime()) {
        return { status: 'expired' };
      }

      const user = users.find((candidate) => candidate.id === token.userId);
      if (!user || user.status !== 'active' || user.deletedAt !== null) {
        return { status: 'user_not_recoverable' };
      }

      user.passwordHash = params.newPasswordHash;
      user.updatedAt = params.now;

      token.usedAt = params.now;
      for (const sibling of tokens) {
        if (
          sibling.userId === token.userId &&
          sibling.id !== token.id &&
          sibling.usedAt === null &&
          sibling.invalidatedAt === null
        ) {
          sibling.invalidatedAt = params.now;
        }
      }

      const userSessionIds = new Set<string>();
      for (const session of sessions) {
        if (session.userId === user.id) {
          userSessionIds.add(session.id);
          if (session.revokedAt === null) {
            session.revokedAt = params.now;
            session.revokedReason = REVOKE_REASON_PASSWORD_RESET;
            session.updatedAt = params.now;
          }
        }
      }
      for (const refreshToken of refreshTokens) {
        if (
          userSessionIds.has(refreshToken.sessionId) &&
          refreshToken.revokedAt === null
        ) {
          refreshToken.revokedAt = params.now;
          refreshToken.revokedReason = REVOKE_REASON_PASSWORD_RESET;
        }
      }

      return { status: 'reset', user };
    },

    async insertSecurityEvent(values) {
      securityEvents.push(values);
    },
  };
}
