import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  buildOrganizationTestApp,
  type OrganizationTestContext,
} from './testing/build-organization-test-app';

/**
 * End-to-end organization route behavior through `app.inject`, backed by the
 * shared in-memory store. Validates the full HTTP path — Bearer auth, contract
 * validation, the membership-scoped read/list visibility rules, envelopes, and
 * error mapping — without PostgreSQL. DB-backed persistence invariants are
 * covered separately in the integration suite.
 */
let ctx: OrganizationTestContext;

beforeEach(async () => {
  ctx = await buildOrganizationTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

let userSeq = 0;

/** Register a fresh user and return their access token + user id. */
async function registerUser(displayName = 'Test User'): Promise<{
  token: string;
  userId: string;
}> {
  userSeq += 1;
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `user${userSeq}@example.com`,
      password: 'a-strong-password-123',
      displayName,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json().data;
  return { token: body.tokens.accessToken, userId: body.user.id };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function createOrg(
  token: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: authHeader(token),
    payload,
  });
}

function listOrgs(
  token: string,
  query = '',
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'GET',
    url: `/v1/organizations${query}`,
    headers: authHeader(token),
  });
}

function readOrg(
  token: string,
  organizationId: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'GET',
    url: `/v1/organizations/${organizationId}`,
    headers: authHeader(token),
  });
}

describe('authentication', () => {
  it('rejects create/list/read without a Bearer token (401)', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      payload: { name: 'Acme' },
    });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/organizations',
    });
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/v1/organizations/org_whatever',
    });
    for (const r of [create, list, read]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('registration personal workspace', () => {
  it('lists the auto-provisioned personal workspace after registration', async () => {
    const { token } = await registerUser('Ada Lovelace');
    const response = await listOrgs(token);
    expect(response.statusCode).toBe(200);

    const { items } = response.json().data;
    expect(items).toHaveLength(1);
    expect(items[0].organization.type).toBe('personal');
    expect(items[0].organization.status).toBe('active');
    expect(items[0].membership.role.key).toBe('owner');
    expect(items[0].membership.status).toBe('active');
  });
});

describe('POST /v1/organizations', () => {
  it('creates a team organization with the creator as active Owner', async () => {
    const { token } = await registerUser();
    const response = await createOrg(token, { name: 'Acme Inc' });
    expect(response.statusCode).toBe(201);

    const { organization, membership } = response.json().data;
    expect(organization.type).toBe('team');
    expect(organization.status).toBe('active');
    expect(organization.slug).toBe('acme-inc');
    expect(membership.role.key).toBe('owner');
    expect(membership.status).toBe('active');
    // No raw persistence columns leak.
    expect(JSON.stringify(response.json())).not.toContain('createdByUserId');
    expect(JSON.stringify(response.json())).not.toContain('passwordHash');
  });

  it('honors an explicit slug', async () => {
    const { token } = await registerUser();
    const response = await createOrg(token, { name: 'Acme', slug: 'acme-team' });
    expect(response.json().data.organization.slug).toBe('acme-team');
  });

  it('auto-resolves a derived slug collision deterministically', async () => {
    const { token } = await registerUser();
    const first = await createOrg(token, { name: 'Acme' });
    const second = await createOrg(token, { name: 'Acme' });
    expect(first.json().data.organization.slug).toBe('acme');
    expect(second.json().data.organization.slug).toBe('acme-2');
  });

  it('rejects an explicit slug that is already taken (409)', async () => {
    const { token } = await registerUser();
    await createOrg(token, { name: 'First', slug: 'shared-slug' });
    const conflict = await createOrg(token, {
      name: 'Second',
      slug: 'shared-slug',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('ORGANIZATION_SLUG_TAKEN');
  });

  it('rejects an invalid body (422/400 validation)', async () => {
    const { token } = await registerUser();
    const response = await createOrg(token, { name: '' });
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /v1/organizations', () => {
  it('lists every organization the user belongs to', async () => {
    const { token } = await registerUser(); // personal workspace
    await createOrg(token, { name: 'Alpha' });
    await createOrg(token, { name: 'Beta' });

    const response = await listOrgs(token);
    const { items } = response.json().data;
    expect(items).toHaveLength(3);
    const names = items
      .map((i: { organization: { name: string } }) => i.organization.name)
      .sort();
    expect(names).toEqual(['Alpha', 'Beta', "Test User's Workspace"]);
  });

  it('orders memberships newest-first (keyset on membership recency)', async () => {
    const { token, userId } = await registerUser();
    await createOrg(token, { name: 'Alpha' });
    await createOrg(token, { name: 'Beta' });

    // Force distinct, ordered timestamps so the assertion is deterministic
    // regardless of same-millisecond ties on the random-id tiebreak.
    const byName = (name: string) => {
      const org = ctx.orgStore.organizations.find((o) => o.name === name);
      return ctx.orgStore.memberships.find(
        (m) => m.userId === userId && m.organizationId === org?.id,
      )!;
    };
    byName("Test User's Workspace").createdAt = new Date(1000);
    byName('Alpha').createdAt = new Date(2000);
    byName('Beta').createdAt = new Date(3000);

    const response = await listOrgs(token);
    const names = response
      .json()
      .data.items.map((i: { organization: { name: string } }) => i.organization.name);
    expect(names).toEqual(['Beta', 'Alpha', "Test User's Workspace"]);
  });

  it('does not leak organizations belonging to other users', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    await createOrg(alice.token, { name: 'Alice Secret Org' });

    const response = await listOrgs(bob.token);
    const { items } = response.json().data;
    // Bob sees only his own personal workspace.
    expect(items).toHaveLength(1);
    expect(items[0].organization.type).toBe('personal');
    expect(JSON.stringify(response.json())).not.toContain('Alice Secret Org');
  });

  it('paginates with an opaque cursor without dropping or duplicating rows', async () => {
    const { token } = await registerUser();
    await createOrg(token, { name: 'Alpha' });
    await createOrg(token, { name: 'Beta' }); // 3 total incl. personal

    const orgId = (i: { organization: { id: string } }) => i.organization.id;

    const page1 = await listOrgs(token, '?limit=2');
    const body1 = page1.json().data;
    expect(body1.items).toHaveLength(2);
    expect(body1.hasMore).toBe(true);
    expect(body1.nextCursor).toBeTypeOf('string');

    const page2 = await listOrgs(
      token,
      `?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
    );
    const body2 = page2.json().data;
    expect(body2.items).toHaveLength(1);
    expect(body2.hasMore).toBe(false);
    expect(body2.nextCursor).toBeNull();

    // Union of both pages is exactly the 3 distinct organizations.
    const ids = [...body1.items, ...body2.items].map(orgId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('GET /v1/organizations/:organizationId', () => {
  it('reads an organization the user belongs to', async () => {
    const { token } = await registerUser();
    const created = await createOrg(token, { name: 'Acme' });
    const orgId = created.json().data.organization.id;

    const response = await readOrg(token, orgId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.organization.id).toBe(orgId);
    expect(response.json().data.membership.role.key).toBe('owner');
  });

  it('returns 404 for an organization the user does not belong to', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const created = await createOrg(alice.token, { name: 'Alice Org' });
    const orgId = created.json().data.organization.id;

    const response = await readOrg(bob.token, orgId);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('returns the same 404 for a non-existent organization', async () => {
    const { token } = await registerUser();
    const response = await readOrg(token, 'org_doesnotexist');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});

describe('membership invariants', () => {
  it('treats a removed membership as no access (read + list)', async () => {
    const { token, userId } = await registerUser();
    const created = await createOrg(token, { name: 'Acme' });
    const orgId = created.json().data.organization.id;

    // Simulate member removal directly in the store (no endpoint exists yet).
    const membership = ctx.orgStore.memberships.find(
      (m) => m.userId === userId && m.organizationId === orgId,
    );
    if (!membership) throw new Error('membership missing');
    membership.status = 'removed';
    membership.removedAt = new Date();

    const read = await readOrg(token, orgId);
    expect(read.statusCode).toBe(404);

    const list = await listOrgs(token);
    const names = list
      .json()
      .data.items.map((i: { organization: { name: string } }) => i.organization.name);
    expect(names).not.toContain('Acme');
  });
});
