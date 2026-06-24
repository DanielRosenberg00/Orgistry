import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
} from '@orgistry/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from '../organization/testing/build-organization-test-app';

/**
 * RBAC reference route behavior (roles / permissions / matrix), exercised
 * through `app.inject` over the in-memory store seeded from the canonical
 * catalog. Proves the surfaces are read-only and that the matrix reflects the
 * seeded mapping (which IS what `requirePermission` enforces).
 */
let ctx: OrganizationTestContext;
let app: FastifyInstance;
let token: string;
let emailSeq = 0;

async function register(displayName = 'RBAC User'): Promise<string> {
  emailSeq += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `rbac.user.${emailSeq}@example.com`,
      password: 'a-strong-password-123',
      displayName,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.tokens.accessToken;
}

function authHeader(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` };
}

beforeEach(async () => {
  ctx = await buildOrganizationTestApp();
  app = ctx.app;
  token = await register();
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/roles', () => {
  it('requires a Bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/roles' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the four fixed roles with descriptions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: authHeader(token),
    });
    expect(response.statusCode).toBe(200);
    const keys = response.json().data.items.map((r: { key: string }) => r.key);
    expect(keys).toEqual([
      ROLE_KEYS.owner,
      ROLE_KEYS.admin,
      ROLE_KEYS.member,
      ROLE_KEYS.viewer,
    ]);
    expect(response.json().data.items[0].description.length).toBeGreaterThan(0);
  });

  it('is read-only (no create surface)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/roles',
      headers: authHeader(token),
      payload: { key: 'superadmin' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /v1/permissions', () => {
  it('requires a Bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/permissions' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the full fixed permission catalog', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/permissions',
      headers: authHeader(token),
    });
    expect(response.statusCode).toBe(200);
    const keys = response.json().data.items.map((p: { key: string }) => p.key);
    expect(keys).toEqual(PERMISSION_CATALOG.map((p) => p.key));
  });
});

describe('GET /v1/permissions/matrix', () => {
  it('requires a Bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/permissions/matrix' });
    expect(response.statusCode).toBe(401);
  });

  it('returns roles, the permission catalog, and the seeded mapping', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/permissions/matrix',
      headers: authHeader(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.roles.map((r: { key: string }) => r.key)).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
    ]);
    expect(body.permissions).toHaveLength(PERMISSION_CATALOG.length);
    // The matrix matches the canonical seeded mapping exactly.
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect([...body.matrix[role]].sort()).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      );
    }
  });

  it('reflects the Owner-only plan.change_demo distinction', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/permissions/matrix',
        headers: authHeader(token),
      })
    ).json().data;
    expect(body.matrix.owner).toContain(PERMISSION_KEYS.planChangeDemo);
    expect(body.matrix.admin).not.toContain(PERMISSION_KEYS.planChangeDemo);
  });
});
