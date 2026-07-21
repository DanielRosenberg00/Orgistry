import { describe, expect, it } from 'vitest';
import { createNoopRateLimiter } from '../lib/rate-limit';
import {
  buildTestApp,
  failingProbe,
  productionLikeTestConfig,
  testConfig,
} from '../testing/build-test-app';

/**
 * HTTP security headers (Sprint 19, ORG-PR-011).
 *
 * One onSend hook applies the policy to EVERY response: success, error
 * envelope, 404, and CORS preflight. HSTS requires BOTH production mode and a
 * proxy-aware HTTPS request protocol; sensitive auth and invitation paths
 * additionally get `Cache-Control: no-store`.
 */

const BASELINE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

describe('security headers', () => {
  it('applies the baseline header set to normal API responses', async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
    await app.close();
  });

  it('applies the same headers to error responses (404 envelope)', async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
    await app.close();
  });

  it('applies the same headers to 503 readiness failures', async () => {
    const app = buildTestApp([failingProbe('redis')]);
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('emits HSTS in production for an HTTPS request resolved through the trusted proxy', async () => {
    const app = buildTestApp(undefined, {
      config: productionLikeTestConfig({
        HSTS_MAX_AGE_SECONDS: '31536000',
        TRUST_PROXY: '1',
      }),
      globalRateLimiter: createNoopRateLimiter(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    await app.close();
  });

  it('does NOT emit HSTS in production for a plain-HTTP request', async () => {
    const app = buildTestApp(undefined, {
      config: productionLikeTestConfig({ TRUST_PROXY: '1' }),
      globalRateLimiter: createNoopRateLimiter(),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['strict-transport-security']).toBeUndefined();
    // The rest of the policy is protocol-independent.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('ignores a forged X-Forwarded-Proto when proxy trust is disabled (production)', async () => {
    // Default production config: TRUST_PROXY=false — the forwarded protocol
    // claim comes from an untrusted direct client and must not mint HSTS.
    const app = buildTestApp(undefined, {
      config: productionLikeTestConfig(),
      globalRateLimiter: createNoopRateLimiter(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });

  it('does NOT emit HSTS outside production, even for an HTTPS-shaped request', async () => {
    const app = buildTestApp(undefined, {
      config: testConfig({ TRUST_PROXY: '1' }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    await app.close();
  });

  it('marks auth and invitation responses no-store; other routes stay cacheable-neutral', async () => {
    const app = buildTestApp();
    app.get('/v1/auth/probe', async () => ({ ok: true }));
    app.post('/v1/invitations/probe', async () => ({ ok: true }));
    app.get('/v1/other', async () => ({ ok: true }));

    const auth = await app.inject({ method: 'GET', url: '/v1/auth/probe' });
    expect(auth.headers['cache-control']).toBe('no-store');

    const invite = await app.inject({
      method: 'POST',
      url: '/v1/invitations/probe',
    });
    expect(invite.headers['cache-control']).toBe('no-store');

    const other = await app.inject({ method: 'GET', url: '/v1/other' });
    expect(other.headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('keeps CORS preflight functional with headers applied and origin allow-list intact', async () => {
    const app = buildTestApp();
    await app.ready();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-orgistry-csrf',
      },
    });

    // Preflight still succeeds with the explicit allow-list + credentials.
    expect(preflight.statusCode).toBeLessThan(300);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    // Security headers ride along without breaking the preflight.
    expect(preflight.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('does not grant CORS to an origin outside the configured allow-list', async () => {
    const app = buildTestApp();
    await app.ready();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});

describe('browser-facing compatibility (separate-origin web demo)', () => {
  it('serves an allowed-origin credentialed request with CORS grants AND security headers', async () => {
    const app = buildTestApp();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'http://localhost:5173',
        cookie: 'orgistry_rt=some-cookie-value',
      },
    });

    expect(response.statusCode).toBe(200);
    // Explicit origin echo — never a wildcard — with credentials allowed, so
    // the SPA's `credentials: 'include'` fetches keep working.
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    // CORP same-origin is compatible with the separate-origin SPA: it blocks
    // only cross-origin no-cors embedding; CORS-mode fetches are governed by
    // the explicit allow-list above.
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('never emits a wildcard origin for foreign-origin requests', async () => {
    const app = buildTestApp();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
