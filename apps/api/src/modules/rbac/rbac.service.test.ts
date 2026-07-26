import { ROLE_PERMISSIONS, type RoleKey } from '@orgistry/contracts';
import { describe, expect, it } from 'vitest';
import { createInMemoryOrgStore } from '../organization/testing/in-memory-org-store';
import { createInMemoryRbacRepository } from './testing/in-memory-rbac-repo';
import { createRbacService } from './rbac.service';
import type { RbacRepository } from './rbac.types';

/**
 * Matrix-assembly invariants (Sprint 21): the seeded catalogs fully populate
 * the matrix; grants referencing UNKNOWN role/permission ids are skipped
 * (pre-existing, documented behavior); and a recognized role can never lose
 * permissions silently — a missing matrix entry for a known role is an
 * internal invariant violation enforced by `requireDefined`.
 */

function seededRepository(): RbacRepository {
  return createInMemoryRbacRepository(createInMemoryOrgStore());
}

describe('rbac service matrix assembly', () => {
  it('populates every seeded role with exactly the canonical permissions', async () => {
    const service = createRbacService({ repo: seededRepository() });
    const { matrix } = await service.getMatrix();

    for (const [roleKey, expected] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(matrix[roleKey as RoleKey])).toEqual(new Set(expected));
    }
    expect(Object.keys(matrix).sort()).toEqual(
      Object.keys(ROLE_PERMISSIONS).sort(),
    );
  });

  it('skips grants whose role or permission id is unknown to the catalogs', async () => {
    const repo = seededRepository();
    const rolePermissions = await repo.listRolePermissions();
    const withUnknowns: RbacRepository = {
      ...repo,
      async listRolePermissions() {
        return [
          ...rolePermissions,
          // Neither id exists in the loaded catalogs: skipped, no throw.
          { roleId: 'role_ghost', permissionId: 'perm_ghost' },
          // Known role, unknown permission id: also skipped.
          { roleId: rolePermissions[0]?.roleId ?? '', permissionId: 'perm_ghost' },
        ];
      },
    };

    const service = createRbacService({ repo: withUnknowns });
    const { matrix } = await service.getMatrix();

    // The malformed grants change nothing: the matrix still equals the
    // canonical mapping exactly (no phantom keys, no dropped permissions).
    for (const [roleKey, expected] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(matrix[roleKey as RoleKey])).toEqual(new Set(expected));
    }
    expect(matrix).not.toHaveProperty('role_ghost');
  });
});
