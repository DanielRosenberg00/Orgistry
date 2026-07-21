import { describe, expect, it } from 'vitest';
import { createInMemoryRateLimiter, createUnavailableRateLimiter } from '../lib/rate-limit';
import { buildTestApp, testConfig } from '../testing/build-test-app';

/**
 * Global per-IP API rate limit (Sprint 19, ORG-PR-012).
 *
 * Deterministic thresholds are injected via config (RATE_LIMIT_MAX /
 * RATE_LIMIT_WINDOW_SECONDS) with an in-memory limiter — production values are
 * never lowered; tests set their own.
 */

function limitedApp(max: number) {
  const app = buildTestApp(undefined, {
    config: testConfig({ RATE_LIMIT_MAX: String(max) }),
    globalRateLimiter: createInMemoryRateLimiter(),
  });
  app.get('/probe', async () => ({ ok: true }));
  return app;
}

describe('global rate limit', () => {
  it('allows up to the limit, then returns the standard RATE_LIMITED envelope', async () => {
    const app = limitedApp(2);

    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(200);

    const third = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'req_global_limit_probe' },
    });
    expect(third.statusCode).toBe(429);
    const body = third.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    // Sanitized request id present; no limiter internals in the payload.
    expect(body.error.requestId).toBe('req_global_limit_probe');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('rl:global');
    expect(serialized.toLowerCase()).not.toContain('redis');
    await app.close();
  });

  it('tracks distinct client IPs independently', async () => {
    const app = limitedApp(1);

    const first = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '203.0.113.1',
    });
    const otherIp = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '203.0.113.2',
    });
    const overLimit = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '203.0.113.1',
    });

    expect(first.statusCode).toBe(200);
    expect(otherIp.statusCode).toBe(200);
    expect(overLimit.statusCode).toBe(429);
    await app.close();
  });

  it('exempts /health and /ready from the global bucket', async () => {
    const app = limitedApp(1);

    // Exhaust the bucket for this IP.
    await app.inject({ method: 'GET', url: '/probe' });
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(429);

    // Probes stay reachable.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('exempts OPTIONS so CORS preflight is never limited', async () => {
    const app = limitedApp(1);
    await app.ready();

    await app.inject({ method: 'GET', url: '/probe' });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(preflight.statusCode).toBeLessThan(300);
    await app.close();
  });

  it('fails OPEN when the limiter store is unavailable (documented global policy)', async () => {
    const app = buildTestApp(undefined, {
      config: testConfig({ RATE_LIMIT_MAX: '1' }),
      globalRateLimiter: createUnavailableRateLimiter(),
    });
    app.get('/probe', async () => ({ ok: true }));

    // Every request passes: the global bucket never fails closed.
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(200);
    }
    await app.close();
  });
});
