import Redis from 'ioredis';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { createRedisRateLimiter } from './rate-limit';
import { passingProbe, testConfig } from '../testing/build-test-app';
import { buildAuthTestApp } from '../modules/auth/testing/build-auth-test-app';

/**
 * REAL-Redis rate-limiter integration (Sprint 19 refinement, ORG-PR-009/012).
 *
 * Everything here runs against a live Redis through `ioredis` and the real
 * `createRedisRateLimiter` — no in-memory limiter, no unavailable-store test
 * double. It proves what the unit doubles cannot:
 *  - the global bucket's INCR/EXPIRE behavior, per-identity key isolation,
 *    and TTL hygiene against the actual store;
 *  - the sensitive fail-closed path driven by a REAL client failure: the
 *    ioredis connection is `quit()` so every subsequent command rejects
 *    immediately and deterministically ("Connection is closed"). This is a
 *    client-side outage simulation — the strongest deterministic real-client
 *    failure available in this harness (the suite cannot stop the shared
 *    Redis server other suites depend on); the server-down case follows the
 *    same rejected-command code path in ioredis.
 *
 * This suite FAILS HARD when Redis is unreachable — it never skips. The
 * real-Redis limiter evidence is mandatory for `pnpm validate:integration`
 * (Sprint 19), so an integration run without a reachable Redis must exit
 * non-zero rather than reporting a green pass that silently omitted it.
 */
loadWorkspaceEnv();

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Connectivity gate: a failed connect throws at module load, which the test
// runner reports as a suite failure (never an application/public error, and
// never a warning-plus-exit-0). Deliberately NOT describe.skipIf.
const probe = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 1500,
});
try {
  await probe.connect();
  await probe.ping();
} catch (error) {
  throw new Error(
    `rate-limit.redis.integration.test.ts requires a reachable Redis at REDIS_URL (${redisUrl}); ` +
      'start it (pnpm infra:up) before running pnpm validate:integration. ' +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  probe.disconnect();
}

// Distinctive TEST-NET client IPs so this suite never collides with other
// suites' buckets; their keys are deleted before each run.
const IP_A = '198.51.100.201';
const IP_B = '198.51.100.202';
const KEY_A = `rl:global:ip:${IP_A}`;
const KEY_B = `rl:global:ip:${IP_B}`;

describe('global rate limit against live Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(KEY_A, KEY_B);
  });

  afterAll(async () => {
    await redis.del(KEY_A, KEY_B);
    redis.disconnect();
  });

  it('enforces the threshold, isolates identities, sets a TTL, and keeps keys secret-free', async () => {
    const app = buildApp({
      config: testConfig({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SECONDS: '60' }),
      readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
      globalRateLimiter: createRedisRateLimiter(redis),
      logger: false,
    });
    app.get('/probe', async () => ({ ok: true }));

    // Up to the injected threshold from identity A…
    for (let i = 0; i < 2; i += 1) {
      const ok = await app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: IP_A,
        headers: { authorization: 'Bearer should-never-reach-redis-keys' },
      });
      expect(ok.statusCode).toBe(200);
    }

    // …then the standard envelope with the sanitized request id.
    const limited = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: IP_A,
      headers: { 'x-request-id': 'req_redis_global_probe' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.json().error.requestId).toBe('req_redis_global_probe');

    // A second trusted identity has its own untouched Redis bucket.
    const otherIdentity = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: IP_B,
    });
    expect(otherIdentity.statusCode).toBe(200);

    // Store hygiene, read straight from Redis: both buckets exist, carry a
    // positive TTL (the window expires on its own), and no request secret
    // ever became key material.
    expect(Number(await redis.get(KEY_A))).toBe(3);
    expect(Number(await redis.get(KEY_B))).toBe(1);
    expect(await redis.ttl(KEY_A)).toBeGreaterThan(0);
    expect(await redis.ttl(KEY_B)).toBeGreaterThan(0);
    const observedKeys = await redis.keys('rl:global:ip:198.51.100.2*');
    for (const key of observedKeys) {
      expect(key).not.toContain('Bearer');
      expect(key).not.toContain('should-never-reach-redis-keys');
    }

    await app.close();
  });
});

describe('sensitive fail-closed path against a real Redis client', () => {
  it('behaves normally while Redis answers, then fails closed (503, no internals) after the client is closed', async () => {
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping(); // connection established before the healthy phase
    // Real API composition for a representative sensitive public endpoint:
    // the registration request route wired with the REAL Redis limiter in
    // production failure mode.
    const ctx = await buildAuthTestApp({
      rateLimiter: createRedisRateLimiter(redis),
      rateLimitFailureMode: 'closed',
    });

    const payload = {
      email: 'redis.outage.probe@example.com',
      password: 'a-strong-password-123',
      displayName: 'Redis Outage Probe',
    };

    // Healthy store: the limiter answers and the endpoint behaves normally.
    const healthy = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload,
    });
    expect(healthy.statusCode).toBe(200);

    // Deterministic real-client failure: after quit(), every command the
    // limiter issues rejects immediately — no sleeps, no races.
    await redis.quit();

    const failedClosed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload,
      headers: { 'x-request-id': 'req_store_outage_probe' },
    });
    expect(failedClosed.statusCode).toBe(503);
    const body = failedClosed.json();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.requestId).toBe('req_store_outage_probe');
    // Generic envelope only: no store internals leak to the client.
    const serialized = failedClosed.body.toLowerCase();
    expect(serialized).not.toContain('redis');
    expect(serialized).not.toContain('connection');
    expect(serialized).not.toContain('econnrefused');
    expect(serialized).not.toContain('stack');

    await ctx.app.close();
  });

  it('fails open in the documented development/test mode with the same closed client', async () => {
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
    await redis.quit();

    const ctx = await buildAuthTestApp({
      rateLimiter: createRedisRateLimiter(redis),
      rateLimitFailureMode: 'open',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'redis.outage.open@example.com',
        password: 'a-strong-password-123',
        displayName: 'Redis Open Probe',
      },
    });
    expect(response.statusCode).toBe(200);

    await ctx.app.close();
  });
});
