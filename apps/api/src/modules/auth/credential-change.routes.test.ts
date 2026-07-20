import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import {
  buildAuthTestApp,
  type AuthTestContext,
  type BuildAuthTestAppOptions,
} from './testing/build-auth-test-app';

/**
 * Authenticated credential mutations (Sprint 17): password change, email
 * change, and the registration duplicate-email behavior, exercised through
 * `app.inject` over the in-memory repositories. DB-backed persistence is
 * covered in `password-recovery.integration.test.ts`.
 */

const REGISTER_BODY = {
  email: 'change.me@example.com',
  password: 'original-password-123',
  displayName: 'Change Me',
};
const NEW_PASSWORD = 'rotated-password-456';

const HUGE = Number.MAX_SAFE_INTEGER;

/** All auth buckets effectively unlimited except the overrides. */
function authLimits(
  overrides: Partial<
    import('./auth.service').AuthRateLimits
  > = {},
): import('./auth.service').AuthRateLimits {
  return {
    windowSeconds: 60,
    loginPerIpMax: HUGE,
    loginPerEmailMax: HUGE,
    registerPerIpMax: HUGE,
    registerPerEmailMax: HUGE,
    refreshPerSessionMax: HUGE,
    refreshPerIpMax: HUGE,
    changePasswordPerUserMax: HUGE,
    changeEmailPerUserMax: HUGE,
    ...overrides,
  };
}

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

function changePassword(
  ctx: { app: AuthTestContext['app'] },
  accessToken: string | null,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/change-password',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    payload,
  });
}

function changeEmail(
  ctx: { app: AuthTestContext['app'] },
  accessToken: string | null,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/change-email',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    payload,
  });
}

function login(
  ctx: { app: AuthTestContext['app'] },
  email: string,
  password: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
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

describe('POST /v1/auth/change-password', () => {
  it('requires authentication', async () => {
    const ctx = await setup();
    const response = await changePassword(ctx, null, {
      currentPassword: REGISTER_BODY.password,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires the current password field', async () => {
    const ctx = await setup();
    const response = await changePassword(ctx, ctx.accessToken, {
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an incorrect current password with 400 (not 401) and changes nothing', async () => {
    const ctx = await setup();
    const response = await changePassword(ctx, ctx.accessToken, {
      currentPassword: 'wrong-password-000',
      newPassword: NEW_PASSWORD,
    });

    // 400, deliberately NOT 401: the session is valid — a 401 would make
    // clients treat a typo as an expired session.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(
      (await login(ctx, REGISTER_BODY.email, REGISTER_BODY.password)).statusCode,
    ).toBe(200);
  });

  it('validates the new password through the shared registration policy', async () => {
    const ctx = await setup();
    const response = await changePassword(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newPassword: 'too-short',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects reusing the current password as the new password', async () => {
    const ctx = await setup();
    const response = await changePassword(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newPassword: REGISTER_BODY.password,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('changes the password: hash rotates, old fails, new authenticates', async () => {
    const ctx = await setup();
    const hashBefore = ctx.repo.users[0].passwordHash;

    const response = await changePassword(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { success: true } });
    expect(ctx.repo.users[0].passwordHash).not.toBe(hashBefore);
    expect(ctx.repo.users[0].passwordHash).not.toContain(NEW_PASSWORD);
    expect(
      (await login(ctx, REGISTER_BODY.email, REGISTER_BODY.password)).statusCode,
    ).toBe(401);
    expect(
      (await login(ctx, REGISTER_BODY.email, NEW_PASSWORD)).statusCode,
    ).toBe(200);
  });

  it('keeps the current session working and revokes every other session', async () => {
    const ctx = await setup();
    const otherLogin = await login(
      ctx,
      REGISTER_BODY.email,
      REGISTER_BODY.password,
    );
    const otherAccess = otherLogin.json().data.tokens.accessToken;
    const otherCookie = refreshCookieValue(ctx, otherLogin);

    const response = await changePassword(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    // The caller's session survives…
    expect((await me(ctx, ctx.accessToken)).statusCode).toBe(200);
    // …the other session's access token dies at session revalidation…
    expect((await me(ctx, otherAccess)).statusCode).toBe(401);
    // …and its refresh cookie cannot mint new access tokens.
    expect((await refresh(ctx, otherCookie)).statusCode).toBe(401);

    const revoked = ctx.repo.sessions.filter(
      (s) => s.revokedReason === 'password_changed',
    );
    expect(revoked).toHaveLength(1);
  });

  it('records a sanitized security event without password material', async () => {
    const ctx = await setup();
    await changePassword(ctx, ctx.accessToken, {
      currentPassword: 'wrong-password-000',
      newPassword: NEW_PASSWORD,
    });
    await changePassword(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newPassword: NEW_PASSWORD,
    });

    const types = ctx.repo.securityEvents.map((e) => e.eventType);
    expect(types).toContain('auth.password_change_rejected');
    expect(types).toContain('auth.password_changed');
    const serialized = JSON.stringify(ctx.repo.securityEvents);
    expect(serialized).not.toContain(REGISTER_BODY.password);
    expect(serialized).not.toContain(NEW_PASSWORD);
  });

  it('rate limits per user through the standard envelope', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: authLimits({ changePasswordPerUserMax: 2 }),
    });

    const attempt = () =>
      changePassword(ctx, ctx.accessToken, {
        currentPassword: 'wrong-password-000',
        newPassword: NEW_PASSWORD,
      });
    await attempt();
    await attempt();
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /v1/auth/change-email', () => {
  const NEW_EMAIL = 'New.Address@Example.com';
  const NEW_EMAIL_NORMALIZED = 'new.address@example.com';

  it('requires authentication', async () => {
    const ctx = await setup();
    const response = await changeEmail(ctx, null, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an incorrect current password and changes nothing', async () => {
    const ctx = await setup();
    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: 'wrong-password-000',
      newEmail: NEW_EMAIL,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(ctx.repo.users[0].email).toBe(REGISTER_BODY.email);
  });

  it('rejects an invalid email as a validation error', async () => {
    const ctx = await setup();
    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: 'not-an-email',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects the current email (normalized) as a no-op', async () => {
    const ctx = await setup();
    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: REGISTER_BODY.email.toUpperCase(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate normalized email with the registration conflict', async () => {
    const ctx = await setup();
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        ...REGISTER_BODY,
        email: NEW_EMAIL_NORMALIZED,
        displayName: 'Occupant',
      },
    });

    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(ctx.repo.users[0].email).toBe(REGISTER_BODY.email);
  });

  it('changes the email, clears verification, and reissues a verification generation', async () => {
    const ctx = await setup();
    // Verify the ORIGINAL address first so the clearing is observable.
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/email-verification/complete',
      payload: { token: ctx.mailer.lastLinkToken()! },
    });
    expect(ctx.repo.users[0].emailVerifiedAt).toBeInstanceOf(Date);
    const mailsBefore = ctx.mailer.messages.length;

    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });

    expect(response.statusCode).toBe(200);
    const returnedUser = response.json().data.user;
    expect(returnedUser.email).toBe(NEW_EMAIL);
    expect(returnedUser.emailVerified).toBe(false);

    const user = ctx.repo.users[0];
    expect(user.email).toBe(NEW_EMAIL);
    expect(user.normalizedEmail).toBe(NEW_EMAIL_NORMALIZED);
    expect(user.emailVerifiedAt).toBeNull();

    // A fresh verification email went to the NEW address only.
    expect(ctx.mailer.messages).toHaveLength(mailsBefore + 1);
    expect(ctx.mailer.lastMessage()!.to).toBe(NEW_EMAIL);

    // Exactly one usable verification token afterwards; it verifies the new
    // address.
    const usable = ctx.verificationRepo.tokens.filter(
      (t) => t.usedAt === null && t.invalidatedAt === null,
    );
    expect(usable).toHaveLength(1);
    const complete = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/email-verification/complete',
      payload: { token: ctx.mailer.lastLinkToken()! },
    });
    expect(complete.statusCode).toBe(200);
    expect(ctx.repo.users[0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('invalidates outstanding old-address verification tokens even when the new email fails to send', async () => {
    const ctx = await setup();
    const oldVerificationToken = ctx.mailer.lastLinkToken()!;
    ctx.mailer.failNext = true;

    const response = await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });

    // The committed change wins; the send failure is recorded, not surfaced.
    expect(response.statusCode).toBe(200);
    expect(ctx.repo.users[0].email).toBe(NEW_EMAIL);

    // The old address's token can no longer verify anything.
    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/email-verification/complete',
      payload: { token: oldVerificationToken },
    });
    expect(stale.statusCode).toBe(409);
    expect(ctx.repo.users[0].emailVerifiedAt).toBeNull();

    // The account stays usable (advisory verification) and can resend.
    expect((await me(ctx, ctx.accessToken)).statusCode).toBe(200);
    const resend = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/email-verification/request',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(resend.statusCode).toBe(200);
    expect(ctx.mailer.lastMessage()!.to).toBe(NEW_EMAIL);
  });

  it('keeps the session usable and current-user resolution consistent after the change', async () => {
    const ctx = await setup();
    await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });

    const meResponse = await me(ctx, ctx.accessToken);
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().data.user.email).toBe(NEW_EMAIL);
    expect(meResponse.json().data.user.emailVerified).toBe(false);

    // Login works with the NEW email and the unchanged password.
    expect(
      (await login(ctx, NEW_EMAIL, REGISTER_BODY.password)).statusCode,
    ).toBe(200);
    expect(
      (await login(ctx, REGISTER_BODY.email, REGISTER_BODY.password)).statusCode,
    ).toBe(401);
  });

  it('records sanitized security events for change and rejection', async () => {
    const ctx = await setup();
    await changeEmail(ctx, ctx.accessToken, {
      currentPassword: 'wrong-password-000',
      newEmail: NEW_EMAIL,
    });
    await changeEmail(ctx, ctx.accessToken, {
      currentPassword: REGISTER_BODY.password,
      newEmail: NEW_EMAIL,
    });

    const types = ctx.repo.securityEvents.map((e) => e.eventType);
    expect(types).toContain('auth.email_change_rejected');
    expect(types).toContain('auth.email_changed');
    const serialized = JSON.stringify(ctx.repo.securityEvents);
    expect(serialized).not.toContain(REGISTER_BODY.password);
  });

  it('rate limits per user through the standard envelope', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: authLimits({ changeEmailPerUserMax: 2 }),
    });

    const attempt = () =>
      changeEmail(ctx, ctx.accessToken, {
        currentPassword: 'wrong-password-000',
        newEmail: NEW_EMAIL,
      });
    await attempt();
    await attempt();
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('registration duplicate-email behavior (de-enumeration posture)', () => {
  it('registers a new email normally', async () => {
    const ctx = await buildAuthTestApp();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: REGISTER_BODY,
    });
    expect(response.statusCode).toBe(201);
  });

  it('returns the documented 409 conflict for an existing normalized email and records the probe', async () => {
    const ctx = await setup();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...REGISTER_BODY, email: `  ${REGISTER_BODY.email.toUpperCase()} ` },
    });

    // The residual disclosure is deliberate and documented (see
    // docs/credential-management.md): registration returns a live session, so
    // a duplicate cannot be faked as success without fabricating credentials.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    // No account was touched, no session issued.
    expect(ctx.repo.users).toHaveLength(1);
    expect(response.headers['set-cookie']).toBeUndefined();

    // The probe is durably recorded — but the caller is UNAUTHENTICATED, so
    // it must never read as an action by (or a reference to) the existing
    // account: anonymous actor, null user id, coarse reason only.
    const probe = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.registration_duplicate_email',
    );
    expect(probe).toBeTruthy();
    expect(probe!.userId).toBeNull();
    expect(probe!.actorType).toBe('anonymous');
    expect(probe!.metadata).toEqual({ reason: 'duplicate_email' });
    // No email, email fragment, or digest of it anywhere on the event.
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain(REGISTER_BODY.email);
    expect(serialized).not.toContain(REGISTER_BODY.email.toLowerCase());
    expect(serialized).not.toContain('change.me');
    expect(serialized).not.toContain(REGISTER_BODY.password);
  });

  it('rate limits repeated probing of one email regardless of IP bucket headroom', async () => {
    const ctx = await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: authLimits({ registerPerEmailMax: 2 }),
    });

    const probe = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { ...REGISTER_BODY, displayName: 'Prober' },
      });
    // The setup registration consumed one slot; one probe sees the conflict,
    // then the per-email bucket closes even though the IP bucket has headroom.
    expect((await probe()).statusCode).toBe(409);
    const limited = await probe();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('counts the per-email bucket identically for unknown emails (no oracle)', async () => {
    const ctx = await buildAuthTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: authLimits({ registerPerEmailMax: 1 }),
    });

    // The first registration consumes the only slot for this address; a
    // second attempt is limited BEFORE the duplicate conflict is reached —
    // same shape as for a never-registered address.
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: REGISTER_BODY,
        })
      ).statusCode,
    ).toBe(201);
    const limited = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: REGISTER_BODY,
    });
    expect(limited.statusCode).toBe(429);
  });
});
