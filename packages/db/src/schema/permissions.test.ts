import {
  PERMISSION_CATALOG,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  type RoleKey,
} from '@orgistry/contracts';
import { describe, expect, it } from 'vitest';
import { ROLE_KEYS as DB_ROLE_KEYS } from './organizations';
import {
  PERMISSION_SEED,
  ROLE_PERMISSION_SEED,
  permissionRowId,
} from './permissions';

/**
 * Drift guard (no database required).
 *
 * The permission catalog and role→permission mapping live in `@orgistry/contracts`
 * (the public contract). `@orgistry/db` DERIVES its seed rows from them. These
 * assertions prove the two cannot silently diverge — if the catalog/mapping
 * changes without the seed (or vice versa), this fails in the plain `pnpm test`
 * run, before any migration. The DB-backed `migrate.integration.test` then proves
 * the migration SQL matches these same seed constants.
 */
describe('permission seed derives from the contracts catalog', () => {
  it('PERMISSION_SEED covers exactly the catalog, with stable derived ids', () => {
    expect(PERMISSION_SEED).toHaveLength(PERMISSION_CATALOG.length);
    for (const entry of PERMISSION_CATALOG) {
      const seeded = PERMISSION_SEED.find((p) => p.key === entry.key);
      expect(seeded, `seed missing ${entry.key}`).toBeDefined();
      expect(seeded?.id).toBe(permissionRowId(entry.key));
      expect(seeded?.name).toBe(entry.name);
      expect(seeded?.description).toBe(entry.description);
    }
  });

  it('ROLE_PERMISSION_SEED equals the canonical mapping grant-for-grant', () => {
    const expected = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).flatMap(
      (roleKey) => ROLE_PERMISSIONS[roleKey].map((p) => `${roleKey}:${p}`),
    );
    expect(ROLE_PERMISSION_SEED).toHaveLength(expected.length);

    // Map seeded role ids back to keys to compare against the contract mapping.
    const keyByRoleId: Record<string, RoleKey> = {
      role_owner: 'owner',
      role_admin: 'admin',
      role_member: 'member',
      role_viewer: 'viewer',
    };
    const seeded = ROLE_PERMISSION_SEED.map((g) => {
      const permKey = PERMISSION_SEED.find((p) => p.id === g.permissionId)?.key;
      return `${keyByRoleId[g.roleId]}:${permKey}`;
    });
    expect([...seeded].sort()).toEqual([...expected].sort());
  });

  it('role keys agree between @orgistry/contracts and @orgistry/db', () => {
    expect(ROLE_KEYS).toEqual(DB_ROLE_KEYS);
  });
});
