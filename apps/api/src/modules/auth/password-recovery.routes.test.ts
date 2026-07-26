import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import { requireDefined } from '../../lib/invariant';
import { hashPasswordResetToken } from './password-recovery.token';
import {
  buildAuthTestApp,
  type AuthTestContext,
  type BuildAuthTestAppOptions,
} from './testing/build-auth-test-app';
import { registerTestUser } from './testing/register-test-user';

/**
 * End-to-end password-recovery behavior through `app.inject`, backed by the
 * in-memory repositories and the in-memory account mailer. Raw tokens are
 * recovered ONLY from the captured email link — exactly the recipient's
 * channel; the API never returns them. DB-backed persistence and the
 * FOR-UPDATE race are covered in `password-recovery.integration.test.ts`.
 */

const REGISTER_BODY = {
  email: 'recover.me@example.com',
  password: 'original-password-123',
  displayName: 'Recover Me',
};
const NEW_PASSWORD = 'brand-new-password-456';

async function setup(
  options: BuildAuthTestAppOptions = {},
): Promise<AuthTestContext & { accessToken: string; userId: string }> {
  const ctx = await buildAuthTestApp(options);
  const { accessToken, userId } = await registerTestUser(
    ctx.app,
    ctx.mailer,
    REGISTER_BODY,
  );
  return { ...ctx, accessToken, userId };
}

function requestReset(
  ctx: { app: AuthTestContext['app'] },
  email: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/password-recovery/request',
    payload: { email },
  });
}

function completeReset(
  ctx: { app: AuthTestContext['app'] },
  token: string,
  newPassword = NEW_PASSWORD,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/password-recovery/complete',
    payload: { token, newPassword },
  });
}

function login(
  ctx: { app: AuthTestContext['app'] },
  password: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: REGISTER_BODY.email, password },
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

/** Extract the refresh cookie value from a login/refresh response. */
function refreshCookieValue(
  ctx: { config: AuthTestContext['config'] },
  response: LightMyRequestResponse,
): string {
  const name = ctx.config.auth.refreshCookie.name;
  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
  return new RegExp(`${name}=([^;]*)`).exec(raw)?.[1] ?? '';
}

function refresh(
  ctx: { app: AuthTestContext['app']; config: AuthTestContext['config'] },
  cookieToken: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: {
      cookie: `${ctx.config.auth.refreshCookie.name}=${cookieToken}`,
      [ctx.config.auth.csrfHeaderName]: '1',
    },
  });
}

describe('POST /v1/auth/password-recovery/request', () => {
  it('answers an existing account with the generic acceptance and emails a reset link', async () => {
    const ctx = await setup();
    const before = ctx.mailer.messages.length;

    const response = await requestReset(ctx, REGISTER_BODY.email);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
    expect(ctx.mailer.messages).toHaveLength(before + 1);
    const email = ctx.mailer.lastMessage()!;
    expect(email.to).toBe(REGISTER_BODY.email);
    expect(email.subject).toContain('Reset');
    // The link carries the token in the URL FRAGMENT — never a query string,
    // so the token can never reach a web server, proxy log, or Referer.
    expect(email.text).toContain(
      `${ctx.config.web.url}/auth/reset-password#token=`,
    );
    expect(email.text).not.toContain('?token=');
  });

  it('answers an unknown email with the IDENTICAL status and body, sending nothing', async () => {
    const ctx = await setup();
    const before = ctx.mailer.messages.length;

    const known = await requestReset(ctx, REGISTER_BODY.email);
    const unknown = await requestReset(ctx, 'ghost@example.com');

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    // Exactly one email went out (for the real account only)…
    expect(ctx.mailer.messages).toHaveLength(before + 1);
    // …and no token row exists for the unknown address.
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(1);
    expect(ctx.passwordRecoveryRepo.tokens[0]?.userId).toBe(ctx.userId);
  });

  it('answers a disabled account with the same generic acceptance, sending nothing', async () => {
    const ctx = await setup();
    ctx.repo.users.find((u) => u.id === ctx.userId)!.status = 'disabled';
    const before = ctx.mailer.messages.length;

    const response = await requestReset(ctx, REGISTER_BODY.email);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ accepted: true });
    expect(ctx.mailer.messages).toHaveLength(before);
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(0);
  });

  it('answers a soft-deleted account with the same generic acceptance, sending nothing', async () => {
    const ctx = await setup();
    // Soft deletion is a distinct lifecycle state from `disabled`; it must be
    // just as invisible through this endpoint.
    ctx.repo.users.find((u) => u.id === ctx.userId)!.deletedAt = new Date();
    const before = ctx.mailer.messages.length;

    const response = await requestReset(ctx, REGISTER_BODY.email);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ accepted: true });
    expect(ctx.mailer.messages).toHaveLength(before);
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(0);
  });

  it('stores only the token hash — never the raw token', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;

    const record = requireDefined(
      ctx.passwordRecoveryRepo.tokens[0],
      'stored reset token',
    );
    expect(record.tokenHash).toBe(hashPasswordResetToken(rawToken));
    expect(record.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(ctx.passwordRecoveryRepo.tokens)).not.toContain(
      rawToken,
    );
  });

  it('a new request invalidates the previous generation (single usable token)', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const firstToken = ctx.mailer.lastLinkToken()!;
    await requestReset(ctx, REGISTER_BODY.email);

    const usable = ctx.passwordRecoveryRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(2);
    expect(usable).toHaveLength(1);

    const stale = await completeReset(ctx, firstToken);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('PASSWORD_RESET_TOKEN_USED');
  });

  it('swallows a mail delivery failure behind the same generic acceptance', async () => {
    const ctx = await setup();
    const before = ctx.mailer.messages.length;
    ctx.mailer.failNext = true;

    const response = await requestReset(ctx, REGISTER_BODY.email);

    // Same public response as every other outcome — a mail-driver outage must
    // not become an account-existence oracle for the unauthenticated caller.
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ accepted: true });
    expect(ctx.mailer.messages).toHaveLength(before);
    // Persist-and-commit-before-send: the token WAS committed before the
    // failed delivery. It is harmless (unknown to anyone, expiring) and the
    // failure was recorded internally without token or email material.
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(1);
    const event = ctx.repo.securityEvents.find(
      (e) =>
        e.eventType === 'auth.password_reset_requested' &&
        e.metadata.outcome === 'send_failed',
    );
    expect(event).toBeTruthy();
    expect(event!.metadata.delivered).toBe(false);

    // The next successful generation retires the undelivered token.
    const retry = await requestReset(ctx, REGISTER_BODY.email);
    expect(retry.statusCode).toBe(200);
    const usable = ctx.passwordRecoveryRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(2);
    expect(usable).toHaveLength(1);
    // The delivered link matches the usable row (committed-before-send).
    expect(usable[0]?.tokenHash).toBe(
      hashPasswordResetToken(ctx.mailer.lastLinkToken()!),
    );
  });

  it('sends no email when persistence fails, behind the same generic acceptance', async () => {
    const ctx = await setup();
    const before = ctx.mailer.messages.length;
    const originalIssue = ctx.passwordRecoveryRepo.issueResetToken;
    ctx.passwordRecoveryRepo.issueResetToken = async () => {
      throw new Error('simulated issue-transaction failure');
    };

    const response = await requestReset(ctx, REGISTER_BODY.email);
    ctx.passwordRecoveryRepo.issueResetToken = originalIssue;

    // Persist-and-commit BEFORE send: no commit, no email — and the public
    // response is still indistinguishable from success.
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ accepted: true });
    expect(ctx.mailer.messages).toHaveLength(before);
    expect(ctx.passwordRecoveryRepo.tokens).toHaveLength(0);
    const event = ctx.repo.securityEvents.find(
      (e) =>
        e.eventType === 'auth.password_reset_requested' &&
        e.metadata.outcome === 'persist_failed',
    );
    expect(event).toBeTruthy();
  });

  it('never returns the raw token or its hash', async () => {
    const ctx = await setup();
    const response = await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;

    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(hashPasswordResetToken(rawToken));
    expect(serialized).not.toMatch(/token/i);
  });

  it('rejects a malformed email as a validation error', async () => {
    const ctx = await setup();
    const response = await requestReset(ctx, 'not-an-email');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rate limits per IP through the standard envelope', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      passwordRecoveryRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 2,
        requestPerEmailMax: 100,
        completePerIpMax: 100,
        completePerTokenMax: 100,
      },
    });

    expect((await requestReset(ctx, 'a@example.com')).statusCode).toBe(200);
    expect((await requestReset(ctx, 'b@example.com')).statusCode).toBe(200);
    const limited = await requestReset(ctx, 'c@example.com');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('rate limits per normalized email identically for existing and unknown addresses', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      passwordRecoveryRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 100,
        requestPerEmailMax: 1,
        completePerIpMax: 100,
        completePerTokenMax: 100,
      },
    });

    // Unknown email trips its bucket with the SAME shape an existing one would.
    expect((await requestReset(ctx, 'ghost@example.com')).statusCode).toBe(200);
    const unknownLimited = await requestReset(ctx, 'GHOST@example.com');
    expect(unknownLimited.statusCode).toBe(429);

    expect((await requestReset(ctx, REGISTER_BODY.email)).statusCode).toBe(200);
    const knownLimited = await requestReset(ctx, REGISTER_BODY.email);
    expect(knownLimited.statusCode).toBe(429);
    expect(knownLimited.json().error.code).toBe(
      unknownLimited.json().error.code,
    );

    // The rate-limit event records only the bucket name, never the email.
    const events = ctx.repo.securityEvents.filter(
      (e) => e.eventType === 'auth.rate_limit_exceeded',
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).not.toContain('ghost');
  });
});

describe('POST /v1/auth/password-recovery/complete', () => {
  it('resets the password: new password logs in, old password fails', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;

    const response = await completeReset(ctx, rawToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { reset: true } });
    expect(ctx.passwordRecoveryRepo.tokens[0]?.usedAt).toBeInstanceOf(Date);

    expect((await login(ctx, REGISTER_BODY.password)).statusCode).toBe(401);
    expect((await login(ctx, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('does not sign the caller in: no tokens, no session, no cookie', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const sessionsBefore = ctx.repo.sessions.length;

    const response = await completeReset(ctx, ctx.mailer.lastLinkToken()!);

    expect(response.headers['set-cookie']).toBeUndefined();
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toMatch(/accessToken|refresh|session/i);
    expect(ctx.repo.sessions).toHaveLength(sessionsBefore);
  });

  it('revokes every prior session and refresh token (old credentials all die)', async () => {
    const ctx = await setup();
    // A second live session via login (registration completion created the
    // first).
    const secondLogin = await login(ctx, REGISTER_BODY.password);
    const secondAccess = secondLogin.json().data.tokens.accessToken;
    const secondCookie = refreshCookieValue(ctx, secondLogin);

    await requestReset(ctx, REGISTER_BODY.email);
    await completeReset(ctx, ctx.mailer.lastLinkToken()!);

    // Every session row for the user is revoked with the reset reason…
    const userSessions = ctx.repo.sessions.filter(
      (s) => s.userId === ctx.userId,
    );
    expect(userSessions.length).toBeGreaterThanOrEqual(2);
    for (const session of userSessions) {
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(session.revokedReason).toBe('password_reset');
    }
    // …every refresh token too…
    for (const token of ctx.repo.refreshTokens) {
      expect(token.revokedAt).toBeInstanceOf(Date);
    }
    // …old access tokens fail once session validation runs…
    expect((await me(ctx, ctx.accessToken)).statusCode).toBe(401);
    expect((await me(ctx, secondAccess)).statusCode).toBe(401);
    // …and pre-reset refresh cookies cannot mint new access tokens.
    expect((await refresh(ctx, secondCookie)).statusCode).toBe(401);
  });

  it('rejects reuse of a consumed token without touching the password again', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;
    await completeReset(ctx, rawToken);

    const reuse = await completeReset(ctx, rawToken, 'attacker-password-789');

    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('PASSWORD_RESET_TOKEN_USED');
    // The first reset's password still stands.
    expect((await login(ctx, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(ctx, 'attacker-password-789')).statusCode).toBe(401);
  });

  it('permits exactly one success under concurrent completion of the same token', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;

    const [first, second] = await Promise.all([
      completeReset(ctx, rawToken, 'concurrent-password-abc'),
      completeReset(ctx, rawToken, 'concurrent-password-xyz'),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    // Exactly one of the two candidate passwords authenticates.
    const loginA = await login(ctx, 'concurrent-password-abc');
    const loginB = await login(ctx, 'concurrent-password-xyz');
    expect(
      [loginA.statusCode, loginB.statusCode].sort(),
    ).toEqual([200, 401]);
  });

  it('rejects an expired token', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;
    requireDefined(
      ctx.passwordRecoveryRepo.tokens[0],
      'issued reset token',
    ).expiresAt = new Date(Date.now() - 1000);

    const response = await completeReset(ctx, rawToken);

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
    // Nothing changed: the old password still logs in.
    expect((await login(ctx, REGISTER_BODY.password)).statusCode).toBe(200);
  });

  it('rejects an unknown token safely', async () => {
    const ctx = await setup();
    const response = await completeReset(ctx, 'not-a-real-token');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
  });

  it('rejects a token whose account was disabled, indistinguishably from unknown', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;
    ctx.repo.users.find((u) => u.id === ctx.userId)!.status = 'disabled';

    const response = await completeReset(ctx, rawToken);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    expect(ctx.passwordRecoveryRepo.tokens[0]?.usedAt).toBeNull();
  });

  it('validates the new password through the shared registration policy', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);

    const response = await completeReset(
      ctx,
      ctx.mailer.lastLinkToken()!,
      'too-short',
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    // The token survives a validation failure (it was never presented to the
    // domain layer) — the user can retry with a compliant password.
    expect(ctx.passwordRecoveryRepo.tokens[0]?.usedAt).toBeNull();
    const retry = await completeReset(ctx, ctx.mailer.lastLinkToken()!);
    expect(retry.statusCode).toBe(200);
  });

  it('rate limits completion attempts per IP', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      passwordRecoveryRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 100,
        requestPerEmailMax: 100,
        completePerIpMax: 2,
        completePerTokenMax: 100,
      },
    });

    await completeReset(ctx, 'wrong-token-1');
    await completeReset(ctx, 'wrong-token-2');
    const limited = await completeReset(ctx, 'wrong-token-3');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('rate limits repeated attempts against one specific token', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      passwordRecoveryRateLimits: {
        windowSeconds: 60,
        requestPerIpMax: 100,
        requestPerEmailMax: 100,
        completePerIpMax: 100,
        completePerTokenMax: 2,
      },
    });

    await completeReset(ctx, 'guessed-token');
    await completeReset(ctx, 'guessed-token');
    const limited = await completeReset(ctx, 'guessed-token');
    expect(limited.statusCode).toBe(429);
    // A different token is a different bucket.
    const other = await completeReset(ctx, 'other-token');
    expect(other.statusCode).toBe(404);
  });
});

describe('enumeration safety under internal failures', () => {
  /** Make every security-event write fail (the narrowest event seam). */
  function breakEventStore(ctx: AuthTestContext): void {
    ctx.passwordRecoveryRepo.insertSecurityEvent = async () => {
      throw new Error('simulated event-store failure');
    };
  }

  it('returns the identical acceptance for every outcome even when event persistence fails', async () => {
    // Five independent apps, one failure scenario each. All five responses
    // must be byte-identical: any divergence would be an existence oracle.
    const responses: LightMyRequestResponse[] = [];

    // 1. Active account, mail sent, event write fails afterwards.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      const before = ctx.mailer.messages.length;
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
      expect(ctx.mailer.messages).toHaveLength(before + 1);
    }
    // 2. Active account, token persistence fails AND event write fails.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      ctx.passwordRecoveryRepo.issueResetToken = async () => {
        throw new Error('simulated issue-transaction failure');
      };
      const before = ctx.mailer.messages.length;
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
      expect(ctx.mailer.messages).toHaveLength(before);
    }
    // 3. Active account, mail delivery fails AND event write fails.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      ctx.mailer.failNext = true;
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
    }
    // 4. Unknown email, event write fails.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      responses.push(await requestReset(ctx, 'ghost@example.com'));
    }
    // 5. Disabled (non-recoverable) account, event write fails.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      ctx.repo.users.find((u) => u.id === ctx.userId)!.status = 'disabled';
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
    }
    // 6. Soft-deleted account, event write fails (distinct from disabled).
    {
      const ctx = await setup();
      breakEventStore(ctx);
      ctx.repo.users.find((u) => u.id === ctx.userId)!.deletedAt = new Date();
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
    }
    // 7. Account lookup itself throws (e.g. database outage).
    {
      const ctx = await setup();
      ctx.passwordRecoveryRepo.findUserByNormalizedEmail = async () => {
        throw new Error('simulated lookup failure');
      };
      const before = ctx.mailer.messages.length;
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
      expect(ctx.mailer.messages).toHaveLength(before);
    }
    // 8. Account lookup throws AND event write fails.
    {
      const ctx = await setup();
      breakEventStore(ctx);
      ctx.passwordRecoveryRepo.findUserByNormalizedEmail = async () => {
        throw new Error('simulated lookup failure');
      };
      responses.push(await requestReset(ctx, REGISTER_BODY.email));
    }

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, data: { accepted: true } });
      // No account-existence hint, credential material, or DB error detail.
      expect(response.body).not.toMatch(/token|password|email|database|lookup/i);
    }
  });
});

describe('security events and secret hygiene', () => {
  it('attributes every request event anonymously — the public caller is never a user', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email); // sent
    await requestReset(ctx, 'ghost@example.com'); // unknown_email
    ctx.mailer.failNext = true;
    await requestReset(ctx, REGISTER_BODY.email); // send_failed
    const originalLookup = ctx.passwordRecoveryRepo.findUserByNormalizedEmail;
    ctx.passwordRecoveryRepo.findUserByNormalizedEmail = async () => {
      throw new Error('simulated lookup failure');
    };
    await requestReset(ctx, REGISTER_BODY.email); // lookup_failed
    ctx.passwordRecoveryRepo.findUserByNormalizedEmail = originalLookup;
    ctx.repo.users.find((u) => u.id === ctx.userId)!.status = 'disabled';
    await requestReset(ctx, REGISTER_BODY.email); // inactive_account

    const requested = ctx.repo.securityEvents.filter(
      (e) => e.eventType === 'auth.password_reset_requested',
    );
    const outcomes = requested.map((e) => e.metadata.outcome).sort();
    expect(outcomes).toEqual([
      'inactive_account',
      'lookup_failed',
      'send_failed',
      'sent',
      'unknown_email',
    ]);
    // Submitting an email authenticates nobody: no user id, session, or
    // 'user' actor on ANY request event, resolved account or not.
    for (const event of requested) {
      expect(event.userId).toBeNull();
      expect(event.sessionId).toBeNull();
      expect(event.actorType).toBe('anonymous');
    }
  });

  it('attributes completion events by token proof: success to the user, rejection to nobody', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    await completeReset(ctx, 'bogus-token'); // rejected
    await completeReset(ctx, ctx.mailer.lastLinkToken()!); // completed

    // A successful completion proved possession of a single-use,
    // account-bound credential (same basis as verification completion).
    const completed = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.password_reset_completed',
    )!;
    expect(completed.userId).toBe(ctx.userId);
    expect(completed.actorType).toBe('user');

    // A rejected token proved nothing — no token-derived account reference.
    const rejected = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.password_reset_rejected',
    )!;
    expect(rejected.userId).toBeNull();
    expect(rejected.actorType).toBe('anonymous');
  });

  it('records sanitized lifecycle events without passwords, tokens, links, or emails', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email); // requested (known)
    await requestReset(ctx, 'ghost@example.com'); // requested (unknown)
    const rawToken = ctx.mailer.lastLinkToken()!;
    await completeReset(ctx, 'bogus-token'); // rejected
    await completeReset(ctx, rawToken); // completed

    const types = ctx.repo.securityEvents.map((event) => event.eventType);
    expect(types).toContain('auth.password_reset_requested');
    expect(types).toContain('auth.password_reset_rejected');
    expect(types).toContain('auth.password_reset_completed');

    const serialized = JSON.stringify(ctx.repo.securityEvents);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(hashPasswordResetToken(rawToken));
    expect(serialized).not.toContain('/auth/reset-password');
    expect(serialized).not.toContain(REGISTER_BODY.password);
    expect(serialized).not.toContain(NEW_PASSWORD);
    // Metadata never carries the submitted email (known or unknown): account
    // references are user ids after resolution, plus coarse outcome codes.
    const metadataOnly = JSON.stringify(
      ctx.repo.securityEvents.map((event) => event.metadata),
    );
    expect(metadataOnly).not.toContain('recover.me');
    expect(metadataOnly).not.toContain('ghost');
    expect(metadataOnly).not.toContain('example.com');
    for (const event of ctx.repo.securityEvents) {
      for (const key of Object.keys(event.metadata)) {
        expect(key.toLowerCase()).not.toMatch(/token|hash|secret|password$/);
      }
    }
  });

  it('persists no password material and no raw token anywhere in the stores', async () => {
    const ctx = await setup();
    await requestReset(ctx, REGISTER_BODY.email);
    const rawToken = ctx.mailer.lastLinkToken()!;
    await completeReset(ctx, rawToken);

    const stores = JSON.stringify({
      users: ctx.repo.users,
      sessions: ctx.repo.sessions,
      refreshTokens: ctx.repo.refreshTokens,
      resetTokens: ctx.passwordRecoveryRepo.tokens,
    });
    expect(stores).not.toContain(rawToken);
    expect(stores).not.toContain(REGISTER_BODY.password);
    expect(stores).not.toContain(NEW_PASSWORD);
  });
});
