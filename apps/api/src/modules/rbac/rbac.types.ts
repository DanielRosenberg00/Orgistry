import type { PermissionRow, RoleRow } from '@orgistry/db';

/**
 * Internal RBAC-module types.
 *
 * The RBAC read surface (roles / permissions / matrix) returns the FIXED,
 * SEEDED reference data. `RoleRow`/`PermissionRow` are persistence shapes used
 * inside the module only; the service maps them to public DTOs.
 */

/** One seeded role→permission grant (by id). */
export interface RolePermissionPair {
  roleId: string;
  permissionId: string;
}

/**
 * Persistence boundary for the RBAC reference reads. Everything is read-only:
 * roles and permissions are fixed in v1 and have no mutation surface.
 *
 * The matrix endpoint is built from `listRolePermissions()` (the SEEDED rows),
 * so it always reflects exactly what `requirePermission` enforces — it can never
 * drift from a separate hardcoded presentation.
 */
export interface RbacRepository {
  /** All seeded roles. */
  listRoles(): Promise<RoleRow[]>;
  /** The full seeded permission catalog. */
  listPermissions(): Promise<PermissionRow[]>;
  /** Every seeded role→permission grant. */
  listRolePermissions(): Promise<RolePermissionPair[]>;
}
