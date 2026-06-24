import {
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RoleKey,
} from '@orgistry/contracts';
import { pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { roles, ROLE_IDS } from './organizations';

/**
 * Permission & role-permission persistence (Sprint 5).
 *
 * This schema turns the Sprint 4 role baseline into a permission-first RBAC
 * system. It adds the fixed v1 permission catalog (`permissions`) and the
 * fixed role→permission mapping (`role_permissions`).
 *
 * Source of truth: the catalog and mapping themselves live in
 * `@orgistry/contracts` (`PERMISSION_CATALOG`, `ROLE_PERMISSIONS`). This file
 * derives the SEED rows from those constants so the database, the typed API
 * helpers, and the read-only RBAC endpoints can never disagree.
 *
 * Design rules inherited from the organization schema:
 *  - Public identifiers are prefixed, opaque strings (`perm_`).
 *  - Permission keys are stable machine strings, unique, and read-only in v1 —
 *    there is NO creation/edit/delete surface.
 *  - Roles and permissions are platform-defined; there are no per-organization
 *    custom roles or per-organization permission overrides.
 */

// Shared timestamp helpers — identical to the organization schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Derive a stable, deterministic permission row id from its key. Stable ids keep
 * the seed deterministic across environments and let the role-permission seed
 * reference permissions without a lookup. E.g. `org.read` → `perm_org_read`.
 * These ids are part of the migration contract and must not change.
 */
export function permissionRowId(key: PermissionKey): string {
  return `perm_${key.replace(/\./g, '_')}`;
}

/**
 * Permission catalog. A stable lookup of authorization primitives. Business
 * authorization resolves a membership's role to a set of these keys and checks
 * the key — it never branches on a role name.
 */
export const permissions = pgTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    // Stable machine key (e.g. `members.read`). Uniqueness makes the seed idempotent.
    key: text('key').$type<PermissionKey>().notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_permissions_key').on(table.key)],
);

/**
 * Role→permission mapping. Each row grants one permission to one system role.
 * The composite primary key `(role_id, permission_id)` makes the seed idempotent
 * (`ON CONFLICT DO NOTHING`) and prevents duplicate grants. The mapping is
 * platform-defined and not user-editable.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    // Help the lookup join in `findPermissionKeysForRole` (role → permissions).
    uniqueIndex('uq_role_permissions_role_permission').on(
      table.roleId,
      table.permissionId,
    ),
  ],
);

/**
 * Canonical permission seed, derived from the contracts catalog with stable ids.
 * The seed migration inserts exactly these rows (idempotently).
 */
export const PERMISSION_SEED: ReadonlyArray<{
  id: string;
  key: PermissionKey;
  name: string;
  description: string;
}> = PERMISSION_CATALOG.map((entry) => ({
  id: permissionRowId(entry.key),
  key: entry.key,
  name: entry.name,
  description: entry.description,
}));

/** Map a fixed role key to its seeded role id. */
const ROLE_ID_BY_KEY: Record<RoleKey, string> = {
  owner: ROLE_IDS.owner,
  admin: ROLE_IDS.admin,
  member: ROLE_IDS.member,
  viewer: ROLE_IDS.viewer,
};

/**
 * Canonical role-permission seed, derived from the contracts mapping. One entry
 * per (role, permission) grant. The seed migration inserts exactly these rows.
 */
export const ROLE_PERMISSION_SEED: ReadonlyArray<{
  roleId: string;
  permissionId: string;
}> = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).flatMap((roleKey) =>
  ROLE_PERMISSIONS[roleKey].map((permissionKey) => ({
    roleId: ROLE_ID_BY_KEY[roleKey],
    permissionId: permissionRowId(permissionKey),
  })),
);

export type PermissionRow = typeof permissions.$inferSelect;
export type PermissionInsert = typeof permissions.$inferInsert;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
