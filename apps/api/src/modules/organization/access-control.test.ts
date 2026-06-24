import { ERROR_CODES, PERMISSION_KEYS, ROLE_KEYS } from '@orgistry/contracts';
import { ROLE_IDS, ROLE_KEYS as DB_ROLE_KEYS } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  actorHasPermission,
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from './access-control';
import { createInMemoryOrganizationRepository } from './testing/in-memory-organization-repo';
import {
  createInMemoryOrgStore,
  type InMemoryOrgStore,
} from './testing/in-memory-org-store';

/**
 * Unit tests for the organization-scoped access-control helpers. These prove the
 * two non-negotiable rules: removed/cross-org memberships never authorize, and
 * authorization is by permission key (never role name).
 */
let store: InMemoryOrgStore;
let repo: ReturnType<typeof createInMemoryOrganizationRepository>;
let organizationId: string;
const OWNER_USER = 'user_owner';

beforeEach(async () => {
  store = createInMemoryOrgStore();
  repo = createInMemoryOrganizationRepository(store);
  const view = await repo.createTeamOrganization({
    userId: OWNER_USER,
    name: 'Acme',
  });
  organizationId = view.organization.id;
});

/** Push an active membership with an explicit role and return its user id. */
function addMember(roleId: string): string {
  const userId = createId('user');
  const now = new Date();
  store.memberships.push({
    id: createId('mem'),
    userId,
    organizationId,
    roleId,
    status: 'active',
    invitedByUserId: null,
    joinedAt: now,
    removedAt: null,
    removedByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

describe('fixed role keys', () => {
  it('agree between @orgistry/contracts and @orgistry/db', () => {
    // The two packages each define the fixed role keys; they must not diverge.
    expect(ROLE_KEYS).toEqual(DB_ROLE_KEYS);
    // Every role key has a seeded id.
    for (const key of Object.values(ROLE_KEYS)) {
      expect(ROLE_IDS[key]).toBeDefined();
    }
  });
});

describe('requireMembership', () => {
  it('resolves an active member into a complete actor with effective permissions', async () => {
    const actor = await requireMembership(repo, {
      userId: OWNER_USER,
      organizationId,
      requestId: 'req_1',
    });
    expect(actor.userId).toBe(OWNER_USER);
    expect(actor.organizationId).toBe(organizationId);
    expect(actor.role.key).toBe('owner');
    expect(actor.requestId).toBe('req_1');
    // Owner has the full catalog; a representative permission is present.
    expect(actor.permissions.has(PERMISSION_KEYS.membersRemove)).toBe(true);
  });

  it('rejects a user with no membership in the organization (indistinguishable 404)', async () => {
    await expect(
      requireMembership(repo, { userId: 'user_stranger', organizationId }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.ORGANIZATION_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('rejects a removed membership (removed memberships never authorize)', async () => {
    store.memberships[0].status = 'removed';
    await expect(
      requireMembership(repo, { userId: OWNER_USER, organizationId }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ORGANIZATION_NOT_FOUND });
  });

  it('rejects a known user reaching into an organization they do not belong to', async () => {
    await expect(
      requireMembership(repo, {
        userId: OWNER_USER,
        organizationId: 'org_does_not_exist',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ORGANIZATION_NOT_FOUND });
  });

  it('derives different effective permissions for different roles', async () => {
    const viewerUser = addMember(ROLE_IDS.viewer);
    const viewer = await requireMembership(repo, {
      userId: viewerUser,
      organizationId,
    });
    expect(viewer.role.key).toBe('viewer');
    expect(viewer.permissions.has(PERMISSION_KEYS.orgRead)).toBe(true);
    expect(viewer.permissions.has(PERMISSION_KEYS.membersChangeRole)).toBe(false);
  });
});

describe('requirePermission', () => {
  it('passes when the actor holds the permission', async () => {
    const actor = await requireMembership(repo, {
      userId: OWNER_USER,
      organizationId,
    });
    expect(() => requirePermission(actor, PERMISSION_KEYS.membersRead)).not.toThrow();
  });

  it('rejects with FORBIDDEN when the actor lacks the permission', async () => {
    const viewerUser = addMember(ROLE_IDS.viewer);
    const actor = await requireMembership(repo, {
      userId: viewerUser,
      organizationId,
    });
    try {
      requirePermission(actor, PERMISSION_KEYS.membersChangeRole);
      throw new Error('expected requirePermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.FORBIDDEN);
      expect((error as AppError).statusCode).toBe(403);
    }
  });

  it('authorizes by permission set — not role name', () => {
    // An actor whose role NAME is "owner" but whose effective permission set is
    // empty is still denied: the check consults the permission set, never the role.
    const ownerNamedButPowerless: OrganizationActor = {
      userId: 'user_x',
      organizationId: 'org_x',
      membershipId: 'mem_x',
      role: { id: ROLE_IDS.owner, key: 'owner', name: 'Owner' },
      permissions: new Set(),
      requestId: null,
    };
    expect(actorHasPermission(ownerNamedButPowerless, PERMISSION_KEYS.orgRead)).toBe(false);
    expect(() =>
      requirePermission(ownerNamedButPowerless, PERMISSION_KEYS.orgRead),
    ).toThrow(AppError);
  });
});
