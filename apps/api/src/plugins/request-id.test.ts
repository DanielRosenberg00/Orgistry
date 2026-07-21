import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isSafeRequestId } from '@orgistry/shared';
import { buildTestApp } from '../testing/build-test-app';

/**
 * Request-id resolution AND sanitization (Sprint 19, ORG-PR-052).
 *
 * The centralized policy lives in `@orgistry/shared` (`resolveRequestId`) and
 * is applied in `genReqId` — before any hook, log line, or error envelope can
 * observe the id. A safe client id is preserved; anything unsafe (empty,
 * overlong, whitespace, CR/LF/NUL, control characters, out-of-alphabet) is
 * REPLACED with a generated `req_…` id, consistently across the response
 * header and the error envelope.
 */
describe('request id propagation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reuses a safe inbound x-request-id header and echoes it on the response', async () => {
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

describe('request id sanitization', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function echoedIdFor(headerValue: string): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': headerValue },
    });
    const echoed = response.headers['x-request-id'];
    expect(typeof echoed).toBe('string');
    return echoed as string;
  }

  it('replaces an empty header value with a generated id', async () => {
    const echoed = await echoedIdFor('');
    expect(echoed).toMatch(/^req_/);
  });

  it('replaces an overlong value (>128 chars) with a generated id', async () => {
    const overlong = 'a'.repeat(200);
    const echoed = await echoedIdFor(overlong);
    expect(echoed).not.toBe(overlong);
    expect(echoed).toMatch(/^req_/);
  });

  it('replaces a whitespace-padded/malformed value instead of trimming it', async () => {
    const echoed = await echoedIdFor('  padded id  ');
    expect(echoed).toMatch(/^req_/);
    expect(echoed).not.toContain('padded');
  });

  it.each([
    ['CR injection', 'req_a\rX-Injected: 1'],
    ['LF injection', 'req_a\nX-Injected: 1'],
    ['CRLF injection', 'req_a\r\nSet-Cookie: forged=1'],
    ['control characters', 'req_a\u0007b'],
  ])('replaces %s and never reflects the hostile bytes', async (_label, hostile) => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': hostile },
    });
    const echoed = response.headers['x-request-id'] as string;
    expect(echoed).toMatch(/^req_/);
    expect(isSafeRequestId(echoed)).toBe(true);
    // The forged header must not have been split into a real response header.
    expect(response.headers['x-injected']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('uses ONE generated replacement consistently across response header and error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'bad id\r\nwith injection' },
    });
    const echoed = response.headers['x-request-id'] as string;
    expect(echoed).toMatch(/^req_/);
    expect(isSafeRequestId(echoed)).toBe(true);
    expect(response.json().error.requestId).toBe(echoed);
  });
});
