import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import type { RbacRepository, RolePermissionPair } from './rbac.types';

/**
 * Drizzle-backed implementation of the RBAC reference reads. All SQL for the
 * RBAC read surface lives here; the service depends only on `RbacRepository`.
 *
 * These are plain reads of the seeded `roles`, `permissions`, and
 * `role_permissions` tables — the matrix endpoint is therefore guaranteed to
 * reflect the SAME mapping that effective-permission resolution enforces.
 */
export function createDbRbacRepository(db: Database): RbacRepository {
  return {
    async listRoles() {
      return db.select().from(schema.roles);
    },

    async listPermissions() {
      return db.select().from(schema.permissions);
    },

    async listRolePermissions(): Promise<RolePermissionPair[]> {
      return db
        .select({
          roleId: schema.rolePermissions.roleId,
          permissionId: schema.rolePermissions.permissionId,
        })
        .from(schema.rolePermissions);
    },
  };
}
