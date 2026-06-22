import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, failingProbe } from '../testing/build-test-app';

/**
 * Liveness must report "ok" regardless of dependency health, so a Postgres or
 * Redis outage never causes the orchestrator to restart a healthy process.
 */
describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Even with both dependencies down, liveness stays ok.
    app = buildTestApp([failingProbe('postgres'), failingProbe('redis')]);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok without checking dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { status: 'ok' } });
  });
});
