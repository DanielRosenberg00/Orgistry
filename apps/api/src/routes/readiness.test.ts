import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createNoopRateLimiter } from '../lib/rate-limit';
import {
  buildTestApp,
  failingProbe,
  passingProbe,
  productionLikeTestConfig,
} from '../testing/build-test-app';

describe('GET /ready', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 200 and per-dependency status when all probes pass', async () => {
    app = buildTestApp([passingProbe('postgres'), passingProbe('redis')]);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ready');
    expect(body.data.checks.map((c: { name: string }) => c.name)).toEqual([
      'postgres',
      'redis',
    ]);
    expect(body.data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('returns 503 with an error envelope when a dependency is down', async () => {
    app = buildTestApp([passingProbe('postgres'), failingProbe('redis')]);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.requestId).toBeDefined();
    const redisCheck = body.error.details.checks.find(
      (c: { name: string }) => c.name === 'redis',
    );
    expect(redisCheck.ok).toBe(false);
  });

  it('never leaks probe error internals even in detailed mode', async () => {
    app = buildTestApp([failingProbe('redis')]);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const serialized = response.body;

    // The probe threw "redis unavailable"; only name/ok/latency may surface.
    expect(serialized).not.toContain('unavailable"');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('6379');
  });
});

describe('GET /ready — production disclosure (coarse)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports only a coarse ready status when healthy', async () => {
    app = buildTestApp([passingProbe('postgres'), passingProbe('redis')], {
      config: productionLikeTestConfig(),
      globalRateLimiter: createNoopRateLimiter(),
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data).toEqual({ status: 'ready' });
    expect(response.body).not.toContain('postgres');
    expect(response.body).not.toContain('redis');
  });

  it('reports Redis unavailability as a coarse 503 with no dependency inventory', async () => {
    app = buildTestApp([passingProbe('postgres'), failingProbe('redis')], {
      config: productionLikeTestConfig(),
      globalRateLimiter: createNoopRateLimiter(),
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.requestId).toBeDefined();
    expect(body.error.details).toBeUndefined();
    // No dependency names, hosts, ports, or exception text.
    expect(response.body).not.toContain('redis');
    expect(response.body).not.toContain('postgres');
    expect(response.body).not.toContain('unavailable"');
  });
});
