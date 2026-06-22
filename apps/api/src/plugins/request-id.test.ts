import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../testing/build-test-app';

describe('request id propagation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reuses an inbound x-request-id header and echoes it on the response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req_inbound_fixed' },
    });

    expect(response.headers['x-request-id']).toBe('req_inbound_fixed');
  });

  it('generates a request id when none is supplied and echoes it back', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const header = response.headers['x-request-id'];

    expect(typeof header).toBe('string');
    expect(header).toMatch(/^req_/);
  });

  it('includes the same request id in error envelopes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'req_trace_42' },
    });

    expect(response.headers['x-request-id']).toBe('req_trace_42');
    expect(response.json().error.requestId).toBe('req_trace_42');
  });
});
