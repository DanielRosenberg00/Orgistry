import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { eq } from 'drizzle-orm';
import { emailAlreadyRegisteredError } from './auth.errors';
import type {
  AuthRepository,
  NewSecurityEvent,
  NewSession,
  NewUser,
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
