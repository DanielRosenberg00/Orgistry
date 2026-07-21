import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerTestUser } from '../auth/testing/register-test-user';
import { createInMemoryRateLimiter } from '../../lib/rate-limit';
import {
  buildProjectsTestApp,
  type ProjectsTestContext,
} from './testing/build-projects-test-app';

/**
 * Authenticated mutation throttling — project creation (Sprint 19,
 * ORG-PR-032). User-scoped bucket, enforced AFTER the permission check and
 * BEFORE the quota read; quota (`max_projects`) remains authoritative.
 */

let ctx: ProjectsTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function registerUser(): Promise<{ token: string }> {
  emailSeq += 1;
  const { accessToken } = await registerTestUser(app, ctx!.mailer, {
    email: `proj.throttle.${emailSeq}@example.com`,
    password: 'a-strong-password-123',
    displayName: 'Project Throttler',
  });
  return { token: accessToken };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createTeamOrg(token: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: authHeader(token),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.organization.id;
}

function createProject(token: string, orgId: string, name: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/projects`,
    headers: authHeader(token),
    payload: { name },
  });
}

describe('POST /v1/organizations/:id/projects — per-user throttle', () => {
  it('limits repeated creation with the standard envelope and isolates users', async () => {
    ctx = await buildProjectsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      projectRateLimits: {
        windowSeconds: 60,
        createPerUserMax: 2,
        mutationPerUserMax: 1000,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');

    expect((await createProject(owner.token, orgId, 'P1')).statusCode).toBe(201);
    expect((await createProject(owner.token, orgId, 'P2')).statusCode).toBe(201);
    const third = await createProject(owner.token, orgId, 'P3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');

    // A different user (own org) is untouched by the exhausted bucket.
    const other = await registerUser();
    const otherOrg = await createTeamOrg(other.token, 'Beta');
    expect((await createProject(other.token, otherOrg, 'Q1')).statusCode).toBe(201);
  });

  it('preserves cross-tenant 404 behavior with an exhausted bucket', async () => {
    ctx = await buildProjectsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      projectRateLimits: {
        windowSeconds: 60,
        createPerUserMax: 1,
        mutationPerUserMax: 1000,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    await createProject(owner.token, orgId, 'P1');

    const outsider = await registerUser();
    const denied = await createProject(outsider.token, orgId, 'Nope');
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});

describe('project update/delete — per-acting-user throttle (Sprint 19 refinement)', () => {
  it('limits repeated update/delete mutations through one shared bucket', async () => {
    ctx = await buildProjectsTestApp({
      rateLimiter: createInMemoryRateLimiter(),
      projectRateLimits: {
        windowSeconds: 60,
        createPerUserMax: 1000,
        mutationPerUserMax: 2,
      },
    });
    app = ctx.app;
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token, 'Acme');
    const created = await createProject(owner.token, orgId, 'P1');
    expect(created.statusCode).toBe(201);
    const projectId = created.json().data.project.id;

    const update = (name: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgId}/projects/${projectId}`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { name },
      });

    expect((await update('P1a')).statusCode).toBe(200);
    expect((await update('P1b')).statusCode).toBe(200);

    // Third mutation — update OR delete — trips the shared bucket, so an
    // audit-write loop is bounded while creation stays governed by its own
    // bucket and the max_projects quota.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/projects/${projectId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(del.statusCode).toBe(429);
    expect(del.json().error.code).toBe('RATE_LIMITED');
  });
});
