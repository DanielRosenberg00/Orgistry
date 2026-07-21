import { afterEach, describe, expect, it } from 'vitest';
import {
  createUnavailableRateLimiter,
  createNoopRateLimiter,
} from '../../lib/rate-limit';
import {
  buildAuthTestApp,
  type AuthTestContext,
} from './testing/build-auth-test-app';

/**
 * Redis failure policy on the sensitive auth surfaces (Sprint 19,
 * ORG-PR-009).
 *
 * With the limiter store unavailable:
 *  - `closed` (the production posture): credential and token-completion
 *    endpoints reject with a generic 503 — abuse controls never silently
 *    disappear. The envelope carries the request id and no store internals.
 *  - `open` (the documented development/test posture): requests proceed.
 */

let ctx: AuthTestContext | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const REGISTER_PAYLOAD = {
  email: 'outage.probe@example.com',
  password: 'a-strong-password-123',
  displayName: 'Outage Probe',
};

describe('sensitive endpoints with the limiter store down', () => {
  it.each([
    ['registration request', 'POST', '/v1/auth/register', REGISTER_PAYLOAD],
    [
      'registration completion',
      'POST',
      '/v1/auth/registration/complete',
      { token: 'any-token-value' },
    ],
    ['login', 'POST', '/v1/auth/login', {
      email: 'outage.probe@example.com',
      password: 'a-strong-password-123',
    }],
    [
      'password-recovery request',
      'POST',
      '/v1/auth/password-recovery/request',
      { email: 'outage.probe@example.com' },
    ],
    [
      'password-recovery completion',
      'POST',
      '/v1/auth/password-recovery/complete',
      { token: 'any-token-value', newPassword: 'another-strong-password-123' },
    ],
  ])(
    'fails CLOSED for %s with a generic 503 and the request id',
    async (_label, method, url, payload) => {
      ctx = await buildAuthTestApp({
        rateLimiter: createUnavailableRateLimiter(),
        rateLimitFailureMode: 'closed',
      });

      const response = await ctx.app.inject({
        method: method as 'POST',
        url,
        payload,
        headers: { 'x-request-id': 'req_outage_probe' },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.requestId).toBe('req_outage_probe');
      // No store internals in the public envelope.
      const serialized = response.body.toLowerCase();
      expect(serialized).not.toContain('redis');
      expect(serialized).not.toContain('econnrefused');
      expect(serialized).not.toContain('stack');
    },
  );

  it('fails OPEN in the documented development/test mode (registration proceeds)', async () => {
    ctx = await buildAuthTestApp({
      rateLimiter: createUnavailableRateLimiter(),
      rateLimitFailureMode: 'open',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    // The enumeration-safe registration response, unchanged.
    expect(response.statusCode).toBe(200);
  });

  it('never rejects when the store is healthy, whatever the failure mode', async () => {
    ctx = await buildAuthTestApp({
      rateLimiter: createNoopRateLimiter(),
      rateLimitFailureMode: 'closed',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });
    expect(response.statusCode).toBe(200);
  });
});
