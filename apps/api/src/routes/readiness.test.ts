import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  failingProbe,
  passingProbe,
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
});
