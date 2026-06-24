import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import type { RbacRepository, RolePermissionPair } from '../rbac.types';

/**
 * In-memory `RbacRepository` for unit/route tests.
 *
 * Reads the SAME shared `InMemoryOrgStore` that is pre-seeded from the canonical
 * roles/permissions/mapping, so the RBAC read surface behaves like the migrated,
 * seeded database with no PostgreSQL.
 */
export function createInMemoryRbacRepository(
  store: InMemoryOrgStore,
): RbacRepository {
  return {
    async listRoles() {
      return [...store.roles];
    },
    async listPermissions() {
      return [...store.permissions];
    },
    async listRolePermissions(): Promise<RolePermissionPair[]> {
      return store.rolePermissions.map((rp) => ({
        roleId: rp.roleId,
        permissionId: rp.permissionId,
      }));
    },
  };
}
