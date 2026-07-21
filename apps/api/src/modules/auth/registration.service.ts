import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  signAccessToken,
} from '@orgistry/auth-core';
import type {
  RegisterAcceptedResponse,
  RegisterRequest,
  RegistrationCompleteRequest,
  RegistrationCompleteResponse,
  RegistrationInvitationOutcome,
} from '@orgistry/contracts';
import type { UserRow } from '@orgistry/db';
import { type Clock, createId, systemClock } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
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
import { toAuthUser } from './auth.service';
import type { NewSecurityEvent, RequestContext } from './auth.types';
import {
  buildForgotPasswordUrl,
  buildLoginUrl,
  buildRegistrationCompletionUrl,
  renderExistingAccountNoticeEmail,
  renderRegistrationCompletionEmail,
} from './registration.email';
import {
  registrationTokenExpiredError,
  registrationTokenInvalidError,
  registrationTokenUsedError,
} from './registration.errors';
import {
  generateRegistrationCompletionToken,
  hashRegistrationCompletionToken,
  registrationCompletionRateLimitKey,
} from './registration.token';
import type {
  CompletionInvitationContext,
  CompletionInvitationOutcome,
  RegistrationInvitations,
  RegistrationRepository,
} from './registration.types';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';

/**
 * Verification-first registration workflows (Sprint 18): the public request
 * endpoint that stages a pending registration and emails a completion link,
 * and the public completion endpoint that consumes the link and creates the
 * account.
 *
 * Design decisions this service owns:
 *  - The REQUEST endpoint is enumeration-safe BY CONSTRUCTION: every code
 *    path after payload validation and rate limiting returns the identical
 *    `{ accepted: true }` — eligible new email, existing active account,
 *    unverified account, disabled or soft-deleted account, EVERY private
 *    invitation-validation failure, lookup failure, persistence failure, and
 *    mail failure all produce the same public response. Only the
 *    security-events seam (internal) records what actually happened. There
 *    is NO duplicate-email error on this surface any more (ORG-PR-030).
 *  - Invitation validation happens INSIDE the enumeration-safe boundary and
 *    NEVER surfaces publicly: an unknown, malformed, expired, revoked,
 *    already-accepted, email-mismatched, or quota-blocked invitation — or a
 *    failing invitation resolver — answers the same generic acceptance,
 *    stages nothing, mutates nothing, and sends nothing. The dedicated
 *    invitation-INSPECT endpoint remains the intended feedback channel for a
 *    token holder; registration deliberately adds no second invitation-state
 *    oracle (and no invitation-existence or email-match disclosure). The
 *    translation is centralized in `resolveRequestInvitation` below.
 *  - The initial request NEVER creates a user, session, organization,
 *    membership, access token, or refresh cookie. Only a valid completion
 *    token can create an account, and the completed user is email-verified
 *    by construction (mailbox control was just proven).
 *  - The password is hashed (Argon2id) BEFORE the account lookup on EVERY
 *    request, so the dominant CPU cost is identical for new and existing
 *    emails. Residual timing differences (email delivery, one insert) remain
 *    and are documented — closing them needs out-of-band delivery, which is
 *    out of scope, and the rate limits bound how fast the signal can be
 *    sampled.
 *  - Issue order is PERSIST-AND-COMMIT BEFORE SEND (the password-recovery
 *    convention): every emailed completion token was durably staged first.
 *    If persistence fails, no email is sent. If the send fails, the staged
 *    row is harmless — unknown to anyone, expiring, and superseded by the
 *    next request. Exactly one generation per normalized email survives
 *    issuance (advisory-lock serialized; see the repository).
 *  - EXISTING-ACCOUNT POLICY: an active account gets a rate-limited guidance
 *    email (sign-in / password recovery — never a reset token); an
 *    UNVERIFIED-but-active account gets the same neutral guidance (its
 *    verification state is never disclosed and no verification token is
 *    minted for it); a disabled or soft-deleted account gets NOTHING (no
 *    email, no pending registration, no reactivation — there is no
 *    documented reactivation policy to honor). None of this alters the
 *    public response.
 *  - Request-path security events are ANONYMOUS and BEST-EFFORT: nobody is
 *    authenticated, duplicate-registration events never reference the
 *    existing account's user id, and no internal failure may alter the
 *    public response.
 *  - COMPLETION is public: possession of the emailed raw token IS the proof.
 *    A successful completion returns the normal authenticated registration
 *    result (user + tokens + refresh cookie) and settles the invitation per
 *    the documented policy: account creation survives an
 *    invitation-that-became-unavailable; the outcome is reported in the
 *    response contract, never silently dropped.
 */

/** Per-bucket rate limits (from `config.rateLimit.registration`). */
export interface RegistrationRateLimits {
  windowSeconds: number;
  requestPerIpMax: number;
  /** Keyed on a digest of the normalized email, never the email itself. */
  requestPerEmailMax: number;
  completePerIpMax: number;
  /** Keyed on a second-order digest of the token, never the raw/storage hash. */
  completePerTokenMax: number;
  /**
   * INTERNAL throttle for the existing-account guidance email. Exceeding it
   * silently skips the email — it never throws, so it cannot become a public
   * signal.
   */
  existingAccountNoticePerEmailMax: number;
}

export interface RegistrationServiceOptions {
  repo: RegistrationRepository;
  /** Shared account-email boundary (driver selected by config). */
  mailer: AccountMailer;
  /** Public web origin the emailed completion link points at. */
  webBaseUrl: string;
  /** Raw completion-token (and pending-registration) lifetime in seconds. */
  completionTtlSeconds: number;
  /** Symmetric JWT signing secret — completion issues a real session. */
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  rateLimits?: RegistrationRateLimits;
  /**
   * Limiter-store outage behavior (Sprint 19, ORG-PR-009): `open` allows,
   * `closed` rejects with a generic 503. Wired from
   * `config.rateLimit.failureMode`; defaults open for test usability.
   */
  rateLimitFailureMode?: RateLimitFailureMode;
  /** Invitation collaborator. OPTIONAL: without it, invitation tokens are rejected. */
  invitations?: RegistrationInvitations;
  clock?: Clock;
}

/** Result of a completed registration: the JSON response plus the cookie. */
export interface RegistrationCompletionResult {
  response: RegistrationCompleteResponse;
  /** Raw refresh token for the HttpOnly cookie. NEVER goes into JSON. */
  rawRefreshToken: string;
}

export interface RegistrationService {
  /**
   * PUBLIC request: stage a pending registration and email a completion link
   * where policy permits. The response is identical for every post-validation
   * outcome (see the service doc above). Creates NO account state.
   */
  requestRegistration(
    input: RegisterRequest,
    ctx: RequestContext,
  ): Promise<RegisterAcceptedResponse>;
  /**
   * PUBLIC completion: consume a raw completion token and create the account,
   * personal workspace, Owner membership, session, and refresh token
   * atomically. Transactionally race-safe: a token creates an account at most
   * once, ever.
   */
  completeRegistration(
    input: RegistrationCompleteRequest,
    ctx: RequestContext,
  ): Promise<RegistrationCompletionResult>;
}

/** Internal request outcomes recorded on the (anonymous) request event. */
type RequestOutcome =
  | 'sent'
  | 'send_failed'
  | 'persist_failed'
  | 'lookup_failed'
  | 'existing_account_notice_sent'
  | 'existing_account_notice_failed'
  | 'existing_account_notice_throttled'
  | 'ineligible_account'
  | 'invitation_rejected'
  | 'invitation_lookup_failed';

/**
 * How the optional invitation context on a registration request resolved.
 * `rejected` is the single collapsed bucket for EVERY private
 * invitation-validation failure — the caller answers the generic acceptance
 * and stages nothing. The specific failure is deliberately not modeled here:
 * carrying it further than the coarse event outcome would invite response
 * shaping to diverge per state.
 */
type RequestInvitationResolution =
  | { status: 'none' }
  | { status: 'valid'; invitationId: string; organizationName: string }
  | { status: 'rejected'; outcome: 'invitation_rejected' | 'invitation_lookup_failed' };

/**
 * THE public registration-request response — the same frozen object for every
 * post-validation outcome. Shaping it in exactly one place is part of the
 * enumeration-safety argument: no code path can grow a variant shape.
 */
const GENERIC_ACCEPTANCE: RegisterAcceptedResponse = Object.freeze({
  accepted: true as const,
});

/** Map the repository's invitation outcome to the response contract. */
function toInvitationOutcome(
  outcome: CompletionInvitationOutcome,
): RegistrationInvitationOutcome | null {
  switch (outcome) {
    case 'none':
      return null;
    case 'accepted':
      return { status: 'accepted' };
    case 'unavailable':
      return { status: 'unavailable' };
  }
}

export function createRegistrationService(
  options: RegistrationServiceOptions,
): RegistrationService {
  const {
    repo,
    mailer,
    webBaseUrl,
    completionTtlSeconds,
    jwtSecret,
    accessTokenTtlSeconds,
    sessionTtlSeconds,
    refreshTokenTtlSeconds,
    rateLimiter = createNoopRateLimiter(),
    rateLimitFailureMode = 'open',
    invitations,
    clock = systemClock,
  } = options;

  // Fail safe with permissive defaults if no limits are supplied (unit tests).
  // Production wires real values from config.
  const limits: RegistrationRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    requestPerIpMax: Number.MAX_SAFE_INTEGER,
    requestPerEmailMax: Number.MAX_SAFE_INTEGER,
    completePerIpMax: Number.MAX_SAFE_INTEGER,
    completePerTokenMax: Number.MAX_SAFE_INTEGER,
    existingAccountNoticePerEmailMax: Number.MAX_SAFE_INTEGER,
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
   * `rate_limit_exceeded` event (bucket name only — never the email, token,
   * or any derived key material) and throw `RATE_LIMITED`.
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
   * Record the internal outcome of a registration request. The ONLY event
   * writer for the request endpoint, and it enforces two policies:
   *
   *  - ANONYMOUS attribution, always. Submitting an email to a public
   *    endpoint authenticates nobody, so the event never carries a user id
   *    — in particular, a duplicate-registration probe must NEVER reference
   *    the existing account's user id.
   *  - NO-THROW, always. Every post-boundary path must produce the same
   *    public response, so an event-store failure is swallowed — it must
   *    never become a caller-visible distinction between outcomes.
   */
  async function recordRequestOutcome(
    outcome: RequestOutcome,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await writeSecurityEvent({
        userId: null,
        sessionId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.registrationRequested,
        metadata: { outcome, delivered: outcome === 'sent' },
        ctx,
      });
    } catch {
      // Swallowed: the enumeration-safe response is the priority.
    }
  }

  /**
   * Existing ACTIVE account path: send the neutral guidance email under the
   * internal notice throttle. Every failure mode (throttled, delivery error,
   * limiter error) is swallowed into an internal outcome — nothing here may
   * alter the public response, and no recovery/verification token is ever
   * minted. Applies identically to verified and unverified accounts, so
   * verification state is never disclosed.
   */
  async function sendExistingAccountGuidance(
    user: UserRow,
    normalizedEmail: string,
    ctx: RequestContext,
  ): Promise<void> {
    // INTERNAL bucket: a store outage conservatively SKIPS the email (never a
    // client error) — an unbounded notice stream to one mailbox is worse than
    // a missed courtesy email, regardless of the public failure mode.
    const decision = await rateLimiter.consume(
      `rl:register:notice:email:${hashOpaqueToken(normalizedEmail)}`,
      limits.existingAccountNoticePerEmailMax,
      limits.windowSeconds,
    );
    if (decision !== 'allowed') {
      await recordRequestOutcome('existing_account_notice_throttled', ctx);
      return;
    }
    try {
      await mailer.deliver(
        renderExistingAccountNoticeEmail({
          to: user.email,
          loginUrl: buildLoginUrl(webBaseUrl),
          forgotPasswordUrl: buildForgotPasswordUrl(webBaseUrl),
        }),
      );
      await recordRequestOutcome('existing_account_notice_sent', ctx);
    } catch {
      await recordRequestOutcome('existing_account_notice_failed', ctx);
    }
  }

  /**
   * Resolve and validate the OPTIONAL invitation context of a registration
   * request — the single translation point between the invitation module's
   * precise failures and this endpoint's enumeration-safe contract.
   *
   * Runs INSIDE the enumeration-safe boundary and NEVER throws for
   * invitation-state reasons: an unknown/malformed token, any lifecycle
   * state (expired, revoked, accepted), an email mismatch, quota
   * exhaustion, a failing resolver, and a missing collaborator all collapse
   * to `rejected`. Nothing was validated, so nothing about the invitation
   * (or any account) may reach the public response; the token holder's
   * feedback channel is the dedicated invitation-inspect endpoint.
   */
  async function resolveRequestInvitation(
    rawToken: string | undefined,
    normalizedEmail: string,
  ): Promise<RequestInvitationResolution> {
    if (!rawToken) {
      return { status: 'none' };
    }
    if (!invitations) {
      // A token with no collaborator wired is a deployment gap; publicly it
      // is indistinguishable from any other rejected invitation.
      return { status: 'rejected', outcome: 'invitation_rejected' };
    }
    try {
      const prepared = await invitations.prepareForRegistration(
        rawToken,
        normalizedEmail,
      );
      return { status: 'valid', ...prepared };
    } catch (error) {
      if (error instanceof AppError) {
        return { status: 'rejected', outcome: 'invitation_rejected' };
      }
      // Resolver/infrastructure failure: equally non-disclosing, but recorded
      // under its own coarse outcome so an outage is distinguishable from
      // probing in the (internal) event stream.
      return { status: 'rejected', outcome: 'invitation_lookup_failed' };
    }
  }

  /**
   * Resolve the invitation context the completion transaction needs, from the
   * pending row's stored invitation ID. Never throws for invitation-state
   * reasons: an unresolvable or errored context yields null and the
   * completion settles the invitation as unavailable.
   */
  async function resolveCompletionInvitation(
    invitationId: string | null,
    ctx: RequestContext,
  ): Promise<CompletionInvitationContext | null> {
    if (invitationId === null || !invitations) {
      return null;
    }
    let context: { maxMembers: number } | null;
    try {
      context = await invitations.resolveCompletionContext(invitationId);
    } catch (error) {
      if (error instanceof AppError) {
        return null;
      }
      throw error;
    }
    if (!context) {
      return null;
    }
    return {
      invitationId,
      maxMembers: context.maxMembers,
      eventContext: {
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      },
    };
  }

  return {
    async requestRegistration(input, ctx) {
      const normalizedEmail = normalizeEmail(input.email);

      // Rate-limit before any account lookup. Both buckets return the SAME
      // RATE_LIMITED regardless of whether the email exists, so neither is an
      // account-existence oracle. The email is hashed into the key so no raw
      // email is stored in Redis (same construction as the login limiter).
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:register:ip:${ctx.ipAddress}`,
          limits.requestPerIpMax,
          'register_per_ip',
          ctx,
        );
      }
      await enforceRateLimit(
        `rl:register:email:${hashOpaqueToken(normalizedEmail)}`,
        limits.requestPerEmailMax,
        'register_per_email',
        ctx,
      );

      // Hash the password BEFORE anything state-dependent so the dominant
      // CPU cost (Argon2id) is spent identically on every path — including
      // rejected-invitation paths — and simply discarded when the request
      // turns out to be ineligible.
      const passwordHash = await hashPassword(input.password);

      // The enumeration-safe boundary starts HERE: once payload validation
      // and rate limiting have passed, no internal outcome — invitation
      // state, account state, persistence, delivery, or the event write —
      // may alter the public response.
      const invitation = await resolveRequestInvitation(
        input.invitationToken,
        normalizedEmail,
      );
      if (invitation.status === 'rejected') {
        // Nothing is staged, nothing is sent (not even existing-account
        // guidance — a failed invitation must not become a probe vehicle),
        // and no invitation state is mutated. Same public acceptance.
        await recordRequestOutcome(invitation.outcome, ctx);
        return GENERIC_ACCEPTANCE;
      }
      const invitationContext =
        invitation.status === 'valid' ? invitation : null;

      let existingUser: UserRow | null;
      try {
        existingUser = await repo.findUserByNormalizedEmail(normalizedEmail);
      } catch {
        await recordRequestOutcome('lookup_failed', ctx);
        return GENERIC_ACCEPTANCE;
      }

      if (existingUser) {
        // NEVER a duplicate user, NEVER a pending registration. An active
        // account (verified or not) gets neutral guidance; a disabled or
        // soft-deleted account gets nothing (no reactivation policy exists).
        const eligibleForGuidance =
          existingUser.status === 'active' && existingUser.deletedAt === null;
        if (eligibleForGuidance) {
          await sendExistingAccountGuidance(existingUser, normalizedEmail, ctx);
        } else {
          await recordRequestOutcome('ineligible_account', ctx);
        }
        return GENERIC_ACCEPTANCE;
      }

      // Eligible new email. PERSIST-AND-COMMIT BEFORE SEND (see the service
      // doc): every emailed token was durably staged first, and neither
      // failure mode may alter the public response. The raw token exists only
      // in this scope and the outgoing message.
      const rawToken = generateRegistrationCompletionToken();
      const expiresAt = new Date(
        clock.epochMillis() + completionTtlSeconds * 1000,
      );
      try {
        await repo.issuePendingRegistration({
          email: input.email.trim(),
          normalizedEmail,
          passwordHash,
          displayName: input.displayName,
          tokenHash: hashRegistrationCompletionToken(rawToken),
          invitationId: invitationContext?.invitationId ?? null,
          expiresAt,
          now: clock.now(),
        });
      } catch {
        await recordRequestOutcome('persist_failed', ctx);
        return GENERIC_ACCEPTANCE;
      }

      try {
        await mailer.deliver(
          renderRegistrationCompletionEmail({
            to: input.email.trim(),
            completeUrl: buildRegistrationCompletionUrl(webBaseUrl, rawToken),
            expiresAt,
            invitationOrganizationName:
              invitationContext?.organizationName ?? null,
          }),
        );
      } catch {
        // The staged-but-undelivered generation is harmless: unknown to
        // anyone, expiring, and superseded by the next successful request.
        await recordRequestOutcome('send_failed', ctx);
        return GENERIC_ACCEPTANCE;
      }

      await recordRequestOutcome('sent', ctx);
      return GENERIC_ACCEPTANCE;
    },

    async completeRegistration(input, ctx) {
      if (ctx.ipAddress) {
        await enforceRateLimit(
          `rl:register:complete:ip:${ctx.ipAddress}`,
          limits.completePerIpMax,
          'registration_complete_per_ip',
          ctx,
        );
      }
      // Per-token bucket: bounds brute-force retries against one specific
      // token independently of the attacker's IP pool. Keyed on a
      // second-order digest — never the raw token or the storage hash.
      await enforceRateLimit(
        `rl:register:complete:token:${registrationCompletionRateLimitKey(input.token)}`,
        limits.completePerTokenMax,
        'registration_complete_per_token',
        ctx,
      );

      const tokenHash = hashRegistrationCompletionToken(input.token);

      // Non-locking pre-read to resolve invitation completion context (plan
      // ceilings live outside the transaction). The transaction re-reads the
      // row under a lock and is the sole authority on token validity.
      const pending = await repo.findPendingRegistrationByTokenHash(tokenHash);
      const invitationContext = await resolveCompletionInvitation(
        pending?.invitationId ?? null,
        ctx,
      );

      const now = clock.now();
      const rawRefreshToken = generateOpaqueToken();
      const result = await repo.completeRegistration({
        tokenHash,
        session: {
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000),
        },
        refreshToken: {
          tokenHash: hashOpaqueToken(rawRefreshToken),
          familyId: createId('rtok'),
          expiresAt: new Date(now.getTime() + refreshTokenTtlSeconds * 1000),
        },
        invitation: invitationContext,
        now,
      });

      if (result.status === 'completed') {
        const accessToken = await signAccessToken({
          userId: result.user.id,
          sessionId: result.session.id,
          secret: jwtSecret,
          ttlSeconds: accessTokenTtlSeconds,
        });
        // TOKEN-AUTHORIZED attribution: a successful completion has proven
        // control of the registered mailbox — the same identity basis the
        // other token-completion events use. Metadata carries only the
        // coarse invitation outcome; never tokens, hashes, or URLs.
        await writeSecurityEvent({
          userId: result.user.id,
          sessionId: result.session.id,
          actorType: 'user',
          eventType: SECURITY_EVENT_TYPES.registrationCompletionSucceeded,
          metadata: { invitation: result.invitation },
          ctx,
        });
        return {
          rawRefreshToken,
          response: {
            user: toAuthUser(result.user),
            tokens: {
              accessToken,
              tokenType: 'Bearer',
              expiresIn: accessTokenTtlSeconds,
            },
            invitation: toInvitationOutcome(result.invitation),
          },
        };
      }

      // A REJECTED completion proved nothing: anonymous, null user id, coarse
      // token-free `reason` — never a token-derived account reference.
      await writeSecurityEvent({
        userId: null,
        sessionId: null,
        actorType: 'anonymous',
        eventType: SECURITY_EVENT_TYPES.registrationCompletionRejected,
        metadata: { reason: result.status },
        ctx,
      });
      switch (result.status) {
        case 'expired':
          throw registrationTokenExpiredError();
        case 'already_used':
          throw registrationTokenUsedError();
        case 'not_found':
        case 'email_taken':
          // Indistinguishable on purpose: account state is never disclosed.
          throw registrationTokenInvalidError();
      }
    },
  };
}
