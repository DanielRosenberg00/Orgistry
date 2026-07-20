import { hashOpaqueToken, hashPassword, normalizeEmail } from '@orgistry/auth-core';
import type {
  PasswordRecoveryCompleteRequest,
  PasswordRecoveryCompleteResponse,
  PasswordRecoveryRequest,
  PasswordRecoveryRequestResponse,
} from '@orgistry/contracts';
import type { UserRow } from '@orgistry/db';
import { type Clock, systemClock } from '@orgistry/shared';
import type { RateLimiter } from '../../lib/rate-limit';
import { createNoopRateLimiter } from '../../lib/rate-limit';
import type { AccountMailer } from '../mail/account-mailer';
import { rateLimitedError } from './auth.errors';
import type { NewSecurityEvent, RequestContext } from './auth.types';
import {
  buildPasswordResetUrl,
  renderPasswordResetEmail,
} from './password-recovery.email';
import {
  passwordResetTokenExpiredError,
  passwordResetTokenInvalidError,
  passwordResetTokenUsedError,
} from './password-recovery.errors';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetRateLimitKey,
} from './password-recovery.token';
import type { PasswordRecoveryRepository } from './password-recovery.types';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';

/**
 * Password-recovery workflows (Sprint 17): the public request endpoint that
 * emails a reset link, and the public completion endpoint that consumes it.
 *
 * Design decisions this service owns:
 *  - The REQUEST endpoint is enumeration-safe BY CONSTRUCTION: every code path
 *    after validation and rate limiting returns the identical
 *    `{ accepted: true }` — unknown email, inactive account, persistence
 *    failure, and mail failure all produce the same public response. Only the
 *    security-events seam (internal) records what actually happened.
 *  - Issue order is PERSIST-AND-COMMIT BEFORE SEND: every emailed reset
 *    token was durably persisted before it was handed to the mailer. That is
 *    the whole guarantee — a token can still be invalidated by a concurrent
 *    or subsequent recovery request, so an already-sent link is NOT
 *    guaranteed to be usable when opened; exactly one generation (the most
 *    recent to commit) survives issuance, and older emails then carry a
 *    superseded token. That is expected single-generation behavior, not a
 *    failure. If persistence fails, no email is sent. If the send fails, the
 *    persisted token is harmless — unknown to anyone, expiring, and
 *    invalidated by the next successful generation. This deliberately
 *    differs from the verification-issue ordering (deliver-then-persist):
 *    that endpoint is authenticated and surfaces mail failures, while this
 *    public endpoint must swallow them, and an undelivered persisted token
 *    costs nothing.
 *  - Request-path security events are ANONYMOUS and BEST-EFFORT (see
 *    `recordRequestOutcome`): nobody is authenticated, and no internal
 *    failure — lookup classification, persistence, delivery, or the event
 *    write itself — may alter the public response.
 *  - Completion is PUBLIC: possession of the emailed raw token IS the proof.
 *    A completed reset issues NO tokens and NO session — the user signs in
 *    again — and revokes every pre-reset session and refresh token in the
 *    same repository transaction that replaces the password.
 *  - Security events are written AFTER the repository transaction commits
 *    (repository convention). Metadata never contains the raw token, its
 *    hash, the reset URL, or any password material.
 *
 * KNOWN LIMITATION (documented, accepted for this sprint): the request path
 * does more work for an existing account (Argon2-free, but one email delivery
 * + one insert) than for an unknown email, so response TIMING is not fully
 * equalized. Closing it needs out-of-band delivery (a queue), which is out of
 * scope; the per-IP/per-email rate limits bound how fast the signal can be
 * sampled.
 */

/** Per-bucket rate limits (from `config.rateLimit.passwordRecovery`). */
export interface PasswordRecoveryRateLimits {
  windowSeconds: number;
  requestPerIpMax: number;
  /** Keyed on a digest of the normalized email, never the email itself. */
  requestPerEmailMax: number;
  completePerIpMax: number;
  /** Keyed on a second-order digest of the token, never the raw/storage hash. */
  completePerTokenMax: number;
}

export interface PasswordRecoveryServiceOptions {
  repo: PasswordRecoveryRepository;
  /** Shared account-email boundary (driver selected by config). */
  mailer: AccountMailer;
  /** Public web origin the emailed reset link points at. */
  webBaseUrl: string;
  /** Raw reset token lifetime in seconds. Short-lived by design. */
  ttlSeconds: number;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  rateLimits?: PasswordRecoveryRateLimits;
  clock?: Clock;
}

export interface PasswordRecoveryService {
  /**
   * PUBLIC request: accept an email, and — only if it resolves to an active,
   * recoverable account — issue a reset generation and email the link. The
   * response is identical for every outcome (see the service doc above).
   */
  requestReset(
    input: PasswordRecoveryRequest,
    ctx: RequestContext,
  ): Promise<PasswordRecoveryRequestResponse>;
  /**
   * PUBLIC completion: consume a raw reset token and set the new password.
   * Transactionally race-safe: a token resets a password at most once, ever.
   * Never signs the caller in.
   */
  completeReset(
    input: PasswordRecoveryCompleteRequest,
    ctx: RequestContext,
  ): Promise<PasswordRecoveryCompleteResponse>;
}

export function createPasswordRecoveryService(
  options: PasswordRecoveryServiceOptions,
): PasswordRecoveryService {
  const {
    repo,
    mailer,
    webBaseUrl,
    ttlSeconds,
    rateLimiter = createNoopRateLimiter(),
    clock = systemClock,
  } = options;

  // Fail safe with permissive defaults if no limits are supplied (unit tests).
  // Production wires real values from config.
  const limits: PasswordRecoveryRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    requestPerIpMax: Number.MAX_SAFE_INTEGER,
    requestPerEmailMax: Number.MAX_SAFE_INTEGER,
    completePerIpMax: Number.MAX_SAFE_INTEGER,
    completePerTokenMax: Number.MAX_SAFE_INTEGER,
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
   * `rate_limit_exceeded` event (bucket name only — never the email, token, or
   * any derived key material) and throw `RATE_LIMITED`.
   */
  async function enforceRateLimit(
    key: string,
    limit: number,
    bucket: string,
    ctx: RequestContext,
  ): Promise<void> {
    const allowed = await rateLimiter.consume(key, limit, limits.windowSeconds);
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
   * Record the internal outcome of a recovery request. The ONLY event writer
   * for the request endpoint, and it enforces two policies:
   *
   *  - ANONYMOUS attribution, always. Submitting an email to a public
   *    endpoint authenticates nobody, so the event never carries a user id,
   *    session id, or 'user' actor — regardless of whether the email
   *    resolved. (The schema has no separate subject/target field, so
   *    request events are deliberately not account-linked; correlation is
   *    via the sanitized IP/UA/request-id context.)
   *  - NO-THROW, always. Every post-rate-limit path must produce the same
   *    public response, so an event-store failure is swallowed — it must
   *    never become a caller-visible distinction between outcomes.
   */
  async function recordRequestOutcome(
    outcome:
      | 'sent'
      | 'send_failed'
      | 'persist_failed'
      | 'lookup_failed'
      | 'inactive_account'
      | 'unknown_email',
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await writeSecurityEvent({
        userId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.passwordResetRequested,
        metadata: { outcome, delivered: outcome === 'sent' },
        ctx,
      });
    } catch {
      // Swallowed: the enumeration-safe response is the priority.
    }
  }

  return {
    async requestReset(input, ctx) {
      const normalizedEmail = normalizeEmail(input.email);

      // Rate-limit before any user lookup. Both buckets return the SAME
      // RATE_LIMITED regardless of whether the email exists, so neither is an
      // account-existence oracle. The email is hashed into the key so no raw
      // email is stored in Redis (same construction as the login limiter).
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:password-recovery:request:ip:${ctx.ipAddress}`,
          limits.requestPerIpMax,
          'password_recovery_request_per_ip',
          ctx,
        );
      }
      await enforceRateLimit(
        `rl:password-recovery:request:email:${hashOpaqueToken(normalizedEmail)}`,
        limits.requestPerEmailMax,
        'password_recovery_request_per_email',
        ctx,
      );

      // The enumeration-safe boundary starts HERE: once validation and rate
      // limiting have passed, no internal failure — lookup, persistence,
      // delivery, or event write — may alter the public response. A thrown
      // lookup (e.g. database outage) is therefore swallowed exactly like
      // the later failure modes: best-effort anonymous event, same response.
      let user: UserRow | null;
      try {
        user = await repo.findUserByNormalizedEmail(normalizedEmail);
      } catch {
        await recordRequestOutcome('lookup_failed', ctx);
        return { accepted: true };
      }

      // Unknown or non-recoverable account: record internally (anonymous,
      // best-effort, coarse outcome only), answer identically. No error, no
      // email, no token row.
      if (!user || user.status !== 'active' || user.deletedAt !== null) {
        await recordRequestOutcome(
          user ? 'inactive_account' : 'unknown_email',
          ctx,
        );
        return { accepted: true };
      }

      // Recoverable account. PERSIST-AND-COMMIT BEFORE SEND (see the service
      // doc): every emailed token was durably persisted first, and neither
      // failure mode may alter the public response — an error here would
      // disclose account existence. The raw token exists only in this scope
      // and the outgoing message.
      const rawToken = generatePasswordResetToken();
      const expiresAt = new Date(clock.epochMillis() + ttlSeconds * 1000);

      try {
        // Sibling invalidation + insert commit together, serialized per user
        // (the repo locks the user row), so exactly one generation is usable.
        await repo.issueResetToken({
          userId: user.id,
          tokenHash: hashPasswordResetToken(rawToken),
          expiresAt,
          now: clock.now(),
        });
      } catch {
        await recordRequestOutcome('persist_failed', ctx);
        return { accepted: true };
      }

      try {
        await mailer.deliver(
          renderPasswordResetEmail({
            to: user.email,
            resetUrl: buildPasswordResetUrl(webBaseUrl, rawToken),
            expiresAt,
          }),
        );
      } catch {
        // The persisted-but-undelivered token is harmless: unknown to anyone,
        // expiring, and retired by the next successful generation.
        await recordRequestOutcome('send_failed', ctx);
        return { accepted: true };
      }

      await recordRequestOutcome('sent', ctx);
      return { accepted: true };
    },

    async completeReset(input, ctx) {
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:password-recovery:complete:ip:${ctx.ipAddress}`,
          limits.completePerIpMax,
          'password_recovery_complete_per_ip',
          ctx,
        );
      }
      // Per-token bucket: bounds brute-force retries against one specific
      // token independently of the attacker's IP pool. Keyed on a second-order
      // digest — never the raw token or the storage hash.
      await enforceRateLimit(
        `rl:password-recovery:complete:token:${passwordResetRateLimitKey(input.token)}`,
        limits.completePerTokenMax,
        'password_recovery_complete_per_token',
        ctx,
      );

      // Hash the new password BEFORE the transaction: Argon2id is CPU-bound
      // and must not run while holding the token row lock.
      const newPasswordHash = await hashPassword(input.newPassword);

      const result = await repo.completeReset({
        tokenHash: hashPasswordResetToken(input.token),
        newPasswordHash,
        now: clock.now(),
      });

      if (result.status === 'reset') {
        // TOKEN-AUTHORIZED attribution: not a Bearer session, but a SUCCESSFUL
        // completion has proven possession of a single-use, account-bound
        // credential — the same identity basis the email-verification
        // completion event uses ('user' actor + resolved id on success).
        await writeSecurityEvent({
          userId: result.user.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.passwordResetCompleted,
          metadata: { sessionsRevoked: true },
          ctx,
        });
        return { reset: true };
      }

      // A REJECTED completion proved nothing: anonymous, null user id, coarse
      // token-free `reason` — never a token-derived account reference.
      await writeSecurityEvent({
        userId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.passwordResetRejected,
        metadata: { reason: result.status },
        ctx,
      });
      switch (result.status) {
        case 'expired':
          throw passwordResetTokenExpiredError();
        case 'already_used':
          throw passwordResetTokenUsedError();
        case 'not_found':
        case 'user_not_recoverable':
          // Indistinguishable on purpose: account state is never disclosed.
          throw passwordResetTokenInvalidError();
      }
    },
  };
}
