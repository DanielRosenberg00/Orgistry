import { signAccessToken } from '@orgistry/auth-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { requireDefined } from '../../lib/invariant';
import {
  buildAuthTestApp,
  type AuthTestContext,
} from './testing/build-auth-test-app';
import { registerTestUser } from './testing/register-test-user';

/**
 * End-to-end auth route behavior exercised through `app.inject`, backed by the
 * in-memory repositories. This validates the full HTTP path — validation,
 * service workflow, envelopes, error mapping, and security-event writing —
 * without requiring PostgreSQL. DB-backed persistence is covered separately in
 * the integration suite. Registration itself (verification-first, Sprint 18)
 * is covered in `registration.routes.test.ts`; here users are created through
 * the shared two-step helper.
 */

const VALID_ACCOUNT = {
  email: 'New.User@Example.com',
  password: 'a-strong-password-123',
  displayName: 'New User',
};

let ctx: AuthTestContext;

beforeEach(async () => {
  ctx = await buildAuthTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

function login(
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
}

describe('POST /v1/auth/login', () => {
  beforeEach(async () => {
    await registerTestUser(ctx.app, ctx.mailer, VALID_ACCOUNT);
  });

  it('logs in with correct credentials (case-insensitive email)', async () => {
    const response = await login({
      email: 'new.user@example.com',
      password: VALID_ACCOUNT.password,
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.user.email).toBe('New.User@Example.com');
    expect(body.data.tokens.accessToken).toBeTypeOf('string');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(
      ctx.repo.securityEvents.some((e) => e.eventType === 'auth.login_succeeded'),
    ).toBe(true);
  });

  it('returns an identical generic error for wrong password and unknown email', async () => {
    const wrongPassword = await login({
      email: 'new.user@example.com',
      password: 'definitely-wrong-password',
    });
    const unknownEmail = await login({
      email: 'nobody@example.com',
      password: 'definitely-wrong-password',
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);

    const a = wrongPassword.json().error;
    const b = unknownEmail.json().error;
    expect(a.code).toBe('INVALID_CREDENTIALS');
    // Identical public behavior: same code and message (ignore the per-request id).
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('writes a login_failed security event for a failed attempt', async () => {
    await login({ email: 'newuser@example.com', password: 'wrong-password!' });
    expect(
      ctx.repo.securityEvents.some((e) => e.eventType === 'auth.login_failed'),
    ).toBe(true);
  });
});

describe('GET /v1/auth/me', () => {
  async function authedToken(): Promise<string> {
    const { accessToken } = await registerTestUser(
      ctx.app,
      ctx.mailer,
      VALID_ACCOUNT,
    );
    return accessToken;
  }

  it('resolves the authenticated user for a valid token', async () => {
    const token = await authedToken();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.user.email).toBe('New.User@Example.com');
    // Verification-first: an account created through registration completion
    // has already proven its mailbox.
    expect(body.data.user.emailVerified).toBe(true);
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a missing token', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired token with a standard envelope and no leaked state', async () => {
    const expired = await signAccessToken({
      userId: 'user_whatever',
      sessionId: 'sess_whatever',
      secret: ctx.config.auth.jwtSecret,
      ttlSeconds: -10,
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${expired}`,
        'x-request-id': 'req_expired_case',
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.requestId).toBe('req_expired_case');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain(expired); // raw token is never echoed back
    expect(body).not.toHaveProperty('data');
  });

  it('rejects a token whose session is missing', async () => {
    await registerTestUser(ctx.app, ctx.mailer, VALID_ACCOUNT);
    const token = await signAccessToken({
      userId: requireDefined(ctx.repo.users[0], 'registered user').id,
      sessionId: 'sess_does_not_exist',
      secret: ctx.config.auth.jwtSecret,
      ttlSeconds: 900,
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token whose session was revoked', async () => {
    const token = await authedToken();
    requireDefined(ctx.repo.sessions[0], 'active session').revokedAt =
      new Date();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token whose session has expired', async () => {
    const token = await authedToken();
    requireDefined(ctx.repo.sessions[0], 'active session').expiresAt = new Date(
      Date.now() - 1000,
    );
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a token whose sessionId belongs to a different user", async () => {
    await registerTestUser(ctx.app, ctx.mailer, VALID_ACCOUNT); // user A
    await registerTestUser(ctx.app, ctx.mailer, {
      ...VALID_ACCOUNT,
      email: 'other.person@example.com',
    }); // user B

    // Token for user A but pointing at user B's session.
    const crossToken = await signAccessToken({
      userId: requireDefined(ctx.repo.users[0], 'user A').id,
      sessionId: requireDefined(ctx.repo.sessions[1], "user B's session").id,
      secret: ctx.config.auth.jwtSecret,
      ttlSeconds: 900,
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${crossToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('writes a sanitized access_token_rejected event for an invalid token', async () => {
    await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: 'Bearer not.a.valid.jwt',
        'x-request-id': 'req_reject_case',
      },
    });

    const event = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.access_token_rejected',
    );
    expect(event).toBeDefined();
    // Nothing about the caller can be trusted from an unverifiable token.
    expect(event?.userId).toBeNull();
    expect(event?.sessionId).toBeNull();
    expect(event?.requestId).toBe('req_reject_case');
    // Metadata is sanitized and carries no token/credential material.
    const metadata = JSON.stringify(event?.metadata ?? {});
    expect(metadata).not.toContain('not.a.valid.jwt');
    expect(metadata).not.toContain('Bearer');
    expect(metadata).not.toMatch(/password|cookie|authorization/i);
  });

  it('does not write a security event for a missing token (intentional)', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(
      ctx.repo.securityEvents.some(
        (e) => e.eventType === 'auth.access_token_rejected',
      ),
    ).toBe(false);
  });
});
