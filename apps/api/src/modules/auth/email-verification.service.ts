import type {
  AuthUser,
  EmailVerificationCompleteResponse,
  EmailVerificationRequestResponse,
} from '@orgistry/contracts';
import { type Clock, systemClock } from '@orgistry/shared';
import type {
  RateLimiter,
  RateLimitFailureMode,
} from '../../lib/rate-limit';
import {
  createNoopRateLimiter,
  enforceStoreAvailability,
} from '../../lib/rate-limit';
import type { AccountMailer } from '../mail/account-mailer';
import { rateLimitedError } from './auth.errors';
import {
  buildEmailVerificationUrl,
  renderEmailVerificationEmail,
} from './email-verification.email';
import {
  emailVerificationTokenExpiredError,
  emailVerificationTokenInvalidError,
  emailVerificationTokenUsedError,
} from './email-verification.errors';
import {
  generateEmailVerificationToken,
  hashEmailVerificationToken,
} from './email-verification.token';
import type { EmailVerificationRepository } from './email-verification.types';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';
import type { NewSecurityEvent, RequestContext } from './auth.types';

/**
 * Email-verification workflows (Sprint 16): issuing verification tokens on
 * request/resend and consuming them on public completion.
 *
 * Design decisions this service owns:
 *  - ONE authenticated endpoint serves both first request and resend; it
 *    operates ONLY on the authenticated user's stored email (no request body,
 *    no arbitrary address — enumeration-safe by construction).
 *  - Completion is PUBLIC: possession of the emailed raw token IS the proof.
 *  - Issue order matches the invitation convention: render + deliver FIRST,
 *    persist second. A delivery failure therefore leaves the previous token
 *    generation untouched; a (rare) persistence failure after delivery leaves
 *    a dead link, recoverable via resend.
 *  - Verification is ADVISORY in Sprint 16: nothing here (or anywhere) gates
 *    login, org access, or API usage on `emailVerified`. The current-user
 *    contract exposes the state; enforcement is a future, deliberate change.
 *  - Security events are written AFTER the repository transaction commits
 *    (repository convention: events are best-effort audit records, never part
 *    of the domain transaction). Metadata never contains the raw token, its
 *    hash, or the verification URL.
 */

/** Per-bucket rate limits (from `config.rateLimit.emailVerification`). */
export interface EmailVerificationRateLimits {
  windowSeconds: number;
  requestPerUserMax: number;
  requestPerIpMax: number;
  completePerIpMax: number;
}

export interface EmailVerificationServiceOptions {
  repo: EmailVerificationRepository;
  /** Shared account-email boundary (driver selected by config). */
  mailer: AccountMailer;
  /** Public web origin the emailed verification link points at. */
  webBaseUrl: string;
  /** Raw verification token lifetime in seconds. */
  ttlSeconds: number;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  rateLimits?: EmailVerificationRateLimits;
  /**
   * Limiter-store outage behavior (Sprint 19, ORG-PR-009): `open` allows,
   * `closed` rejects with a generic 503. Wired from
   * `config.rateLimit.failureMode`; defaults open for test usability.
   */
  rateLimitFailureMode?: RateLimitFailureMode;
  clock?: Clock;
}

export interface EmailVerificationService {
  /**
   * Issue (or re-issue) a verification token for the AUTHENTICATED user and
   * email the link to their stored address. Safe success without sending when
   * the user is already verified. Serves as the resend endpoint too — every
   * issue invalidates all previous unused tokens first.
   */
  requestVerificationEmail(
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<EmailVerificationRequestResponse>;
  /**
   * Complete verification by raw token possession (public). Transactionally
   * race-safe: a token verifies at most once, ever.
   */
  completeVerification(
    rawToken: string,
    ctx: RequestContext,
  ): Promise<EmailVerificationCompleteResponse>;
  /**
   * BEST-EFFORT verification email after an authenticated email change
   * (Sprint 17). Never throws: the change is already committed (verification
   * cleared, old tokens invalidated), so a delivery failure only means the
   * user resends later. `user.email` is the NEW, committed address.
   *
   * (The post-REGISTRATION variant was retired in Sprint 18: a
   * verification-first account is created email-verified, so registration
   * never sends a verification email.)
   */
  sendEmailChangeVerificationEmail(
    user: { id: string; email: string },
    ctx: RequestContext,
  ): Promise<void>;
}

export function createEmailVerificationService(
  options: EmailVerificationServiceOptions,
): EmailVerificationService {
  const {
    repo,
    mailer,
    webBaseUrl,
    ttlSeconds,
    rateLimiter = createNoopRateLimiter(),
    rateLimitFailureMode = 'open',
    clock = systemClock,
  } = options;

  // Fail safe with permissive defaults if no limits are supplied (unit tests).
  // Production wires real values from config.
  const limits: EmailVerificationRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    requestPerUserMax: Number.MAX_SAFE_INTEGER,
    requestPerIpMax: Number.MAX_SAFE_INTEGER,
    completePerIpMax: Number.MAX_SAFE_INTEGER,
  };

  /** Persist a sanitized security event. Best-effort context, never secrets. */
  async function writeSecurityEvent(event: {
    userId: string | null;
    actorType: NewSecurityEvent['actorType'];
    eventType: string;
    metadata?: Record<string, unknown>;
    ctx: RequestContext;
  }): Promise<void> {
    await repo.insertSecurityEvent({
      userId: event.userId,
      sessionId: null,
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
   * `rate_limit_exceeded` event (bucket name only — never the submitted token
   * or any email value) and throw `RATE_LIMITED`.
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
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.rateLimitExceeded,
        metadata: { bucket },
        ctx,
      });
      throw rateLimitedError();
    }
  }

  /**
   * Issue one verification generation. CONSISTENCY CONTRACT — SMTP and
   * PostgreSQL cannot share a transaction, so the ordering below is the
   * invariant, not an accident:
   *
   *   1. mint the raw token + expiry (server memory only);
   *   2. render the email (pure);
   *   3. DELIVER via the mailer — the previous usable generation is untouched
   *      until the mailer has ACCEPTED the replacement message, so a delivery
   *      failure aborts here and can never silently strand the user with an
   *      undelivered sole token;
   *   4. persist in ONE transaction: invalidate every previous unused token
   *      and insert the replacement hash;
   *   5. (caller) record the security event after the transaction commits.
   *
   * The unavoidable non-atomic window is between 3 and 4: if persistence
   * fails AFTER acceptance, the endpoint errors (no misleading success), the
   * emailed candidate link is dead (its hash was never stored), and the
   * previous generation remains the only usable one — recoverable by resend.
   * The raw token lives only in this function's scope and the outgoing email.
   */
  async function issueAndSendVerificationEmail(user: {
    id: string;
    email: string;
  }): Promise<void> {
    const rawToken = generateEmailVerificationToken();
    const expiresAt = new Date(clock.epochMillis() + ttlSeconds * 1000);

    await mailer.deliver(
      renderEmailVerificationEmail({
        to: user.email,
        verifyUrl: buildEmailVerificationUrl(webBaseUrl, rawToken),
        expiresAt,
      }),
    );

    await repo.issueVerificationToken({
      userId: user.id,
      tokenHash: hashEmailVerificationToken(rawToken),
      expiresAt,
      now: clock.now(),
    });
  }

  /**
   * BEST-EFFORT issue + send for flows whose triggering operation has already
   * committed (the authenticated email change). Never throws: the committed
   * operation must stay usable through any email outage. A failed delivery is
   * recorded (coarse, token-free) and the user can resend from the
   * authenticated endpoint.
   */
  async function sendBestEffortVerificationEmail(
    user: { id: string; email: string },
    ctx: RequestContext,
    trigger: 'email_change',
  ): Promise<void> {
    try {
      await issueAndSendVerificationEmail(user);
      await writeSecurityEvent({
        userId: user.id,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.emailVerificationRequested,
        metadata: { delivered: true, trigger },
        ctx,
      });
    } catch {
      try {
        await writeSecurityEvent({
          userId: user.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.emailVerificationRequested,
          metadata: { delivered: false, trigger },
          ctx,
        });
      } catch {
        // Even the audit write failed; the committed operation still wins.
      }
    }
  }

  return {
    async requestVerificationEmail(user, ctx) {
      await enforceRateLimit(
        `rl:email-verification:request:user:${user.id}`,
        limits.requestPerUserMax,
        'email_verification_request_per_user',
        ctx,
      );
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:email-verification:request:ip:${ctx.ipAddress}`,
          limits.requestPerIpMax,
          'email_verification_request_per_ip',
          ctx,
        );
      }

      // Re-read the authoritative row: the caller's DTO may be stale (e.g. a
      // completion landed between authentication and this call), and the
      // stored email is the ONLY address a verification email may go to.
      const row = await repo.findUserById(user.id);
      if (!row || row.status !== 'active' || row.deletedAt !== null) {
        // Authenticated a moment ago but no longer verifiable — treat like an
        // already-settled account rather than disclosing lifecycle detail.
        return { sent: false, alreadyVerified: false };
      }
      if (row.emailVerifiedAt !== null) {
        // Safe success: no new token, no email, nothing to enumerate.
        return { sent: false, alreadyVerified: true };
      }

      await issueAndSendVerificationEmail({ id: row.id, email: row.email });

      await writeSecurityEvent({
        userId: row.id,
        actorType: 'user',
        eventType: SECURITY_EVENT_TYPES.emailVerificationRequested,
        metadata: { delivered: true },
        ctx,
      });
      return { sent: true, alreadyVerified: false };
    },

    async completeVerification(rawToken, ctx) {
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:email-verification:complete:ip:${ctx.ipAddress}`,
          limits.completePerIpMax,
          'email_verification_complete_per_ip',
          ctx,
        );
      }

      const result = await repo.completeVerification({
        tokenHash: hashEmailVerificationToken(rawToken),
        now: clock.now(),
      });

      if (result.status === 'verified') {
        await writeSecurityEvent({
          userId: result.user.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.emailVerificationSucceeded,
          ctx,
        });
        return { verified: true };
      }

      // Failed completions attribute to no user: the presented token proved
      // nothing. `reason` is coarse and token-free.
      await writeSecurityEvent({
        userId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.emailVerificationFailed,
        metadata: { reason: result.status },
        ctx,
      });
      switch (result.status) {
        case 'expired':
          throw emailVerificationTokenExpiredError();
        case 'already_used':
          throw emailVerificationTokenUsedError();
        case 'not_found':
        case 'user_not_verifiable':
          // Indistinguishable on purpose: account state is never disclosed.
          throw emailVerificationTokenInvalidError();
      }
    },

    async sendEmailChangeVerificationEmail(user, ctx) {
      await sendBestEffortVerificationEmail(user, ctx, 'email_change');
    },
  };
}
