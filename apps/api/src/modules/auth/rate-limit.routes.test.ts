import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import { type AuthRateLimits } from './auth.service';
import {
  type AuthTestContext,
  buildAuthTestApp,
} from './testing/build-auth-test-app';

/**
 * Redis-backed auth rate limiting, exercised at the HTTP layer with an
 * in-memory limiter standing in for Redis (the limiter contract is identical;
 * the Redis implementation is unit-tested separately). Each case tunes one
 * bucket low and leaves the rest effectively unlimited so the trigger is
 * unambiguous.
 */

const HUGE = Number.MAX_SAFE_INTEGER;

const CREDENTIALS = {
  email: 'Rate.User@Example.com',
  password: 'a-strong-password-123',
  displayName: 'Rate User',
};

let ctx: AuthTestContext;

function build(overrides: Partial<AuthRateLimits>): Promise<AuthTestContext> {
  const limits: AuthRateLimits = {
    windowSeconds: 60,
    loginPerIpMax: HUGE,
    loginPerEmailMax: HUGE,
    registerPerIpMax: HUGE,
    refreshPerSessionMax: HUGE,
    refreshPerIpMax: HUGE,
    ...overrides,
  };
  return buildAuthTestApp({
    rateLimiter: createInMemoryRateLimiter(),
    rateLimits: limits,
  });
}

afterEach(async () => {
  await ctx?.app.close();
});

function expectRateLimited(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(429);
  const body = response.json();
  expect(body.error.code).toBe('RATE_LIMITED');
  expect(body.error.requestId).toMatch(/^req_/);
}

function register(app: FastifyInstance, email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { ...CREDENTIALS, email },
  });
}

function login(app: FastifyInstance, email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: CREDENTIALS.password },
  });
}

describe('register per IP', () => {
  it('limits repeated registrations from one IP', async () => {
    ctx = await build({ registerPerIpMax: 2 });
    expect((await register(ctx.app, 'a@example.com')).statusCode).toBe(201);
    expect((await register(ctx.app, 'b@example.com')).statusCode).toBe(201);
    expectRateLimited(await register(ctx.app, 'c@example.com'));
  });
});

describe('login per IP', () => {
  it('limits repeated logins from one IP', async () => {
    ctx = await build({ loginPerIpMax: 2 });
    await register(ctx.app, CREDENTIALS.email);
    // Wrong password still counts against the IP bucket.
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: 'wrong-password!!' },
    });
    await login(ctx.app, CREDENTIALS.email);
    expectRateLimited(await login(ctx.app, CREDENTIALS.email));
  });
});

describe('login per normalized email', () => {
  it('limits repeated logins for one email and does not leak existence', async () => {
    ctx = await build({ loginPerEmailMax: 1 });
    // Unknown email: first attempt is a generic 401, second trips the bucket
    // with the SAME RATE_LIMITED shape an existing email would produce.
    const first = await login(ctx.app, 'ghost@example.com');
    expect(first.statusCode).toBe(401);
    expect(first.json().error.code).toBe('INVALID_CREDENTIALS');
    expectRateLimited(await login(ctx.app, 'ghost@example.com'));

    // The rate-limit event records only the bucket name, never the email.
    const event = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.rate_limit_exceeded',
    );
    expect(event?.metadata).toEqual({ bucket: 'login_per_email' });
    expect(JSON.stringify(event?.metadata)).not.toContain('ghost');
  });
});

describe('refresh per IP', () => {
  it('limits refresh attempts from one IP regardless of token validity', async () => {
    ctx = await build({ refreshPerIpMax: 2 });
    const csrf = ctx.config.auth.csrfHeaderName;
    const cookie = `${ctx.config.auth.refreshCookie.name}=bogus-token`;
    const attempt = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie, [csrf]: '1' },
      });

    expect((await attempt()).statusCode).toBe(401); // invalid token
    expect((await attempt()).statusCode).toBe(401);
    expectRateLimited(await attempt()); // IP bucket exhausted
  });
});

describe('refresh per session', () => {
  it('limits refreshes for a single session', async () => {
    ctx = await build({ refreshPerSessionMax: 2 });
    const csrf = ctx.config.auth.csrfHeaderName;
    const name = ctx.config.auth.refreshCookie.name;

    const reg = await register(ctx.app, CREDENTIALS.email);
    const cookieValue = (res: LightMyRequestResponse) => {
      const header = res.headers['set-cookie'];
      const raw = Array.isArray(header) ? header[0] : (header ?? '');
      return new RegExp(`${name}=([^;]*)`).exec(raw)?.[1] ?? '';
    };
    const refresh = (token: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: `${name}=${token}`, [csrf]: '1' },
      });

    const r1 = await refresh(cookieValue(reg));
    expect(r1.statusCode).toBe(200);
    const r2 = await refresh(cookieValue(r1));
    expect(r2.statusCode).toBe(200);
    // Third refresh on the same session is rate limited before rotation.
    expectRateLimited(await refresh(cookieValue(r2)));
  });
});
