import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './testing/build-test-app';

/** API boot smoke test + envelope and not-found behavior. */
describe('API application', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots and becomes ready', () => {
    expect(app.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
  });

  it('returns a consistent success envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('returns a standard error envelope with a request id for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });
});
