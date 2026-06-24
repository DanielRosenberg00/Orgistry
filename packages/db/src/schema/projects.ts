import { createId } from '@orgistry/shared';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './organizations';

/**
 * Project persistence (Sprint 6) — the first organization-scoped business
 * resource.
 *
 * Projects prove the tenant-scoped resource pattern; they are intentionally
 * minimal. Every project belongs to exactly ONE organization and is only ever
 * addressed WITHIN it — the `organization_id` is the tenant authority boundary,
 * never trusted from a request body.
 *
 * Design rules inherited from the organization schema:
 *  - Public identifiers are prefixed, opaque strings (`prj_`).
 *  - Lifecycle is explicit: deletion is a SOFT delete (`deleted_at` +
 *    `deleted_by_user_id`); rows are never hard-deleted, and there is no
 *    hard-delete or restore surface. Active queries filter `deleted_at IS NULL`.
 */

// Shared timestamp helpers — identical to the organization schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable(
  'projects',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('prj')),
    // The owning tenant. Every active query is scoped by this column; it is the
    // authority boundary and is taken from the route, never a request body.
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    // The actor that created the project (recorded from the authenticated user).
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id),
    // Soft-delete markers. A null `deleted_at` means the project is active; a
    // set value means it is excluded from every active list/read/update/delete
    // flow. `deleted_by_user_id` records who deleted it.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: text('deleted_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Primary list/pagination access path: list one organization's ACTIVE
    // projects ordered by (created_at desc, id desc). The partial predicate
    // (`deleted_at IS NULL`) keeps the index aligned with active filtering so
    // soft-deleted rows never bloat the keyset scan.
    index('ix_projects_org_created_active')
      .on(table.organizationId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    // Tenant-scoped point lookup: resolve a project by (organization_id, id).
    // This is the only lookup shape the repository exposes — a project is never
    // fetched by id alone in an organization-scoped flow.
    index('ix_projects_org_id').on(table.organizationId, table.id),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
