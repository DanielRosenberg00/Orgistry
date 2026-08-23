import {
  AccessTokenError,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  signAccessToken,
  verifyAccessTokenWithRotation,
  verifyPassword,
} from '@orgistry/auth-core';
import { ERROR_CODES } from '@orgistry/contracts';
import type { SessionRow, UserRow } from '@orgistry/db';
import type {
  AuthSessionResponse,
  AuthUser,
  ChangeEmailRequest,
  ChangeEmailResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  RefreshResponse,
  SessionListResponse,
  SessionSummary,
} from '@orgistry/contracts';
import {
  type Clock,
  createId,
  decodeCursor,
  encodeCursor,
  systemClock,
} from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import type {
  RateLimiter,
  RateLimitFailureMode,
} from '../../lib/rate-limit';
import {
  createNoopRateLimiter,
  enforceStoreAvailability,
} from '../../lib/rate-limit';
import {
  currentPasswordIncorrectError,
  emailUnchangedError,
  invalidCredentialsError,
  passwordUnchangedError,
  rateLimitedError,
  sessionNotFoundError,
  unauthorizedError,
} from './auth.errors';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';
import type {
  AuthRepository,
  EmailChangeVerification,
  NewSecurityEvent,
  RequestContext,
} from './auth.types';

/** Reasons recorded on revoked sessions/tokens. Internal, not client-facing. */
const REVOKE_REASONS = {
  reuseDetected: 'refresh_token_reuse_detected',
  logout: 'logout',
  sessionRevoked: 'session_revoked_by_user',
  passwordChanged: 'password_changed',
} as const;

/**
 * Per-bucket auth rate limits (from `config.rateLimit.auth`). Registration
 * buckets moved to the registration service in Sprint 18
 * (`config.rateLimit.registration`).
 */
export interface AuthRateLimits {
  windowSeconds: number;
  loginPerIpMax: number;
  loginPerEmailMax: number;
  refreshPerSessionMax: number;
  refreshPerIpMax: number;
  changePasswordPerUserMax: number;
  changeEmailPerUserMax: number;
}

export interface AuthServiceOptions {
  repo: AuthRepository;
  /** Symmetric JWT signing secret (from `config.auth.jwtSecret`). */
  jwtSecret: string;
  /**
   * Retiring JWT secret (from `config.auth.previousJwtSecret`, Sprint 24).
   * ADDITIONALLY accepted when verifying, never used to sign — this is what
   * keeps a `JWT_SECRET` rotation from invalidating access tokens already in
   * flight. Absent outside a rotation window.
   */
  previousJwtSecret?: string;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  rateLimits?: AuthRateLimits;
  /**
   * What to do when the limiter store cannot answer (Sprint 19, ORG-PR-009):
   * `open` allows the request, `closed` rejects with a generic 503. Wired
   * from `config.rateLimit.failureMode`; defaults open for test usability.
   */
  rateLimitFailureMode?: RateLimitFailureMode;
  /**
   * Post-email-change verification-email collaborator (Sprint 17). OPTIONAL
   * and best-effort: see `EmailChangeVerification` — it never throws, so it
   * can never fail a committed email change. (Registration no longer sends a
   * verification email: a verification-first account is created verified.)
   */
  emailVerification?: EmailChangeVerification;
  clock?: Clock;
}

/** Result of login: the JSON response plus the out-of-band cookie. */
export interface SessionIssueResult {
  response: AuthSessionResponse;
  /** Raw refresh token for the HttpOnly cookie. NEVER goes into JSON. */
  rawRefreshToken: string;
}

/**
 * Outcome of a refresh attempt. The route maps each to a response + cookie
 * action; the service never touches HTTP itself.
 */
export type RefreshResult =
  | { status: 'rotated'; response: RefreshResponse; rawRefreshToken: string }
  | { status: 'invalid' }
  | { status: 'reuse_detected' };

export interface ListSessionsInput {
  limit: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor: string | null;
}

export interface AuthService {
  login(input: LoginRequest, ctx: RequestContext): Promise<SessionIssueResult>;
  authenticate(accessToken: string, ctx: RequestContext): Promise<AuthUser>;
  refresh(rawRefreshToken: string, ctx: RequestContext): Promise<RefreshResult>;
  /** Idempotent. Revokes the cookie's session/family server-side if present. */
  logout(rawRefreshToken: string | null, ctx: RequestContext): Promise<void>;
  listSessions(
    accessToken: string,
    input: ListSessionsInput,
    ctx: RequestContext,
  ): Promise<SessionListResponse>;
  /** Returns whether the revoked session was the caller's current session. */
  revokeSession(
    accessToken: string,
    targetSessionId: string,
    ctx: RequestContext,
  ): Promise<{ revokedCurrent: boolean }>;
  /**
   * Authenticated password change (Sprint 17). Requires the current password;
   * keeps the CALLER's session alive and revokes every other session (and the
   * refresh tokens of the revoked sessions) transactionally.
   */
  changePassword(
    accessToken: string,
    input: ChangePasswordRequest,
    ctx: RequestContext,
  ): Promise<ChangePasswordResponse>;
  /**
   * Authenticated email change (Sprint 17, direct-change policy). Requires the
   * current password; commits the new address with verification cleared, then
   * best-effort sends a fresh verification email to the NEW address.
   */
  changeEmail(
    accessToken: string,
    input: ChangeEmailRequest,
    ctx: RequestContext,
  ): Promise<ChangeEmailResponse>;
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

/**
 * Map a persistence row to the public, secret-free user DTO. Exported: the
 * registration-completion service (Sprint 18) returns the same shape, and one
 * mapper keeps the boundary identical.
 */
export function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Map a session row to the public, secret-free session summary. */
function toSessionSummary(
  session: SessionRow,
  currentSessionId: string,
): SessionSummary {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
  };
}

/** Internal session-list cursor shape. Opaque to clients. */
interface SessionCursor {
  c: number; // createdAt epoch millis
  i: string; // session id (tiebreak)
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const {
    repo,
    jwtSecret,
    previousJwtSecret,
    accessTokenTtlSeconds,
    sessionTtlSeconds,
    refreshTokenTtlSeconds,
    rateLimiter = createNoopRateLimiter(),
    rateLimitFailureMode = 'open',
    emailVerification,
    clock = systemClock,
  } = options;

  // Fail safe with permissive defaults if no limits are supplied (e.g. some
  // unit tests). Production wires real values from config.
  const limits: AuthRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    loginPerIpMax: Number.MAX_SAFE_INTEGER,
    loginPerEmailMax: Number.MAX_SAFE_INTEGER,
    refreshPerSessionMax: Number.MAX_SAFE_INTEGER,
    refreshPerIpMax: Number.MAX_SAFE_INTEGER,
    changePasswordPerUserMax: Number.MAX_SAFE_INTEGER,
    changeEmailPerUserMax: Number.MAX_SAFE_INTEGER,
  };

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

  /**
   * Consume one rate-limit hit. On exceed, write a sanitized
   * `rate_limit_exceeded` event (bucket name only — no email/IP value in
   * metadata; the event row already carries the IP) and throw `RATE_LIMITED`.
   * A limiter-store outage follows the configured failure mode: fail open
   * (allow) or fail closed (generic 503) — see `enforceStoreAvailability`.
   */
  async function enforceRateLimit(
    key: string,
    limit: number,
    bucket: string,
    ctx: RequestContext,
  ): Promise<void> {
    const decision = await rateLimiter.consume(
      key,
      limit,
      limits.windowSeconds,
    );
    const allowed = enforceStoreAvailability(decision, rateLimitFailureMode);
    if (!allowed) {
      await writeSecurityEvent({
        userId: null,
        sessionId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.rateLimitExceeded,
        metadata: { bucket },
        ctx,
      });
      throw rateLimitedError();
    }
  }

  /**
   * Sign an access token for an already-created session and assemble the
   * register/login response. Shared by both flows so the issued shape (and the
   * out-of-band refresh credential) stay identical.
   */
  async function buildSessionIssueResult(
    user: UserRow,
    session: SessionRow,
    rawRefreshToken: string,
  ): Promise<SessionIssueResult> {
    const accessToken = await signAccessToken({
      userId: user.id,
      sessionId: session.id,
      secret: jwtSecret,
      ttlSeconds: accessTokenTtlSeconds,
    });
    return {
      rawRefreshToken,
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

  /** Create a session + access token + refresh token for an authed user (login). */
  async function issueSession(
    user: UserRow,
    ctx: RequestContext,
  ): Promise<{ result: SessionIssueResult; sessionId: string }> {
    const now = clock.epochMillis();
    const session = await repo.insertSession({
      userId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      expiresAt: new Date(now + sessionTtlSeconds * 1000),
    });

    // Mint the first refresh token of a new family. The raw value is returned
    // only for the cookie; the database keeps the SHA-256 hash exclusively.
    const rawRefreshToken = generateOpaqueToken();
    await repo.insertRefreshToken({
      sessionId: session.id,
      familyId: createId('rtok'),
      tokenHash: hashOpaqueToken(rawRefreshToken),
      parentTokenId: null,
      expiresAt: new Date(now + refreshTokenTtlSeconds * 1000),
    });

    const result = await buildSessionIssueResult(user, session, rawRefreshToken);
    return { result, sessionId: session.id };
  }

  /**
   * Resolve and fully validate the session behind a Bearer access token.
   * Shared by `/me`, session listing, and session revocation so the boundary
   * (and its `access_token_rejected` events) stay identical everywhere.
   */
  async function requireAuthenticatedSession(
    accessToken: string,
    ctx: RequestContext,
  ): Promise<{ user: UserRow; session: SessionRow }> {
    let claims;
    try {
      // Accepts the current signing secret always, and the retiring one only
      // while a rotation window is configured (Sprint 24). Everything after
      // this point — user, session, revocation, expiry — is unchanged: which
      // key verified a token grants it no additional trust.
      claims = await verifyAccessTokenWithRotation(accessToken, {
        current: jwtSecret,
        previous: previousJwtSecret,
      });
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
    // belongs to this same user, and is neither revoked nor expired.
    const session = await repo.findSessionById(claims.sessionId);
    const sessionUntrusted =
      !session ||
      session.userId !== user.id ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= clock.epochMillis();
    if (sessionUntrusted) {
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

    return { user, session: session as SessionRow };
  }

  return {
    async login(input, ctx) {
      const normalizedEmail = normalizeEmail(input.email);

      // Rate-limit before any user lookup. Both buckets return the SAME
      // RATE_LIMITED regardless of whether the email exists, so the per-email
      // bucket is not an account-existence oracle. The email is hashed into the
      // key so no raw email is stored in Redis.
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:login:ip:${ctx.ipAddress}`,
          limits.loginPerIpMax,
          'login_per_ip',
          ctx,
        );
      }
      await enforceRateLimit(
        `rl:login:email:${hashOpaqueToken(normalizedEmail)}`,
        limits.loginPerEmailMax,
        'login_per_email',
        ctx,
      );

      const user = await repo.findUserByNormalizedEmail(normalizedEmail);

      // Unknown/inactive: still spend a verify against a dummy hash so response
      // time does not betray account existence, then fail generically.
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

      const { result, sessionId } = await issueSession(user, ctx);
      await writeSecurityEvent({
        userId: user.id,
        sessionId,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.loginSucceeded,
        ctx,
      });
      return result;
    },

    async authenticate(accessToken, ctx) {
      const { user } = await requireAuthenticatedSession(accessToken, ctx);
      return toAuthUser(user);
    },

    async refresh(rawRefreshToken, ctx) {
      // Per-IP limit (cheap, pre-lookup).
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:refresh:ip:${ctx.ipAddress}`,
          limits.refreshPerIpMax,
          'refresh_per_ip',
          ctx,
        );
      }

      const presentedTokenHash = hashOpaqueToken(rawRefreshToken);

      // Per-session limit. A pre-read resolves the session for the bucket key;
      // it is advisory only — rotation re-reads under a lock for correctness.
      const presented = await repo.findRefreshTokenByHash(presentedTokenHash);
      if (presented) {
        await enforceRateLimit(
          `rl:refresh:sess:${presented.sessionId}`,
          limits.refreshPerSessionMax,
          'refresh_per_session',
          ctx,
        );
      }

      const now = clock.now();
      const successorRaw = generateOpaqueToken();
      const rotation = await repo.rotateRefreshToken({
        presentedTokenHash,
        successorTokenHash: hashOpaqueToken(successorRaw),
        successorExpiresAt: new Date(
          now.getTime() + refreshTokenTtlSeconds * 1000,
        ),
        now,
      });

      if (rotation.status === 'rotated') {
        const accessToken = await signAccessToken({
          userId: rotation.session.userId,
          sessionId: rotation.session.id,
          secret: jwtSecret,
          ttlSeconds: accessTokenTtlSeconds,
        });
        await writeSecurityEvent({
          userId: rotation.session.userId,
          sessionId: rotation.session.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.refreshTokenRotated,
          ctx,
        });
        return {
          status: 'rotated',
          rawRefreshToken: successorRaw,
          response: {
            tokens: {
              accessToken,
              tokenType: 'Bearer',
              expiresIn: accessTokenTtlSeconds,
            },
          },
        };
      }

      if (rotation.status === 'reuse') {
        // Invariant: a reused/invalidated refresh token compromises the entire
        // family. Revoke ALL refresh tokens in the family AND the session, so
        // no credential derived from this login survives.
        await repo.revokeRefreshTokenFamily(
          rotation.familyId,
          REVOKE_REASONS.reuseDetected,
        );
        await repo.revokeSession(
          rotation.sessionId,
          REVOKE_REASONS.reuseDetected,
        );
        await writeSecurityEvent({
          // `userId` is null only if the owning session row is already gone; in
          // that case the actor cannot be trusted, so attribute it to 'system'.
          userId: rotation.userId,
          sessionId: rotation.sessionId,
          actorType: rotation.userId ? 'user' : 'system',
          eventType: SECURITY_EVENT_TYPES.refreshTokenReuseDetected,
          ctx,
        });
        return { status: 'reuse_detected' };
      }

      // expired | not_found -> generic invalid. Safe to record a sanitized
      // failure with only the classification reason and no token material.
      await writeSecurityEvent({
        userId: null,
        sessionId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.refreshFailed,
        metadata: { reason: rotation.status },
        ctx,
      });
      return { status: 'invalid' };
    },

    async logout(rawRefreshToken, ctx) {
      // Idempotent: with no cookie there is nothing to revoke. The route still
      // clears the cookie and returns success.
      if (!rawRefreshToken) {
        return;
      }

      const token = await repo.findRefreshTokenByHash(
        hashOpaqueToken(rawRefreshToken),
      );
      if (!token) {
        return;
      }

      const session = await repo.findSessionById(token.sessionId);
      await repo.revokeSession(token.sessionId, REVOKE_REASONS.logout);
      await repo.revokeRefreshTokensForSession(
        token.sessionId,
        REVOKE_REASONS.logout,
      );
      await writeSecurityEvent({
        userId: session?.userId ?? null,
        sessionId: token.sessionId,
        actorType: session ? 'user' : 'system',
        eventType: SECURITY_EVENT_TYPES.logoutSucceeded,
        ctx,
      });
    },

    async listSessions(accessToken, input, ctx) {
      const { user, session } = await requireAuthenticatedSession(
        accessToken,
        ctx,
      );

      let cursor: { createdAtMs: number; id: string } | null = null;
      if (input.cursor) {
        const decoded = decodeCursor<SessionCursor>(input.cursor);
        if (
          !decoded ||
          typeof decoded.c !== 'number' ||
          typeof decoded.i !== 'string'
        ) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
        }
        cursor = { createdAtMs: decoded.c, id: decoded.i };
      }

      const rows = await repo.listActiveSessionsForUser({
        userId: user.id,
        limit: input.limit,
        cursor,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({ c: last.createdAt.getTime(), i: last.id })
          : null;

      return {
        items: page.map((row) => toSessionSummary(row, session.id)),
        nextCursor,
        hasMore,
      };
    },

    async revokeSession(accessToken, targetSessionId, ctx) {
      const { user, session: currentSession } =
        await requireAuthenticatedSession(accessToken, ctx);

      const target = await repo.findSessionById(targetSessionId);
      // Not found OR not owned -> identical 404 so other users' session ids
      // cannot be probed.
      if (!target || target.userId !== user.id) {
        throw sessionNotFoundError();
      }

      // Idempotent: revoking an already-revoked session is a no-op success.
      if (target.revokedAt === null) {
        await repo.revokeSession(
          target.id,
          REVOKE_REASONS.sessionRevoked,
        );
        await repo.revokeRefreshTokensForSession(
          target.id,
          REVOKE_REASONS.sessionRevoked,
        );
        await writeSecurityEvent({
          userId: user.id,
          sessionId: target.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.sessionRevoked,
          ctx,
        });
      }

      return { revokedCurrent: target.id === currentSession.id };
    },

    async changePassword(accessToken, input, ctx) {
      const { user, session } = await requireAuthenticatedSession(
        accessToken,
        ctx,
      );

      await enforceRateLimit(
        `rl:change-password:user:${user.id}`,
        limits.changePasswordPerUserMax,
        'change_password_per_user',
        ctx,
      );

      // Mandatory re-authentication: a hijacked browser tab must not be able
      // to rotate the credential without knowing the current password.
      const currentOk = await verifyPassword(
        user.passwordHash,
        input.currentPassword,
      );
      if (!currentOk) {
        await writeSecurityEvent({
          userId: user.id,
          sessionId: session.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.passwordChangeRejected,
          metadata: { reason: 'bad_current_password' },
          ctx,
        });
        throw currentPasswordIncorrectError();
      }

      // Reuse rejection: verifying the NEW password against the EXISTING hash
      // detects a no-op change without ever persisting anything new.
      const sameAsCurrent = await verifyPassword(
        user.passwordHash,
        input.newPassword,
      );
      if (sameAsCurrent) {
        await writeSecurityEvent({
          userId: user.id,
          sessionId: session.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.passwordChangeRejected,
          metadata: { reason: 'password_unchanged' },
          ctx,
        });
        throw passwordUnchangedError();
      }

      // Session policy: the session that PROVED the current password survives;
      // every other session (and its refresh tokens) is revoked in the same
      // transaction that swaps the hash. `session.id` comes from the verified
      // access token — never from client input.
      const newPasswordHash = await hashPassword(input.newPassword);
      await repo.changePasswordKeepingCurrentSession({
        userId: user.id,
        newPasswordHash,
        currentSessionId: session.id,
        revokeReason: REVOKE_REASONS.passwordChanged,
        now: clock.now(),
      });

      await writeSecurityEvent({
        userId: user.id,
        sessionId: session.id,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.passwordChanged,
        metadata: { otherSessionsRevoked: true },
        ctx,
      });
      return { success: true };
    },

    async changeEmail(accessToken, input, ctx) {
      const { user, session } = await requireAuthenticatedSession(
        accessToken,
        ctx,
      );

      await enforceRateLimit(
        `rl:change-email:user:${user.id}`,
        limits.changeEmailPerUserMax,
        'change_email_per_user',
        ctx,
      );

      const normalizedEmail = normalizeEmail(input.newEmail);
      if (normalizedEmail === user.normalizedEmail) {
        throw emailUnchangedError();
      }

      // Mandatory re-authentication, checked BEFORE any existence lookup so an
      // attacker with only a stolen access token cannot probe other accounts'
      // emails through this endpoint's duplicate conflict.
      const currentOk = await verifyPassword(
        user.passwordHash,
        input.currentPassword,
      );
      if (!currentOk) {
        await writeSecurityEvent({
          userId: user.id,
          sessionId: session.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.emailChangeRejected,
          metadata: { reason: 'bad_current_password' },
          ctx,
        });
        throw currentPasswordIncorrectError();
      }

      // Direct-change policy (Sprint 17): commit the new address immediately
      // with verification CLEARED; the account stays usable under the advisory
      // verification model. The repository transaction also invalidates every
      // outstanding verification token, so nothing minted for the old address
      // survives. A duplicate normalized email surfaces the same 409 as
      // registration — an intentionally allowed disclosure: the caller has
      // re-proved the account password, and the same signal is already
      // available through registration itself.
      let updated: UserRow;
      try {
        updated = await repo.changeEmail({
          userId: user.id,
          email: input.newEmail.trim(),
          normalizedEmail,
          now: clock.now(),
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED
        ) {
          await writeSecurityEvent({
            userId: user.id,
            sessionId: session.id,
            actorType: 'user',
            eventType: SECURITY_EVENT_TYPES.emailChangeRejected,
            metadata: { reason: 'duplicate_email' },
            ctx,
          });
        }
        throw error;
      }

      await writeSecurityEvent({
        userId: user.id,
        sessionId: session.id,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.emailChanged,
        metadata: { verificationCleared: true },
        ctx,
      });

      // BEST-EFFORT fresh verification for the NEW address, after commit —
      // same consistency model as the post-registration email: a mail outage
      // never rolls back the committed change; the user can resend from the
      // authenticated endpoint (the account remains usable unverified).
      if (emailVerification) {
        await emailVerification.sendEmailChangeVerificationEmail(
          { id: updated.id, email: updated.email },
          ctx,
        );
      }
      return { user: toAuthUser(updated) };
    },
  };
}
