import { PLAN_CATALOG_LIST, type PlanKey } from '@orgistry/contracts';
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './organizations';

/**
 * Plan & organization-plan-state persistence (Sprint 7).
 *
 * This schema adds the fixed v1 internal demo plan catalog (`plans`) and the
 * per-organization current-plan record (`organization_plans`). Together they
 * extend the access chain from RBAC to entitlements/quotas:
 *
 *   User → Organization → Membership → Role → Permission
 *        → Entitlement → Quota → Organization-Scoped Resource
 *
 * Source of truth: the catalog itself lives in `@orgistry/contracts`
 * (`PLAN_CATALOG`). This file derives the SEED rows from that constant so the
 * database, the typed entitlement resolver, and the plan/entitlements endpoints
 * can never disagree.
 *
 * Hard rules carried over from the permissions schema:
 *  - public identifiers are prefixed, opaque strings (`plan_`, `oplan_`);
 *  - plan keys are stable machine strings, unique, and read-only in v1 — there
 *    is NO plan create/update/delete surface;
 *  - plans are platform-defined internal DEMO plans. There is NO Stripe, billing
 *    provider, subscription, invoice, or payment concept in this schema. The
 *    `organization_plans` columns are deliberately billing-agnostic so a future
 *    billing integration can map external state INTO `plan_key` / `changed_by_user_id`
 *    without a schema redesign — but no such integration exists here.
 */

// Shared timestamp helpers — identical to the organization schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** The fixed v1 plan keys, re-exported from contracts for schema-side use. */
export { PLAN_KEYS, DEFAULT_PLAN_KEY } from '@orgistry/contracts';
export type { PlanKey } from '@orgistry/contracts';

/**
 * Derive a stable, deterministic plan row id from its key. Stable ids keep the
 * seed deterministic across environments and let `organization_plans` reference
 * a plan by a known id. E.g. `pro` → `plan_pro`. These ids are part of the
 * migration contract and must not change.
 */
export function planRowId(key: PlanKey): string {
  return `plan_${key}`;
}

/**
 * Plan catalog. A stable lookup of internal demo plans and the entitlement /
 * quota values each grants. The entitlement resolver maps an organization's
 * current plan key to these columns; it never branches on a plan name.
 */
export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    // Stable machine key (e.g. `pro`). Uniqueness makes the seed idempotent.
    key: text('key').$type<PlanKey>().notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // Numeric quotas — inclusive ceilings (0 = capability unavailable).
    maxMembers: integer('max_members').notNull(),
    maxProjects: integer('max_projects').notNull(),
    // Boolean feature access.
    apiKeysAccess: boolean('api_keys_access').notNull(),
    maxApiKeys: integer('max_api_keys').notNull(),
    auditLogAccess: boolean('audit_log_access').notNull(),
    // Modeled policy value (returned, not enforced by a deletion job in v1).
    auditRetentionDays: integer('audit_retention_days').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_plans_key').on(table.key)],
);

/**
 * Organization plan state. The current plan for one organization, plus
 * assignment provenance. Exactly one row per organization (enforced by the
 * unique index). The plan belongs to the ORGANIZATION, not to any user, and is
 * independent of the user's membership role.
 *
 * `changed_by_user_id` records who last set the plan (the founder at creation,
 * or the actor of a later demo plan change). It is the seam a future billing
 * integration would also write through; no billing exists in v1.
 */
export const organizationPlans = pgTable(
  'organization_plans',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    // Current plan, referenced by its stable plan key.
    planKey: text('plan_key').$type<PlanKey>().notNull(),
    // When the current plan was first assigned to the organization.
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who last set the plan (creator at provisioning, or demo-change actor).
    // Nullable so a system/backfilled assignment is representable.
    changedByUserId: text('changed_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Core invariant: exactly ONE plan-state row per organization.
    uniqueIndex('uq_organization_plans_organization').on(table.organizationId),
  ],
);

/**
 * Canonical plan seed, derived from the contracts catalog with stable ids. The
 * seed migration inserts exactly these rows (idempotently via ON CONFLICT).
 */
export const PLAN_SEED: ReadonlyArray<{
  id: string;
  key: PlanKey;
  name: string;
  description: string;
  maxMembers: number;
  maxProjects: number;
  apiKeysAccess: boolean;
  maxApiKeys: number;
  auditLogAccess: boolean;
  auditRetentionDays: number;
}> = PLAN_CATALOG_LIST.map((entry) => ({
  id: planRowId(entry.key),
  key: entry.key,
  name: entry.name,
  description: entry.description,
  maxMembers: entry.entitlements.max_members,
  maxProjects: entry.entitlements.max_projects,
  apiKeysAccess: entry.entitlements.api_keys_access,
  maxApiKeys: entry.entitlements.max_api_keys,
  auditLogAccess: entry.entitlements.audit_log_access,
  auditRetentionDays: entry.entitlements.audit_retention_days,
}));

export type PlanRow = typeof plans.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;
export type OrganizationPlanRow = typeof organizationPlans.$inferSelect;
export type OrganizationPlanInsert = typeof organizationPlans.$inferInsert;
