import type { SessionRow, UserRow } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { emailAlreadyRegisteredError } from '../auth.errors';
import type {
  AuthRepository,
  NewSecurityEvent,
  NewSession,
  NewUser,
} from '../auth.types';

/**
 * In-memory `AuthRepository` for unit tests.
 *
 * It mirrors the database repository's observable behavior — generating
 * prefixed IDs and timestamps, and enforcing the normalized-email uniqueness
 * constraint — so the auth workflows can be exercised end-to-end through the
 * HTTP layer with no PostgreSQL. Persisted security events are exposed for
 * assertions.
 */
export interface InMemoryAuthRepository extends AuthRepository {
  readonly users: UserRow[];
  readonly sessions: SessionRow[];
  readonly securityEvents: NewSecurityEvent[];
}

export function createInMemoryAuthRepository(): InMemoryAuthRepository {
  const users: UserRow[] = [];
  const sessions: SessionRow[] = [];
  const securityEvents: NewSecurityEvent[] = [];

  return {
    users,
    sessions,
    securityEvents,

    async findUserByNormalizedEmail(normalizedEmail) {
      return (
        users.find((user) => user.normalizedEmail === normalizedEmail) ?? null
      );
    },

    async findUserById(id) {
      return users.find((user) => user.id === id) ?? null;
    },

    async insertUser(values: NewUser) {
      if (users.some((user) => user.normalizedEmail === values.normalizedEmail)) {
        throw emailAlreadyRegisteredError();
      }
      const now = new Date();
      const user: UserRow = {
        id: createId('user'),
        email: values.email,
        normalizedEmail: values.normalizedEmail,
        passwordHash: values.passwordHash,
        displayName: values.displayName,
        status: 'active',
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      users.push(user);
      return user;
    },

    async insertSession(values: NewSession) {
      const now = new Date();
      const session: SessionRow = {
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
      sessions.push(session);
      return session;
    },

    async findSessionById(id) {
      return sessions.find((session) => session.id === id) ?? null;
    },

    async insertSecurityEvent(values: NewSecurityEvent) {
      securityEvents.push(values);
    },
  };
}
