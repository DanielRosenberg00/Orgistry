import { describe, expect, it } from 'vitest';
import type { RateLimiter } from './lib/rate-limit';
import {
  buildTestApp,
  productionLikeTestConfig,
  testConfig,
} from './testing/build-test-app';

/**
 * Proxy-trust behavior (Sprint 19, ORG-PR-010).
 *
 * `trustProxy` is fixed at Fastify construction time from typed config:
 *  - TRUST_PROXY=false (default): forwarded headers are IGNORED; `request.ip`
 *    is the socket peer, so a direct client cannot spoof its identity.
 *  - TRUST_PROXY=1: exactly one proxy hop is trusted; the client IP comes
 *    from the rightmost untrusted entry of `X-Forwarded-For`.
 * Every IP consumer (limiter keys, logs, security events) reads `request.ip`,
 * so these tests pin the resolution AND its use in rate-limit keys.
 */

/** A limiter that records keys and always allows. */
function recordingLimiter(keys: string[]): RateLimiter {
  return {
    consume: async (key) => {
      keys.push(key);
      return 'allowed';
    },
  };
}

describe('proxy trust disabled (default)', () => {
  it('resolves request.ip from the socket, not X-Forwarded-For', async () => {
    const app = buildTestApp();
    let seenIp = '';
    app.get('/ip-probe', async (request) => {
      seenIp = request.ip;
      return { ok: true };
    });

    await app.inject({
      method: 'GET',
      url: '/ip-probe',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });

    expect(seenIp).toBe('203.0.113.9');
    await app.close();
  });

  it('keys the global rate limit on the socket IP even when a spoofed header is present', async () => {
    const keys: string[] = [];
    const app = buildTestApp(undefined, {
      globalRateLimiter: recordingLimiter(keys),
    });
    app.get('/limited-probe', async () => ({ ok: true }));

    await app.inject({
      method: 'GET',
      url: '/limited-probe',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.77, 10.0.0.1' },
    });

    expect(keys).toContain('rl:global:ip:203.0.113.9');
    expect(keys.join()).not.toContain('198.51.100.77');
    await app.close();
  });
});

describe('proxy trust enabled (TRUST_PROXY=1, one documented hop)', () => {
  const proxiedConfig = () => testConfig({ TRUST_PROXY: '1' });

  it('resolves request.ip from X-Forwarded-For behind the trusted hop', async () => {
    const app = buildTestApp(undefined, { config: proxiedConfig() });
    let seenIp = '';
    app.get('/ip-probe', async (request) => {
      seenIp = request.ip;
      return { ok: true };
    });

    await app.inject({
      method: 'GET',
      url: '/ip-probe',
      // The socket peer is the reverse proxy; the header names the client.
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });

    expect(seenIp).toBe('198.51.100.77');
    await app.close();
  });

  it('with multiple forwarded values, trusts exactly one hop (rightmost beyond the proxy)', async () => {
    const app = buildTestApp(undefined, { config: proxiedConfig() });
    let seenIp = '';
    app.get('/ip-probe', async (request) => {
      seenIp = request.ip;
      return { ok: true };
    });

    await app.inject({
      method: 'GET',
      url: '/ip-probe',
      remoteAddress: '10.0.0.1',
      // A client attempting to prepend fake hops: with ONE trusted hop, the
      // value adjacent to the trusted proxy wins, not the attacker-chosen head.
      headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.77' },
    });

    expect(seenIp).toBe('198.51.100.77');
    await app.close();
  });

  it('keys the global rate limit on the proxy-resolved client IP', async () => {
    const keys: string[] = [];
    const app = buildTestApp(undefined, {
      config: proxiedConfig(),
      globalRateLimiter: recordingLimiter(keys),
    });
    app.get('/limited-probe', async () => ({ ok: true }));

    await app.inject({
      method: 'GET',
      url: '/limited-probe',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });

    expect(keys).toContain('rl:global:ip:198.51.100.77');
    await app.close();
  });
});

describe('explicit proxy-address lists and the production limiter invariant', () => {
  it('boots successfully with an explicit IP/CIDR proxy list and honors it', async () => {
    const app = buildTestApp(undefined, {
      config: testConfig({ TRUST_PROXY: '127.0.0.1, 10.0.0.0/8' }),
    });
    let seenIp = '';
    app.get('/ip-probe', async (request) => {
      seenIp = request.ip;
      return { ok: true };
    });
    // Construction + ready succeed with the semantic list applied.
    await app.ready();

    // A request whose socket peer IS a listed proxy resolves the forwarded
    // client; a peer outside the list stays the socket address.
    await app.inject({
      method: 'GET',
      url: '/ip-probe',
      remoteAddress: '10.1.2.3',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });
    expect(seenIp).toBe('198.51.100.77');

    await app.inject({
      method: 'GET',
      url: '/ip-probe',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });
    expect(seenIp).toBe('203.0.113.9');
    await app.close();
  });

  it('refuses to construct a PRODUCTION app without the global rate limiter', async () => {
    expect(() =>
      buildTestApp(undefined, { config: productionLikeTestConfig() }),
    ).toThrow(/global rate limiter is required/);
  });

  it('constructs a production app normally once the limiter is wired', async () => {
    const app = buildTestApp(undefined, {
      config: productionLikeTestConfig(),
      globalRateLimiter: recordingLimiter([]),
    });
    await app.ready();
    await app.close();
  });
});
