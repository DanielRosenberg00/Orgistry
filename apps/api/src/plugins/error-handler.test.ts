import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../testing/build-test-app';
import { AppError } from '../lib/errors';

/**
 * Verifies the single central error path: AppErrors map to their declared
 * envelope, and unexpected errors are masked behind a safe 500.
 */
describe('central error handling', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    // Test-only routes that exercise both error branches.
    app.get('/boom', async () => {
      throw new Error('internal detail that must not leak');
    });
    app.get('/app-error', async () => {
      throw new AppError('CONFLICT', 409, 'Already exists');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('masks unexpected errors as a generic 500 without leaking details', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom' });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('internal detail');
    expect(body.error.requestId).toBeDefined();
  });

  it('maps an AppError to its declared code and status', async () => {
    const response = await app.inject({ method: 'GET', url: '/app-error' });
    const body = response.json();

    expect(response.statusCode).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('Already exists');
  });
});
