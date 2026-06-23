import {
  AccessTokenError,
  hashPassword,
  normalizeEmail,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from '@orgistry/auth-core';
import type { UserRow } from '@orgistry/db';
import type {
  AuthSessionResponse,
  AuthUser,
  LoginRequest,
  RegisterRequest,
} from '@orgistry/contracts';
import { type Clock, systemClock } from '@orgistry/shared';
import {
  emailAlreadyRegisteredError,
  invalidCredentialsError,
  unauthorizedError,
} from './auth.errors';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';
import type {
  AuthRepository,
  NewSecurityEvent,
  RequestContext,
} from './auth.types';

export interface AuthServiceOptions {
  repo: AuthRepository;
  /** Symmetric JWT signing secret (from `config.auth.jwtSecret`). */
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  clock?: Clock;
}

export interface AuthService {
  register(
    input: RegisterRequest,
    ctx: RequestContext,
  ): Promise<AuthSessionResponse>;
  login(input: LoginRequest, ctx: RequestContext): Promise<AuthSessionResponse>;
  authenticate(accessToken: string, ctx: RequestContext): Promise<AuthUser>;
}

/**
 * A precomputed Argon2id hash used to equalize login timing when the email is
 * unknown. Verifying the submitted password against this dummy hash makes the
 * "unknown email" and "wrong password" paths take comparable time, closing a
 * timing side channel for account enumeration. Memoized on first use.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(
    'orgistry-login-timing-equalizer-not-a-secret',
  );
  return dummyHashPromise;
}

/** Map a persistence row to the public, secret-free user DTO. */
function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const {
    repo,
    jwtSecret,
    accessTokenTtlSeconds,
    sessionTtlSeconds,
    clock = systemClock,
  } = options;

  /** Persist a sanitized security event. Best-effort context, never secrets. */
  async function writeSecurityEvent(event: {
    userId: string | null;
    sessionId: string | null;
    actorType: NewSecurityEvent['actorType'];
    eventType: string;
    metadata?: Record<string, unknown>;
    ctx: RequestContext;
  }): Promise<void> {
    await repo.insertSecurityEvent({
      userId: event.userId,
      sessionId: event.sessionId,
      actorType: event.actorType,
      eventType: event.eventType,
      metadata: sanitizeSecurityMetadata(event.metadata ?? {}),
      ipAddress: event.ctx.ipAddress,
      userAgent: event.ctx.userAgent,
      requestId: event.ctx.requestId,
    });
  }

  /** Create a session + access token for an authenticated user. */
  async function issueSession(
    user: UserRow,
    ctx: RequestContext,
  ): Promise<{ response: AuthSessionResponse; sessionId: string }> {
    const expiresAt = new Date(clock.epochMillis() + sessionTtlSeconds * 1000);
    const session = await repo.insertSession({
      userId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      expiresAt,
    });

    const accessToken = await signAccessToken({
      userId: user.id,
      sessionId: session.id,
      secret: jwtSecret,
      ttlSeconds: accessTokenTtlSeconds,
    });

    return {
      sessionId: session.id,
      response: {
        user: toAuthUser(user),
        tokens: {
          accessToken,
          tokenType: 'Bearer',
          expiresIn: accessTokenTtlSeconds,
        },
      },
    };
  }

  return {
    async register(input, ctx) {
      const normalizedEmail = normalizeEmail(input.email);

      // Friendly pre-check; the unique index is the authoritative guard for the
      // concurrent case (the repo maps a violation to the same conflict error).
      const existing = await repo.findUserByNormalizedEmail(normalizedEmail);
      if (existing) {
        throw emailAlreadyRegisteredError();
      }

      const passwordHash = await hashPassword(input.password);
      const user = await repo.insertUser({
        email: input.email,
        normalizedEmail,
        passwordHash,
        displayName: input.displayName,
      });

      const { response, sessionId } = await issueSession(user, ctx);
      await writeSecurityEvent({
        userId: user.id,
        sessionId,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.registrationSucceeded,
        ctx,
      });
      return response;
    },

    async login(input, ctx) {
      const normalizedEmail = normalizeEmail(input.email);
      const user = await repo.findUserByNormalizedEmail(normalizedEmail);

      // Unknown email: still spend the cost of a verify against a dummy hash so
      // response time does not betray account existence, then fail generically.
      if (!user || user.status !== 'active' || user.deletedAt !== null) {
        await verifyPassword(await getDummyHash(), input.password);
        await writeSecurityEvent({
          userId: user?.id ?? null,
          sessionId: null,
          actorType: user ? 'user' : 'anonymous',
          eventType: SECURITY_EVENT_TYPES.loginFailed,
          metadata: {
            normalizedEmail,
            reason: user ? 'inactive_account' : 'unknown_email',
          },
          ctx,
        });
        throw invalidCredentialsError();
      }

      const passwordOk = await verifyPassword(user.passwordHash, input.password);
      if (!passwordOk) {
        await writeSecurityEvent({
          userId: user.id,
          sessionId: null,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.loginFailed,
          metadata: { normalizedEmail, reason: 'bad_password' },
          ctx,
        });
        throw invalidCredentialsError();
      }

      const { response, sessionId } = await issueSession(user, ctx);
      await writeSecurityEvent({
        userId: user.id,
        sessionId,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.loginSucceeded,
        ctx,
      });
      return response;
    },

    async authenticate(accessToken, ctx) {
      let claims;
      try {
        claims = await verifyAccessToken(accessToken, jwtSecret);
      } catch (error) {
        if (error instanceof AccessTokenError) {
          await writeSecurityEvent({
            userId: null,
            sessionId: null,
            actorType: 'anonymous',
            eventType: SECURITY_EVENT_TYPES.accessTokenRejected,
            metadata: { reason: 'invalid_token' },
            ctx,
          });
          throw unauthorizedError();
        }
        throw error;
      }

      const user = await repo.findUserById(claims.sub);
      if (!user || user.status !== 'active' || user.deletedAt !== null) {
        // The user cannot be trusted from this token, so the event records no
        // user or session id (only the request context).
        await writeSecurityEvent({
          userId: null,
          sessionId: null,
          actorType: 'anonymous',
          eventType: SECURITY_EVENT_TYPES.accessTokenRejected,
          metadata: { reason: 'user_unavailable' },
          ctx,
        });
        throw unauthorizedError();
      }

      // The token is bound to a session. Reject it unless the session exists,
      // belongs to this same user, and is neither revoked nor expired. The
      // user-match check prevents a token from being honored against another
      // user's session. (Forward-compatible with logout/refresh.)
      const session = await repo.findSessionById(claims.sessionId);
      const sessionUntrusted =
        !session ||
        session.userId !== user.id ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= clock.epochMillis();
      if (sessionUntrusted) {
        // The user is trusted (valid, active, not deleted) but the session is
        // not, so attribute to the user and leave the session id null.
        await writeSecurityEvent({
          userId: user.id,
          sessionId: null,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.accessTokenRejected,
          metadata: { reason: 'session_invalid' },
          ctx,
        });
        throw unauthorizedError();
      }

      return toAuthUser(user);
    },
  };
}
