import type { EmailVerificationTokenRow, UserRow } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import type { NewSecurityEvent } from '../auth.types';
import type {
  CompleteVerificationResult,
  EmailVerificationRepository,
  IssueVerificationTokenParams,
} from '../email-verification.types';

/**
 * In-memory `EmailVerificationRepository` for unit tests.
 *
 * Mirrors the database repository's observable behavior over a SHARED user
 * array (pass the auth repo's `users` so registration and verification see the
 * same accounts). Persisted state is exposed for assertions.
 *
 * Completion atomicity: the read-classify-write body has NO intervening
 * `await`, so under Node's single-threaded model two concurrent calls
 * serialize exactly as the DB's `FOR UPDATE` lock would — the second observes
 * the consumed row and classifies as `already_used`.
 */
export interface InMemoryEmailVerificationRepository
  extends EmailVerificationRepository {
  readonly tokens: EmailVerificationTokenRow[];
  readonly securityEvents: NewSecurityEvent[];
}

export function createInMemoryEmailVerificationRepository(options: {
  /** Shared user table (the auth repo's `users`). */
  users: UserRow[];
  /** Shared event sink; defaults to a private array. */
  securityEvents?: NewSecurityEvent[];
}): InMemoryEmailVerificationRepository {
  const { users } = options;
  const tokens: EmailVerificationTokenRow[] = [];
  const securityEvents = options.securityEvents ?? [];

  return {
    tokens,
    securityEvents,

    async findUserById(id) {
      return users.find((user) => user.id === id) ?? null;
    },

    async issueVerificationToken(params: IssueVerificationTokenParams) {
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
        id: createId('evtok'),
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        usedAt: null,
        invalidatedAt: null,
        createdAt: params.now,
      });
    },

    // Synchronous body (no await) -> atomic under the single-threaded loop.
    async completeVerification(params): Promise<CompleteVerificationResult> {
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
        return { status: 'user_not_verifiable' };
      }

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
      const alreadyVerified = user.emailVerifiedAt !== null;
      if (!alreadyVerified) {
        user.emailVerifiedAt = params.now;
        user.updatedAt = params.now;
      }
      return { status: 'verified', user, alreadyVerified };
    },

    async insertSecurityEvent(values) {
      securityEvents.push(values);
    },
  };
}
