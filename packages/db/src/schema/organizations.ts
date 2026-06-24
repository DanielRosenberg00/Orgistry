import { createId } from '@orgistry/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';

/**
 * Organization & membership persistence (Sprint 4).
 *
 * This schema introduces the SaaS tenant layer — the `User -> Organization ->
 * Membership` chain — and the minimum role baseline needed to assign a
 * membership a role. It deliberately stops there:
 *  - No permission catalog, role-permission mapping, or effective-permission
 *    machinery. `roles` is a stable lookup of role identities ONLY.
 *  - No member-management mutation surface (add/remove/role-change). The
 *    membership lifecycle columns exist so those flows can be built later
 *    without a schema redesign, but no endpoint exercises them yet.
 *
 * Design rules inherited from the auth schema:
 *  - Public identifiers are prefixed, opaque strings (`org_`, `mem_`, `role_`).
 *  - Lifecycle state is explicit (`status`, `*_at` timestamps) rather than
 *    inferred.
 *  - The organization ID — never the slug — is the authority boundary. The slug
 *    is a UI-friendly, globally-unique label and must never drive authorization.
 */

// Shared timestamp helpers — identical to the auth schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Organization shape. `personal` is the auto-provisioned workspace every user
 * receives at registration; `team` is created explicitly by an authenticated
 * user.
 */
export type OrganizationType = 'personal' | 'team';

/**
 * Organization lifecycle. Only `active` is produced in Sprint 4; `archived` and
 * `suspended` exist so the lifecycle model is stable and list/read routes can
 * filter on `active` from day one. No endpoint transitions an organization out
 * of `active` yet.
 */
export type OrganizationStatus = 'active' | 'archived' | 'suspended';

/** Membership lifecycle. `removed` is a soft end-state; rows are never deleted. */
export type MembershipStatus = 'active' | 'removed';

/** The fixed v1 role keys. Stable strings; clients/code may branch on them. */
export const ROLE_KEYS = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

/**
 * Stable, human-readable role IDs. Roles are seeded once (idempotently) with
 * these exact IDs so membership assignment can reference a role without a
 * lookup, and so the seed is deterministic across environments. These values
 * are part of the migration baseline and must not change without a migration.
 */
export const ROLE_IDS = {
  owner: 'role_owner',
  admin: 'role_admin',
  member: 'role_member',
  viewer: 'role_viewer',
} as const;

/** Canonical v1 role seed. The seed migration inserts exactly these rows. */
export const ROLE_SEED: ReadonlyArray<{
  id: string;
  key: RoleKey;
  name: string;
  description: string;
}> = [
  {
    id: ROLE_IDS.owner,
    key: ROLE_KEYS.owner,
    name: 'Owner',
    description: 'Full control of the organization.',
  },
  {
    id: ROLE_IDS.admin,
    key: ROLE_KEYS.admin,
    name: 'Admin',
    description: 'Administrative access to the organization.',
  },
  {
    id: ROLE_IDS.member,
    key: ROLE_KEYS.member,
    name: 'Member',
    description: 'Standard member access to the organization.',
  },
  {
    id: ROLE_IDS.viewer,
    key: ROLE_KEYS.viewer,
    name: 'Viewer',
    description: 'Read-only access to the organization.',
  },
];

/**
 * Role baseline. A lookup table of role identities — NOT an authorization
 * system. Sprint 4 reads it only to attach a role to a membership; permission
 * mapping is a deliberate later-sprint concern.
 */
export const roles = pgTable(
  'roles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('role')),
    // Stable machine key (e.g. `owner`). Uniqueness makes the seed idempotent.
    key: text('key').$type<RoleKey>().notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // True for platform-defined roles. Custom per-org roles are a later sprint;
    // this flag reserves the distinction without implementing it.
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_roles_key').on(table.key)],
);

export const organizations = pgTable(
  'organizations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('org')),
    name: text('name').notNull(),
    // Globally-unique, UI-friendly label. Never an authorization input.
    slug: text('slug').notNull(),
    type: text('type').$type<OrganizationType>().notNull(),
    status: text('status')
      .$type<OrganizationStatus>()
      .notNull()
      .default('active'),
    // The user who created the organization. For a personal workspace this is
    // its owner; for a team it is the founding owner.
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Set when an organization is archived (lifecycle flow is a later sprint).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // Slug is globally unique — the authoritative guard for slug collisions.
    uniqueIndex('uq_organizations_slug').on(table.slug),
    index('ix_organizations_created_by').on(table.createdByUserId),
    index('ix_organizations_status').on(table.status),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('mem')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    // Organization-scoped role. References the role baseline; not a permission.
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    status: text('status')
      .$type<MembershipStatus>()
      .notNull()
      .default('active'),
    // Who invited this member, when invitations exist (later sprint). Nullable:
    // a personal-workspace owner and a team founder are not "invited".
    invitedByUserId: text('invited_by_user_id').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft end-state markers for the future member-removal flow.
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByUserId: text('removed_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Core invariant: at most ONE active membership per (user, organization).
    // A partial unique index lets a user re-join after removal (the removed row
    // stays for history) while preventing duplicate active rows. This is the
    // authoritative guard; application code does a friendly pre-check.
    uniqueIndex('uq_memberships_active_user_org')
      .on(table.userId, table.organizationId)
      .where(sql`${table.status} = 'active'`),
    index('ix_memberships_user_id').on(table.userId),
    index('ix_memberships_organization_id').on(table.organizationId),
    index('ix_memberships_role_id').on(table.roleId),
  ],
);

export type RoleRow = typeof roles.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationInsert = typeof organizations.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type MembershipInsert = typeof memberships.$inferInsert;
