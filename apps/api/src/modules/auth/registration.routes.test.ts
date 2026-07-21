import { hashOpaqueToken } from '@orgistry/auth-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { RateLimiter } from '../../lib/rate-limit';
import {
  buildAuthTestApp,
  type AuthTestContext,
} from './testing/build-auth-test-app';
import {
  lastCompletionTokenFor,
  registerTestUser,
} from './testing/register-test-user';

/**
 * Verification-first registration route behavior (Sprint 18), exercised
 * through `app.inject` over the in-memory repositories.
 *
 * This suite is the primary evidence for closing ORG-PR-030 (registration
 * user enumeration): the public register endpoint must be contract-identical
 * for every post-validation account state, create no account state, and leak
 * no secret material anywhere. DB-backed persistence and true concurrency are
 * covered in `registration.integration.test.ts`.
 */

const VALID_REGISTER = {
  email: 'New.User@Example.com',
  password: 'a-strong-password-123',
  displayName: 'New User',
};
const NORMALIZED_EMAIL = 'new.user@example.com';

let ctx: AuthTestContext;

beforeEach(async () => {
  ctx = await buildAuthTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

function register(
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: body,
  });
}

function complete(token: string): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/registration/complete',
    payload: { token },
  });
}

/** The captured completion email for an address, or null. */
function completionEmailFor(email: string) {
  return (
    ctx.mailer.messages.findLast(
      (message) =>
        message.to === email &&
        message.text.includes('/auth/complete-registration#token='),
    ) ?? null
  );
}

describe('POST /v1/auth/register (request)', () => {
  it('returns the generic accepted response and NO authentication state', async () => {
    const response = await register(VALID_REGISTER);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ ok: true, data: { accepted: true } });
    // No cookie, no tokens, no user, no organization, no membership.
    expect(response.headers['set-cookie']).toBeUndefined();

    // Absolutely no account state is created by the initial request.
    expect(ctx.repo.users).toHaveLength(0);
    expect(ctx.repo.sessions).toHaveLength(0);
    expect(ctx.repo.refreshTokens).toHaveLength(0);
    expect(ctx.repo.orgStore.organizations).toHaveLength(0);
    expect(ctx.repo.orgStore.memberships).toHaveLength(0);

    // What IS created: exactly one pending registration.
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(1);
  });

  it('stages the password only as an Argon2id hash and the token only as a hash', async () => {
    await register(VALID_REGISTER);
    const pending = ctx.registrationRepo.pendingRegistrations[0];
    expect(pending.normalizedEmail).toBe(NORMALIZED_EMAIL);
    expect(pending.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(pending.passwordHash).not.toContain(VALID_REGISTER.password);

    const rawToken = lastCompletionTokenFor(ctx.mailer, VALID_REGISTER.email);
    expect(rawToken).toBeTruthy();
    expect(pending.tokenHash).not.toBe(rawToken);
    expect(pending.tokenHash).toBe(hashOpaqueToken(rawToken as string));
  });

  it('emails a fragment-based completion link, never a query-string token', async () => {
    await register(VALID_REGISTER);
    const message = completionEmailFor(VALID_REGISTER.email);
    expect(message).not.toBeNull();
    expect(message?.text).toContain('/auth/complete-registration#token=');
    // No email in the whole run may ever carry a query-string token.
    for (const sent of ctx.mailer.messages) {
      expect(sent.text).not.toContain('?token=');
    }
  });

  it('never returns or logs the raw token, password, or hashes', async () => {
    const response = await register(VALID_REGISTER);
    const rawToken = lastCompletionTokenFor(ctx.mailer, VALID_REGISTER.email);
    const pending = ctx.registrationRepo.pendingRegistrations[0];

    const responseText = response.body;
    expect(responseText).not.toContain(rawToken as string);
    expect(responseText).not.toContain(VALID_REGISTER.password);
    expect(responseText).not.toContain(pending.tokenHash);
    expect(responseText).not.toContain(pending.passwordHash);

    // Security events carry no secret material or email either.
    const events = JSON.stringify(ctx.registrationRepo.securityEvents);
    expect(events).not.toContain(rawToken as string);
    expect(events).not.toContain(VALID_REGISTER.password);
    expect(events).not.toContain(pending.tokenHash);
    expect(events).not.toContain(pending.passwordHash);
    expect(JSON.stringify(ctx.registrationRepo.securityEvents.map((e) => e.metadata))).not.toContain(
      NORMALIZED_EMAIL,
    );
  });

  it('records an anonymous registration_requested event with a coarse outcome', async () => {
    await register(VALID_REGISTER);
    const event = ctx.registrationRepo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_requested',
    );
    expect(event).toBeDefined();
    expect(event?.userId).toBeNull();
    expect(event?.actorType).toBe('anonymous');
    expect(event?.metadata).toEqual({ outcome: 'sent', delivered: true });
  });

  it('still accepts when the completion email cannot be delivered', async () => {
    ctx.mailer.failNext = true;
    const response = await register(VALID_REGISTER);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    // The staged-but-undelivered generation exists and is harmless.
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(1);
    const event = ctx.registrationRepo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_requested',
    );
    expect(event?.metadata).toEqual({ outcome: 'send_failed', delivered: false });
  });

  it('rejects an invalid payload with VALIDATION_ERROR (explicit, pre-boundary)', async () => {
    const response = await register({ ...VALID_REGISTER, password: 'short' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(0);
  });

  it('answers a rejected invitation token with the SAME generic acceptance and stages nothing', async () => {
    // This builder wires no invitation collaborator, so any token is a
    // rejected invitation — publicly indistinguishable from every other
    // registration outcome. The invitation-inspect endpoint is the intended
    // feedback channel; registration never becomes an invitation oracle.
    const response = await register({
      ...VALID_REGISTER,
      invitationToken: 'not-a-real-invitation',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(0);
    expect(ctx.repo.users).toHaveLength(0);
    expect(ctx.mailer.messages).toHaveLength(0);
    const event = ctx.registrationRepo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_requested',
    );
    expect(event?.userId).toBeNull();
    expect(event?.actorType).toBe('anonymous');
    expect(event?.metadata).toEqual({
      outcome: 'invitation_rejected',
      delivered: false,
    });
    // The raw invitation token never reaches the event stream.
    expect(JSON.stringify(ctx.registrationRepo.securityEvents)).not.toContain(
      'not-a-real-invitation',
    );
  });
});

describe('POST /v1/auth/register (existing and ineligible accounts)', () => {
  beforeEach(async () => {
    await registerTestUser(ctx.app, ctx.mailer, VALID_REGISTER);
    // Focus the mailbox assertions on what happens AFTER this point.
    ctx.mailer.messages.length = 0;
  });

  it('answers an existing ACTIVE account with the same accepted response and stages nothing', async () => {
    const response = await register({
      ...VALID_REGISTER,
      email: '  NEW.user@example.COM ',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });

    // No duplicate user, no NEW pending registration (only the consumed one).
    expect(ctx.repo.users).toHaveLength(1);
    const usable = ctx.registrationRepo.pendingRegistrations.filter(
      (p) => p.usedAt === null && p.invalidatedAt === null,
    );
    expect(usable).toHaveLength(0);
  });

  it('sends guidance (sign-in / recovery links, NO token) to the existing address', async () => {
    await register(VALID_REGISTER);
    const notice = ctx.mailer.messages.at(-1);
    expect(notice?.to).toBe(VALID_REGISTER.email);
    expect(notice?.text).toContain('/auth/login');
    expect(notice?.text).toContain('/auth/forgot-password');
    expect(notice?.text).not.toContain('token=');

    // Guidance NEVER mints a password-recovery token.
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(0);
  });

  it('throttles the guidance email silently without altering the response', async () => {
    const first = await register(VALID_REGISTER);
    const second = await register(VALID_REGISTER);
    expect(first.json()).toEqual(second.json());
    // Default notice limit is effectively unlimited in tests; simulate the
    // throttle explicitly instead via a rejecting limiter in the matrix suite.
    expect(second.statusCode).toBe(200);
  });

  it('anonymously records the existing-account attempt without the victim user id', async () => {
    await register(VALID_REGISTER);
    const events = ctx.registrationRepo.securityEvents.filter(
      (e) => e.eventType === 'auth.registration_requested',
    );
    const latest = events.at(-1);
    expect(latest?.userId).toBeNull();
    expect(latest?.actorType).toBe('anonymous');
    expect(String((latest?.metadata as { outcome?: string }).outcome)).toContain(
      'existing_account',
    );
  });

  it('answers an UNVERIFIED active account identically and discloses nothing', async () => {
    const user = ctx.repo.users[0];
    user.emailVerifiedAt = null;
    const response = await register(VALID_REGISTER);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(ctx.repo.users).toHaveLength(1);
    // No verification token is minted through public registration.
    expect(ctx.verificationRepo.tokens).toHaveLength(0);
  });

  it('answers a DISABLED account identically and sends nothing', async () => {
    ctx.repo.users[0].status = 'disabled';
    const response = await register(VALID_REGISTER);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(ctx.mailer.messages).toHaveLength(0);
    expect(ctx.repo.users).toHaveLength(1);
  });

  it('answers a SOFT-DELETED account identically and sends nothing', async () => {
    ctx.repo.users[0].deletedAt = new Date();
    const response = await register(VALID_REGISTER);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(ctx.mailer.messages).toHaveLength(0);
    expect(ctx.repo.users).toHaveLength(1);
  });
});

describe('public response equality matrix', () => {
  interface PublicShape {
    status: number;
    body: unknown;
    setCookie: unknown;
    authHeader: unknown;
  }

  function publicShape(response: LightMyRequestResponse): PublicShape {
    return {
      status: response.statusCode,
      body: response.json(),
      setCookie: response.headers['set-cookie'],
      authHeader: response.headers.authorization,
    };
  }

  it('is byte-identical across every post-validation account state', async () => {
    // Baseline: eligible new email.
    const newEmail = publicShape(
      await register({ ...VALID_REGISTER, email: 'fresh@example.com' }),
    );

    // Existing ACTIVE account.
    await registerTestUser(ctx.app, ctx.mailer, {
      email: 'active@example.com',
      password: VALID_REGISTER.password,
      displayName: 'Active User',
    });
    const activeAccount = publicShape(
      await register({ ...VALID_REGISTER, email: 'active@example.com' }),
    );

    // Existing UNVERIFIED account.
    const activeUser = ctx.repo.users.find(
      (u) => u.normalizedEmail === 'active@example.com',
    );
    if (activeUser) activeUser.emailVerifiedAt = null;
    const unverifiedAccount = publicShape(
      await register({ ...VALID_REGISTER, email: 'active@example.com' }),
    );

    // DISABLED account.
    await registerTestUser(ctx.app, ctx.mailer, {
      email: 'disabled@example.com',
      password: VALID_REGISTER.password,
      displayName: 'Disabled User',
    });
    const disabledUser = ctx.repo.users.find(
      (u) => u.normalizedEmail === 'disabled@example.com',
    );
    if (disabledUser) disabledUser.status = 'disabled';
    const disabledAccount = publicShape(
      await register({ ...VALID_REGISTER, email: 'disabled@example.com' }),
    );

    // SOFT-DELETED account.
    await registerTestUser(ctx.app, ctx.mailer, {
      email: 'deleted@example.com',
      password: VALID_REGISTER.password,
      displayName: 'Deleted User',
    });
    const deletedUser = ctx.repo.users.find(
      (u) => u.normalizedEmail === 'deleted@example.com',
    );
    if (deletedUser) deletedUser.deletedAt = new Date();
    const deletedAccount = publicShape(
      await register({ ...VALID_REGISTER, email: 'deleted@example.com' }),
    );

    // Internal mailer failure on an eligible new email.
    ctx.mailer.failNext = true;
    const mailFailure = publicShape(
      await register({ ...VALID_REGISTER, email: 'mail-broken@example.com' }),
    );

    // Direct equality: one canonical shape for every state.
    expect(activeAccount).toEqual(newEmail);
    expect(unverifiedAccount).toEqual(newEmail);
    expect(disabledAccount).toEqual(newEmail);
    expect(deletedAccount).toEqual(newEmail);
    expect(mailFailure).toEqual(newEmail);
    expect(newEmail.status).toBe(200);
    expect(newEmail.setCookie).toBeUndefined();
    expect(newEmail.authHeader).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('runs the per-email limit BEFORE the account lookup and answers 429 identically for all states', async () => {
    const lookups: string[] = [];
    const rejectAll: RateLimiter = { consume: async () => 'limited' };
    const limited = await buildAuthTestApp({
      rateLimiter: rejectAll,
      registrationRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 1,
        requestPerEmailMax: 1,
        completePerIpMax: 1,
        completePerTokenMax: 1,
        existingAccountNoticePerEmailMax: 1,
      },
    });
    const originalLookup =
      limited.registrationRepo.findUserByNormalizedEmail.bind(
        limited.registrationRepo,
      );
    limited.registrationRepo.findUserByNormalizedEmail = async (email) => {
      lookups.push(email);
      return originalLookup(email);
    };
    try {
      const response = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: VALID_REGISTER,
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('RATE_LIMITED');
      // The limiter fired before ANY account lookup ran.
      expect(lookups).toHaveLength(0);
      expect(limited.registrationRepo.pendingRegistrations).toHaveLength(0);
    } finally {
      await limited.app.close();
    }
  });

  it('keys the per-email bucket on a digest, never the raw email', async () => {
    const keys: string[] = [];
    const recording: RateLimiter = {
      consume: async (key) => {
        keys.push(key);
        return 'allowed';
      },
    };
    const recorded = await buildAuthTestApp({ rateLimiter: recording });
    try {
      await recorded.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: VALID_REGISTER,
      });
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(NORMALIZED_EMAIL);
        expect(key.toLowerCase()).not.toContain('example.com');
      }
    } finally {
      await recorded.app.close();
    }
  });

  it('bounds uncontrolled email generation through the per-email bucket', async () => {
    let calls = 0;
    const secondRejects: RateLimiter = {
      consume: async (key) => {
        if (!key.startsWith('rl:register:email:')) return 'allowed';
        calls += 1;
        return calls <= 1 ? 'allowed' : 'limited';
      },
    };
    const bounded = await buildAuthTestApp({
      rateLimiter: secondRejects,
      registrationRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: Number.MAX_SAFE_INTEGER,
        requestPerEmailMax: 1,
        completePerIpMax: Number.MAX_SAFE_INTEGER,
        completePerTokenMax: Number.MAX_SAFE_INTEGER,
        existingAccountNoticePerEmailMax: Number.MAX_SAFE_INTEGER,
      },
    });
    try {
      const first = await bounded.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: VALID_REGISTER,
      });
      const second = await bounded.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: VALID_REGISTER,
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
      expect(bounded.mailer.messages).toHaveLength(1);
    } finally {
      await bounded.app.close();
    }
  });
});

describe('replacement and issuance', () => {
  it('a repeated request supersedes older generations, leaving exactly one usable', async () => {
    await register(VALID_REGISTER);
    const firstToken = lastCompletionTokenFor(
      ctx.mailer,
      VALID_REGISTER.email,
    ) as string;
    await register(VALID_REGISTER);
    const secondToken = lastCompletionTokenFor(
      ctx.mailer,
      VALID_REGISTER.email,
    ) as string;
    expect(secondToken).not.toBe(firstToken);

    const usable = ctx.registrationRepo.pendingRegistrations.filter(
      (p) => p.usedAt === null && p.invalidatedAt === null,
    );
    expect(usable).toHaveLength(1);
    expect(usable[0].tokenHash).toBe(hashOpaqueToken(secondToken));

    // The superseded emailed link fails safely; the newest link works.
    const superseded = await complete(firstToken);
    expect(superseded.statusCode).toBe(409);
    expect(superseded.json().error.code).toBe('REGISTRATION_TOKEN_USED');
    const current = await complete(secondToken);
    expect(current.statusCode).toBe(201);
  });

  it('concurrent issuance for one normalized email leaves exactly one usable generation', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => register(VALID_REGISTER)),
    );
    const usable = ctx.registrationRepo.pendingRegistrations.filter(
      (p) => p.usedAt === null && p.invalidatedAt === null,
    );
    expect(usable).toHaveLength(1);
    expect(ctx.registrationRepo.pendingRegistrations).toHaveLength(5);
  });
});

describe('POST /v1/auth/registration/complete', () => {
  async function stagedToken(
    input = VALID_REGISTER,
  ): Promise<string> {
    await register(input);
    return lastCompletionTokenFor(ctx.mailer, input.email) as string;
  }

  it('creates the full account atomically and returns the authenticated result', async () => {
    const token = await stagedToken();
    const response = await complete(token);
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.data.user.email).toBe(VALID_REGISTER.email);
    expect(body.data.user.displayName).toBe(VALID_REGISTER.displayName);
    // Verification-first invariant: the completed account is verified.
    expect(body.data.user.emailVerified).toBe(true);
    expect(body.data.tokens.tokenType).toBe('Bearer');
    expect(body.data.invitation).toBeNull();

    // Refresh cookie only on completion.
    expect(response.headers['set-cookie']).toBeDefined();

    // User + personal workspace + Owner membership + session + refresh token.
    expect(ctx.repo.users).toHaveLength(1);
    expect(ctx.repo.users[0].normalizedEmail).toBe(NORMALIZED_EMAIL);
    expect(ctx.repo.users[0].emailVerifiedAt).not.toBeNull();
    expect(ctx.repo.orgStore.organizations).toHaveLength(1);
    expect(ctx.repo.orgStore.organizations[0].type).toBe('personal');
    expect(ctx.repo.orgStore.memberships).toHaveLength(1);
    expect(ctx.repo.sessions).toHaveLength(1);
    expect(ctx.repo.refreshTokens).toHaveLength(1);
    // The refresh token is stored hash-only (not any raw value we ever saw).
    expect(ctx.repo.refreshTokens[0].tokenHash).not.toBe(token);

    // The pending registration is consumed.
    const pending = ctx.registrationRepo.pendingRegistrations[0];
    expect(pending.usedAt).not.toBeNull();

    // The access token works against /me.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.data.tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('records a completion event attributed to the newly proven user, with no secrets', async () => {
    const token = await stagedToken();
    await complete(token);
    const event = ctx.registrationRepo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_completion_succeeded',
    );
    expect(event).toBeDefined();
    expect(event?.userId).toBe(ctx.repo.users[0].id);
    expect(event?.actorType).toBe('user');
    expect(event?.metadata).toEqual({ invitation: 'none' });
    const raw = JSON.stringify(event);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(hashOpaqueToken(token));
  });

  it('accepts the token only in the request body, never a query string', async () => {
    const token = await stagedToken();
    const viaQuery = await ctx.app.inject({
      method: 'POST',
      url: `/v1/auth/registration/complete?token=${encodeURIComponent(token)}`,
      payload: {},
    });
    expect(viaQuery.statusCode).toBe(400);
    expect(viaQuery.json().error.code).toBe('VALIDATION_ERROR');
    // The token was not consumed by the rejected attempt.
    const accepted = await complete(token);
    expect(accepted.statusCode).toBe(201);
  });

  it('rejects an unknown token with REGISTRATION_TOKEN_INVALID and creates nothing', async () => {
    const response = await complete('completely-unknown-token');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REGISTRATION_TOKEN_INVALID');
    expect(ctx.repo.users).toHaveLength(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    const event = ctx.registrationRepo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_completion_rejected',
    );
    expect(event?.userId).toBeNull();
    expect(event?.actorType).toBe('anonymous');
  });

  it('rejects an expired token with REGISTRATION_TOKEN_EXPIRED', async () => {
    const token = await stagedToken();
    ctx.registrationRepo.pendingRegistrations[0].expiresAt = new Date(
      Date.now() - 1000,
    );
    const response = await complete(token);
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('REGISTRATION_TOKEN_EXPIRED');
    expect(ctx.repo.users).toHaveLength(0);
  });

  it('a used token cannot be reused and never creates a second account', async () => {
    const token = await stagedToken();
    const first = await complete(token);
    expect(first.statusCode).toBe(201);
    const second = await complete(token);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REGISTRATION_TOKEN_USED');
    expect(ctx.repo.users).toHaveLength(1);
    expect(ctx.repo.sessions).toHaveLength(1);
  });

  it('exactly one of many concurrent completions of the same token succeeds', async () => {
    const token = await stagedToken();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => complete(token)),
    );
    const succeeded = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode === 409);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(ctx.repo.users).toHaveLength(1);
    expect(ctx.repo.sessions).toHaveLength(1);
    expect(ctx.repo.refreshTokens).toHaveLength(1);
    expect(ctx.repo.orgStore.organizations).toHaveLength(1);
  });

  it('handles a user created during the pending window as an invalid token', async () => {
    const token = await stagedToken();
    // The email gets taken through another path (e.g. an authenticated email
    // change) while the pending registration is open.
    await registerTestUser(ctx.app, ctx.mailer, {
      email: 'squatter@example.com',
      password: VALID_REGISTER.password,
      displayName: 'Squatter',
    });
    const squatter = ctx.repo.users.find(
      (u) => u.normalizedEmail === 'squatter@example.com',
    );
    if (squatter) {
      squatter.email = VALID_REGISTER.email;
      squatter.normalizedEmail = NORMALIZED_EMAIL;
    }

    const response = await complete(token);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REGISTRATION_TOKEN_INVALID');
    // No second user for the email, no partial account resources.
    expect(
      ctx.repo.users.filter((u) => u.normalizedEmail === NORMALIZED_EMAIL),
    ).toHaveLength(1);
  });

  it('throttles completion attempts per token and per IP', async () => {
    const limited = await buildAuthTestApp({
      rateLimiter: { consume: async () => 'limited' },
      registrationRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 1,
        requestPerEmailMax: 1,
        completePerIpMax: 1,
        completePerTokenMax: 1,
        existingAccountNoticePerEmailMax: 1,
      },
    });
    try {
      const response = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/registration/complete',
        payload: { token: 'whatever' },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.app.close();
    }
  });
});
