import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  PERMISSION_KEY_LIST,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  memberRoleChangeRequestSchema,
  memberSchema,
  permissionKeySchema,
  roleKeySchema,
} from './access';

describe('permission catalog', () => {
  it('catalog covers exactly the permission keys, with no duplicates', () => {
    const catalogKeys = PERMISSION_CATALOG.map((entry) => entry.key);
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length);
    expect([...catalogKeys].sort()).toEqual([...PERMISSION_KEY_LIST].sort());
  });

  it('every catalog entry has a name and description', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('permissionKeySchema accepts catalog keys and rejects others', () => {
    expect(permissionKeySchema.safeParse(PERMISSION_KEYS.membersRead).success).toBe(true);
    expect(permissionKeySchema.safeParse('members.delete').success).toBe(false);
  });
});

describe('role → permission mapping', () => {
  it('defines a mapping for every fixed role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      [ROLE_KEYS.admin, ROLE_KEYS.member, ROLE_KEYS.owner, ROLE_KEYS.viewer].sort(),
    );
  });

  it('grants Owner every permission in the catalog', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSION_KEY_LIST].sort());
  });

  it('makes Owner strictly more capable than Admin (plan.change_demo is Owner-only)', () => {
    expect(ROLE_PERMISSIONS.owner).toContain(PERMISSION_KEYS.planChangeDemo);
    expect(ROLE_PERMISSIONS.admin).not.toContain(PERMISSION_KEYS.planChangeDemo);
  });

  it('every role assignment is a subset of the catalog, with no duplicates', () => {
    for (const keys of Object.values(ROLE_PERMISSIONS)) {
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(PERMISSION_KEY_LIST).toContain(key);
      }
    }
  });

  it('does not let Member or Viewer manage members', () => {
    for (const role of ['member', 'viewer'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSION_KEYS.membersChangeRole);
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSION_KEYS.membersRemove);
    }
  });

  it('grants Viewer read-only visibility (no create/update/delete)', () => {
    for (const key of ROLE_PERMISSIONS.viewer) {
      expect(key.endsWith('.create')).toBe(false);
      expect(key.endsWith('.update')).toBe(false);
      expect(key.endsWith('.delete')).toBe(false);
      expect(key.endsWith('.revoke')).toBe(false);
    }
  });
});

describe('member DTOs', () => {
  it('roleKeySchema accepts fixed roles and rejects custom ones', () => {
    expect(roleKeySchema.safeParse('owner').success).toBe(true);
    expect(roleKeySchema.safeParse('superadmin').success).toBe(false);
  });

  it('memberRoleChangeRequestSchema requires a fixed role key', () => {
    expect(memberRoleChangeRequestSchema.safeParse({ role: 'admin' }).success).toBe(true);
    expect(memberRoleChangeRequestSchema.safeParse({ role: 'god' }).success).toBe(false);
  });

  it('memberSchema does not accept auth/session internals', () => {
    const parsed = memberSchema.parse({
      id: 'mem_1',
      user: { id: 'user_1', email: 'a@b.com', displayName: 'A', passwordHash: 'leak' },
      role: { id: 'role_admin', key: 'admin', name: 'Admin' },
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      removedAt: null,
    });
    // zod strips unknown keys: the password hash never survives into the DTO.
    expect((parsed.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });
});
