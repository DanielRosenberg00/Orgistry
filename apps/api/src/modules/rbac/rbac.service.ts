import type { PermissionRow, RoleRow } from '@orgistry/db';
import {
  PERMISSION_KEY_LIST,
  ROLE_KEY_ORDER,
  type Permission,
  type PermissionKey,
  type PermissionListResponse,
  type PermissionMatrixResponse,
  type Role,
  type RoleKey,
  type RoleListResponse,
} from '@orgistry/contracts';
import type { RbacRepository } from './rbac.types';

/**
 * RBAC reference workflows: the fixed roles, the fixed permission catalog, and
 * the role→permission matrix. All read-only.
 *
 * Output ordering is stable and canonical (roles by privilege, permissions by
 * catalog order) regardless of database row order, and the matrix is assembled
 * from the SEEDED grants so it never drifts from enforcement. The service maps
 * persistence rows to public DTOs and never returns a raw row.
 */
export interface RbacServiceOptions {
  repo: RbacRepository;
}

export interface RbacService {
  listRoles(): Promise<RoleListResponse>;
  listPermissions(): Promise<PermissionListResponse>;
  getMatrix(): Promise<PermissionMatrixResponse>;
}

/** Map a role row to the public Role DTO (identity + description). */
function toRole(row: RoleRow): Role {
  return { id: row.id, key: row.key, name: row.name, description: row.description };
}

/** Map a permission row to the public Permission DTO (key + metadata). */
function toPermission(row: PermissionRow): Permission {
  return { key: row.key, name: row.name, description: row.description };
}

const ROLE_RANK = new Map<RoleKey, number>(
  ROLE_KEY_ORDER.map((key, index) => [key, index]),
);
const PERMISSION_RANK = new Map<PermissionKey, number>(
  PERMISSION_KEY_LIST.map((key, index) => [key, index]),
);

function byRoleOrder(a: RoleRow, b: RoleRow): number {
  return (ROLE_RANK.get(a.key) ?? 0) - (ROLE_RANK.get(b.key) ?? 0);
}
function byPermissionOrder(a: PermissionRow, b: PermissionRow): number {
  return (PERMISSION_RANK.get(a.key) ?? 0) - (PERMISSION_RANK.get(b.key) ?? 0);
}

export function createRbacService(options: RbacServiceOptions): RbacService {
  const { repo } = options;

  return {
    async listRoles() {
      const roles = await repo.listRoles();
      return { items: [...roles].sort(byRoleOrder).map(toRole) };
    },

    async listPermissions() {
      const permissions = await repo.listPermissions();
      return { items: [...permissions].sort(byPermissionOrder).map(toPermission) };
    },

    async getMatrix() {
      const [roles, permissions, grants] = await Promise.all([
        repo.listRoles(),
        repo.listPermissions(),
        repo.listRolePermissions(),
      ]);

      const sortedRoles = [...roles].sort(byRoleOrder);
      const sortedPermissions = [...permissions].sort(byPermissionOrder);

      const roleKeyById = new Map(roles.map((r) => [r.id, r.key]));
      const permissionKeyById = new Map(permissions.map((p) => [p.id, p.key]));

      // Build role key -> permission keys from the SEEDED grants.
      const matrix: Record<string, PermissionKey[]> = {};
      for (const role of sortedRoles) {
        matrix[role.key] = [];
      }
      for (const grant of grants) {
        const roleKey = roleKeyById.get(grant.roleId);
        const permissionKey = permissionKeyById.get(grant.permissionId);
        if (roleKey && permissionKey) {
          matrix[roleKey].push(permissionKey);
        }
      }
      // Order each role's permission list by catalog order for stable output.
      for (const roleKey of Object.keys(matrix)) {
        matrix[roleKey].sort(
          (a, b) => (PERMISSION_RANK.get(a) ?? 0) - (PERMISSION_RANK.get(b) ?? 0),
        );
      }

      return {
        roles: sortedRoles.map(toRole),
        permissions: sortedPermissions.map(toPermission),
        matrix,
      };
    },
  };
}
