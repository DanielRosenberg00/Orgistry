import { z } from 'zod';

/**
 * Plan, entitlement & quota contracts (Sprint 7).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the fixed v1 internal demo plan
 * catalog, the typed entitlement/quota keys, and the entitlement values each
 * plan grants. The database seed (`@orgistry/db`) derives its `plans` rows from
 * `PLAN_CATALOG`, the API's entitlement resolver maps a plan key to these
 * values, and the plan/entitlements endpoints return DTOs shaped here — so the
 * database, the typed helpers, and the HTTP surface can never drift.
 *
 * The three concepts Sprint 7 keeps strictly separate:
 *
 *   Permission  — what the USER may do            (RBAC; see `access.ts`).
 *   Entitlement — what the ORGANIZATION'S PLAN allows (boolean feature access).
 *   Quota       — how much of a capability the ORGANIZATION may use (a limit).
 *
 * Hard rules:
 *  - plans are FIXED, code-defined, internal demo plans — there is NO Stripe,
 *    billing provider, subscription, invoice, or payment concept anywhere here,
 *    and no per-organization custom plan or custom entitlement;
 *  - entitlements are NOT generic feature flags — they are a fixed, plan-derived
 *    capability set;
 *  - DTOs never carry persistence-only columns and never accept a
 *    client-controlled entitlement value (entitlements are always resolved
 *    server-side from the organization's plan, never sent by a client).
 */

// ---------------------------------------------------------------------------
// Fixed v1 plan keys
// ---------------------------------------------------------------------------

/**
 * The fixed v1 internal demo plan keys. Stable machine strings; clients and code
 * may branch on them. These mirror `PLAN_KEYS` in `@orgistry/db`; the API
 * asserts the two agree.
 */
export const PLAN_KEYS = {
  free: 'free',
  pro: 'pro',
  business: 'business',
} as const;

export const planKeySchema = z.enum(['free', 'pro', 'business']);
export type PlanKey = z.infer<typeof planKeySchema>;

/** The fixed v1 plan keys in canonical (least → most capable) order. */
export const PLAN_KEY_LIST: readonly PlanKey[] = [
  PLAN_KEYS.free,
  PLAN_KEYS.pro,
  PLAN_KEYS.business,
];

/**
 * The default plan assigned to every newly created organization (personal and
 * team alike). Free is the safe, least-capable default: a new organization
 * starts with the smallest quotas and no premium feature access until an
 * explicit (demo) plan change. See the artifact package for why Free is the
 * default rather than a more generous demo plan.
 */
export const DEFAULT_PLAN_KEY: PlanKey = PLAN_KEYS.free;

// ---------------------------------------------------------------------------
// Fixed v1 entitlement / quota keys
// ---------------------------------------------------------------------------

/**
 * The fixed v1 entitlement/quota keys. These are the stable identifiers used in
 * the entitlements DTO, in quota error details, and by future API key / audit
 * modules. They fall into three categories:
 *
 *   Boolean feature access — `api_keys_access`, `audit_log_access`.
 *   Numeric quota          — `max_members`, `max_projects`, `max_api_keys`.
 *   Modeled policy value    — `audit_retention_days` (returned, not enforced by
 *                             a deletion job in this sprint).
 */
export const ENTITLEMENT_KEYS = {
  maxMembers: 'max_members',
  maxProjects: 'max_projects',
  apiKeysAccess: 'api_keys_access',
  maxApiKeys: 'max_api_keys',
  auditLogAccess: 'audit_log_access',
  auditRetentionDays: 'audit_retention_days',
} as const;

export type EntitlementKey =
  (typeof ENTITLEMENT_KEYS)[keyof typeof ENTITLEMENT_KEYS];

/** All entitlement keys, in catalog order. */
export const ENTITLEMENT_KEY_LIST: readonly EntitlementKey[] =
  Object.values(ENTITLEMENT_KEYS);

export const entitlementKeySchema = z.enum(
  ENTITLEMENT_KEY_LIST as [EntitlementKey, ...EntitlementKey[]],
);

// ---------------------------------------------------------------------------
// Entitlement values
// ---------------------------------------------------------------------------

/**
 * The complete, resolved entitlement value set for a plan. The object keys ARE
 * the typed entitlement keys, so the entitlements DTO and the catalog cannot
 * disagree on naming.
 *
 *  - `max_*` numbers are inclusive ceilings: an organization may hold UP TO this
 *    many of the resource. A value of 0 means the capability is unavailable.
 *  - `*_access` booleans gate a whole feature (independent of any numeric quota).
 *  - `audit_retention_days` is a modeled policy value only — Sprint 7 returns it
 *    but does not run a retention/deletion job.
 */
export const entitlementValuesSchema = z.object({
  max_members: z.number().int().nonnegative(),
  max_projects: z.number().int().nonnegative(),
  api_keys_access: z.boolean(),
  max_api_keys: z.number().int().nonnegative(),
  audit_log_access: z.boolean(),
  audit_retention_days: z.number().int().nonnegative(),
});
export type EntitlementValues = z.infer<typeof entitlementValuesSchema>;

// ---------------------------------------------------------------------------
// Fixed v1 plan catalog (the source of truth)
// ---------------------------------------------------------------------------

/** A single plan catalog entry: a stable key, display metadata, and its values. */
export interface PlanCatalogEntry {
  key: PlanKey;
  /** Short, human display name. */
  name: string;
  /** What the plan offers, in one line. Describes a demo plan, not billing. */
  description: string;
  /** The resolved entitlement values this plan grants. */
  entitlements: EntitlementValues;
}

/**
 * The canonical, fixed v1 internal demo plan catalog.
 *
 * The numeric values follow a deliberate, deterministic demo progression
 * (Free < Pro < Business on every numeric quota; premium features unlock at
 * Pro). They are documented in the Sprint 7 artifact package and are part of
 * the migration/seed contract — changing them is a reviewed change, not a
 * runtime concern. There are no custom or per-organization plans.
 */
export const PLAN_CATALOG: Readonly<Record<PlanKey, PlanCatalogEntry>> = {
  free: {
    key: PLAN_KEYS.free,
    name: 'Free',
    description: 'Starter demo plan with the smallest quotas and no premium features.',
    entitlements: {
      max_members: 3,
      max_projects: 3,
      api_keys_access: false,
      max_api_keys: 0,
      audit_log_access: false,
      audit_retention_days: 0,
    },
  },
  pro: {
    key: PLAN_KEYS.pro,
    name: 'Pro',
    description: 'Growth demo plan with larger quotas, API keys, and audit access.',
    entitlements: {
      max_members: 10,
      max_projects: 20,
      api_keys_access: true,
      max_api_keys: 5,
      audit_log_access: true,
      audit_retention_days: 30,
    },
  },
  business: {
    key: PLAN_KEYS.business,
    name: 'Business',
    description: 'Scale demo plan with the largest quotas and longest audit retention.',
    entitlements: {
      max_members: 50,
      max_projects: 100,
      api_keys_access: true,
      max_api_keys: 25,
      audit_log_access: true,
      audit_retention_days: 90,
    },
  },
};

/** The plan catalog as an ordered list (Free → Pro → Business). */
export const PLAN_CATALOG_LIST: readonly PlanCatalogEntry[] = PLAN_KEY_LIST.map(
  (key) => PLAN_CATALOG[key],
);

/** Resolve a plan key to its fixed entitlement values. Pure; no IO. */
export function entitlementsForPlan(planKey: PlanKey): EntitlementValues {
  return PLAN_CATALOG[planKey].entitlements;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Public Plan DTO. The stable public identifier is the `key`; the internal
 * `plan_…` row id and the raw entitlement columns are never exposed here —
 * resolved entitlement VALUES are returned by the entitlements endpoint, not
 * inline on the plan.
 */
export const planSchema = z.object({
  key: planKeySchema,
  name: z.string(),
  description: z.string(),
});
export type Plan = z.infer<typeof planSchema>;

/**
 * GET /v1/organizations/:organizationId/plan response. The organization's
 * current plan plus assignment timestamps. This is plan STATE, not a billing
 * subscription — there is no provider, status, period, or price field.
 */
export const organizationPlanResponseSchema = z.object({
  organizationId: z.string(),
  plan: planSchema,
  /** When the current plan was assigned to the organization (ISO-8601). */
  assignedAt: z.string(),
  /** When the plan state was last updated (ISO-8601). */
  updatedAt: z.string(),
});
export type OrganizationPlanResponse = z.infer<
  typeof organizationPlanResponseSchema
>;

/**
 * GET /v1/organizations/:organizationId/entitlements response. The resolved
 * entitlement + quota values for the organization, derived server-side from its
 * plan. Clients never send entitlement values; they only read them.
 */
export const entitlementsResponseSchema = z.object({
  organizationId: z.string(),
  planKey: planKeySchema,
  entitlements: entitlementValuesSchema,
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponseSchema>;

/**
 * PATCH /v1/organizations/:organizationId/plan/demo request. The target plan is
 * one of the fixed plan keys; any other value is a validation error. This is a
 * DEMO control only — it switches the organization's internal plan state and
 * triggers NO billing, checkout, subscription, or payment.
 */
export const demoPlanChangeRequestSchema = z.object({
  planKey: planKeySchema,
});
export type DemoPlanChangeRequest = z.infer<typeof demoPlanChangeRequestSchema>;

/**
 * PATCH /v1/organizations/:organizationId/plan/demo response. The updated plan
 * and the newly resolved entitlement values, so a caller sees the effect of the
 * change in one round-trip.
 */
export const demoPlanChangeResponseSchema = z.object({
  organizationId: z.string(),
  plan: planSchema,
  entitlements: entitlementValuesSchema,
});
export type DemoPlanChangeResponse = z.infer<
  typeof demoPlanChangeResponseSchema
>;

// ---------------------------------------------------------------------------
// Error details
// ---------------------------------------------------------------------------

/**
 * Structured `details` carried by a `QUOTA_EXCEEDED` error. Names the exhausted
 * numeric quota and reports the plan limit plus the current usage so a client
 * can explain the failure and prompt an upgrade.
 */
export const quotaErrorDetailsSchema = z.object({
  quota: entitlementKeySchema,
  limit: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
});
export type QuotaErrorDetails = z.infer<typeof quotaErrorDetailsSchema>;

/**
 * Structured `details` carried by an `ENTITLEMENT_REQUIRED` error. Names the
 * boolean feature entitlement the organization's plan does not grant.
 */
export const entitlementErrorDetailsSchema = z.object({
  entitlement: entitlementKeySchema,
});
export type EntitlementErrorDetails = z.infer<
  typeof entitlementErrorDetailsSchema
>;
