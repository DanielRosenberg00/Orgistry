import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import { hashEmailVerificationToken } from './email-verification.token';
import {
  buildAuthTestApp,
  type AuthTestContext,
  type BuildAuthTestAppOptions,
} from './testing/build-auth-test-app';

/**
 * End-to-end email-verification behavior through `app.inject`, backed by the
 * in-memory repositories and the in-memory account mailer. Raw tokens are
 * recovered ONLY from the captured email link — exactly the recipient's
 * channel; the API never returns them. DB-backed persistence and the
 * FOR-UPDATE race are covered in `email-verification.integration.test.ts`.
 */

const REGISTER_BODY = {
  email: 'verify.me@example.com',
  password: 'a-strong-password-123',
  displayName: 'Verify Me',
};

async function setup(
  options: BuildAuthTestAppOptions = {},
): Promise<AuthTestContext & { accessToken: string; userId: string }> {
  const ctx = await buildAuthTestApp(options);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: REGISTER_BODY,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return {
    ...ctx,
    accessToken: body.data.tokens.accessToken,
    userId: body.data.user.id,
  };
}

function requestVerification(
  ctx: { app: AuthTestContext['app'] },
  accessToken?: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/email-verification/request',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

function completeVerification(
  ctx: { app: AuthTestContext['app'] },
  token: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/email-verification/complete',
    payload: { token },
  });
}

function me(
  ctx: { app: AuthTestContext['app'] },
  accessToken: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

describe('registration integration', () => {
  it('sends the first verification email automatically and starts unverified', async () => {
    const ctx = await setup();

    expect(ctx.mailer.messages).toHaveLength(1);
    const email = ctx.mailer.messages[0];
    expect(email.to).toBe(REGISTER_BODY.email);
    expect(email.subject).toContain('Verify');
    // The link carries the token in the URL FRAGMENT — never a query string,
    // so the token can never reach a web server, proxy log, or Referer.
    expect(email.text).toContain(
      `${ctx.config.web.url}/auth/verify-email#token=`,
    );
    expect(email.text).not.toContain('?token=');
    expect(ctx.verificationRepo.tokens).toHaveLength(1);
    expect(
      ctx.repo.users.find((u) => u.id === ctx.userId)?.emailVerifiedAt,
    ).toBeNull();
  });

  it('stores only the token hash — never the raw token', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken();
    expect(rawToken).toBeTruthy();

    const [record] = ctx.verificationRepo.tokens;
    expect(record.tokenHash).toBe(hashEmailVerificationToken(rawToken!));
    expect(record.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(ctx.verificationRepo.tokens)).not.toContain(rawToken);
  });

  it('registration succeeds even when the verification email fails to deliver', async () => {
    const ctx = await buildAuthTestApp();
    ctx.mailer.failNext = true;

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: REGISTER_BODY,
    });

    expect(response.statusCode).toBe(201);
    expect(ctx.mailer.messages).toHaveLength(0);
    expect(ctx.verificationRepo.tokens).toHaveLength(0);
    // The failure is recorded safely (no token material in the event).
    const requested = ctx.repo.securityEvents.filter(
      (event) => event.eventType === 'auth.email_verification_requested',
    );
    expect(requested).toHaveLength(1);
    expect(requested[0].metadata).toMatchObject({ delivered: false });
    // Resend remains available.
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: REGISTER_BODY.email, password: REGISTER_BODY.password },
    });
    const resend = await requestVerification(
      ctx,
      login.json().data.tokens.accessToken,
    );
    expect(resend.statusCode).toBe(200);
    expect(ctx.mailer.messages).toHaveLength(1);
  });
});

describe('POST /v1/auth/email-verification/request', () => {
  it('requires authentication and accepts no body input', async () => {
    const ctx = await setup();
    const response = await requestVerification(ctx);
    expect(response.statusCode).toBe(401);
  });

  it('issues a fresh token and emails the current user only', async () => {
    const ctx = await setup();
    const response = await requestVerification(ctx, ctx.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { sent: true, alreadyVerified: false },
    });
    // Registration email + explicit request email, both to the stored address.
    expect(ctx.mailer.messages).toHaveLength(2);
    expect(ctx.mailer.messages[1].to).toBe(REGISTER_BODY.email);
  });

  it('never returns the raw token or its hash', async () => {
    const ctx = await setup();
    const response = await requestVerification(ctx, ctx.accessToken);

    const raw = JSON.stringify(response.json());
    const rawToken = ctx.mailer.lastLinkToken()!;
    expect(raw).not.toContain(rawToken);
    expect(raw).not.toContain(hashEmailVerificationToken(rawToken));
    expect(raw).not.toMatch(/token/i);
  });

  it('resend invalidates all previous unused tokens (single usable generation)', async () => {
    const ctx = await setup();
    const firstToken = ctx.mailer.lastLinkToken()!;
    await requestVerification(ctx, ctx.accessToken);

    const usable = ctx.verificationRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(ctx.verificationRepo.tokens).toHaveLength(2);
    expect(usable).toHaveLength(1);

    // The pre-resend token is rejected as used/invalidated.
    const stale = await completeVerification(ctx, firstToken);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');
  });

  it('returns safe success without sending when already verified', async () => {
    const ctx = await setup();
    await completeVerification(ctx, ctx.mailer.lastLinkToken()!);
    const sentBefore = ctx.mailer.messages.length;

    const response = await requestVerification(ctx, ctx.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ sent: false, alreadyVerified: true });
    expect(ctx.mailer.messages).toHaveLength(sentBefore);
  });

  it('rate limits per user through the standard error envelope', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      emailVerificationRateLimits: {
        windowSeconds: 60,
        requestPerUserMax: 2,
        requestPerIpMax: 100,
        completePerIpMax: 100,
      },
    });

    expect((await requestVerification(ctx, ctx.accessToken)).statusCode).toBe(200);
    expect((await requestVerification(ctx, ctx.accessToken)).statusCode).toBe(200);
    const limited = await requestVerification(ctx, ctx.accessToken);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /v1/auth/email-verification/complete', () => {
  it('verifies the account with the emailed token (public, no auth required)', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken()!;

    const response = await completeVerification(ctx, rawToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { verified: true } });

    // User timestamp set; token consumed.
    const user = ctx.repo.users.find((u) => u.id === ctx.userId)!;
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    const [record] = ctx.verificationRepo.tokens;
    expect(record.usedAt).toBeInstanceOf(Date);

    // The current-user contract reflects the new state.
    const meResponse = await me(ctx, ctx.accessToken);
    expect(meResponse.json().data.user.emailVerified).toBe(true);
  });

  it('invalidates sibling active tokens on completion', async () => {
    const ctx = await setup();
    // Issue a second generation, then hand-craft a competing usable sibling to
    // prove completion retires everything else.
    await requestVerification(ctx, ctx.accessToken);
    const usableToken = ctx.mailer.lastLinkToken()!;
    ctx.verificationRepo.tokens.push({
      ...ctx.verificationRepo.tokens[0],
      id: 'evtok_sibling_fixture',
      tokenHash: hashEmailVerificationToken('sibling-raw-token'),
      usedAt: null,
      invalidatedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await completeVerification(ctx, usableToken);

    const stillUsable = ctx.verificationRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(stillUsable).toHaveLength(0);
  });

  it('rejects reuse of a consumed token (single-use invariant)', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken()!;
    await completeVerification(ctx, rawToken);

    const reuse = await completeVerification(ctx, rawToken);

    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');
    // Reuse is NOT a second successful verification.
    const user = ctx.repo.users.find((u) => u.id === ctx.userId)!;
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects an expired token', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken()!;
    ctx.verificationRepo.tokens[0].expiresAt = new Date(Date.now() - 1000);

    const response = await completeVerification(ctx, rawToken);

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_EXPIRED');
    expect(
      ctx.repo.users.find((u) => u.id === ctx.userId)?.emailVerifiedAt,
    ).toBeNull();
  });

  it('rejects an unknown token safely', async () => {
    const ctx = await setup();
    const response = await completeVerification(ctx, 'not-a-real-token');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');
  });

  it('rejects a token whose account is disabled, indistinguishably from unknown', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken()!;
    ctx.repo.users.find((u) => u.id === ctx.userId)!.status = 'disabled';

    const response = await completeVerification(ctx, rawToken);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');
    // The token was not consumed (nothing mutated for an unverifiable account).
    expect(ctx.verificationRepo.tokens[0].usedAt).toBeNull();
  });

  it('rejects a missing or empty token as a validation error', async () => {
    const ctx = await setup();
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/email-verification/complete',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rate limits completion attempts per IP through the standard envelope', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      emailVerificationRateLimits: {
        windowSeconds: 60,
        requestPerUserMax: 100,
        requestPerIpMax: 100,
        completePerIpMax: 2,
      },
    });

    await completeVerification(ctx, 'wrong-token-1');
    await completeVerification(ctx, 'wrong-token-2');
    const limited = await completeVerification(ctx, 'wrong-token-3');

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('security events', () => {
  it('records sanitized lifecycle events without token material', async () => {
    const ctx = await setup();
    const rawToken = ctx.mailer.lastLinkToken()!;
    await requestVerification(ctx, ctx.accessToken);
    await completeVerification(ctx, rawToken); // stale -> failed event
    await completeVerification(ctx, ctx.mailer.lastLinkToken()!); // succeeds

    const types = ctx.repo.securityEvents.map((event) => event.eventType);
    expect(types).toContain('auth.email_verification_requested');
    expect(types).toContain('auth.email_verification_failed');
    expect(types).toContain('auth.email_verification_succeeded');

    // No event carries the raw token, its hash, or the verification URL.
    const serialized = JSON.stringify(ctx.repo.securityEvents);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(hashEmailVerificationToken(rawToken));
    expect(serialized).not.toContain('/auth/verify-email');
    for (const event of ctx.repo.securityEvents) {
      for (const key of Object.keys(event.metadata)) {
        expect(key.toLowerCase()).not.toMatch(/token|hash|secret/);
      }
    }
  });
});

describe('issuance / delivery consistency (SMTP and DB are not atomic)', () => {
  it('a failed resend preserves the previously delivered usable link', async () => {
    const ctx = await setup();
    const deliveredToken = ctx.mailer.lastLinkToken()!;

    ctx.mailer.failNext = true;
    const failedResend = await requestVerification(ctx, ctx.accessToken);

    // The endpoint fails safely (no misleading success) …
    expect(failedResend.statusCode).toBe(500);
    // … the old generation was never invalidated …
    const usable = ctx.verificationRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(usable).toHaveLength(1);
    // … and the previously delivered link still completes.
    const completion = await completeVerification(ctx, deliveredToken);
    expect(completion.statusCode).toBe(200);
  });

  it('a persistence failure after delivery errors out without stranding the user', async () => {
    const ctx = await setup();
    const deliveredToken = ctx.mailer.lastLinkToken()!;

    // Simulate the non-atomic window: the mailer accepted the replacement but
    // the issue transaction fails.
    const originalIssue = ctx.verificationRepo.issueVerificationToken;
    ctx.verificationRepo.issueVerificationToken = async () => {
      throw new Error('simulated issue-transaction failure');
    };
    const response = await requestVerification(ctx, ctx.accessToken);
    ctx.verificationRepo.issueVerificationToken = originalIssue;

    // No misleading success; the emailed candidate never activates
    // (deterministic: its hash was never stored) …
    expect(response.statusCode).toBe(500);
    const candidateToken = ctx.mailer.lastLinkToken()!;
    expect(candidateToken).not.toBe(deliveredToken);
    const candidate = await completeVerification(ctx, candidateToken);
    expect(candidate.statusCode).toBe(404);
    // … the previous generation remains the only usable one …
    const completion = await completeVerification(ctx, deliveredToken);
    expect(completion.statusCode).toBe(200);
    // … and no raw token or link leaked into recorded events.
    const serialized = JSON.stringify(ctx.repo.securityEvents);
    expect(serialized).not.toContain(deliveredToken);
    expect(serialized).not.toContain(candidateToken);
    expect(serialized).not.toContain('/auth/verify-email');
  });

  it('a successful resend activates the replacement and retires the predecessor', async () => {
    const ctx = await setup();
    const oldToken = ctx.mailer.lastLinkToken()!;

    const resend = await requestVerification(ctx, ctx.accessToken);
    expect(resend.statusCode).toBe(200);
    const newToken = ctx.mailer.lastLinkToken()!;
    expect(newToken).not.toBe(oldToken);

    // At most one usable generation after the operation completes.
    const usable = ctx.verificationRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(usable).toHaveLength(1);

    // The predecessor no longer works; the replacement does.
    expect((await completeVerification(ctx, oldToken)).statusCode).toBe(409);
    expect((await completeVerification(ctx, newToken)).statusCode).toBe(200);
  });
});
