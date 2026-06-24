import { z } from 'zod';

/**
 * Organization API contracts (Sprint 4).
 *
 * These DTOs are the stable boundary between the API and any client for the
 * organization foundation. They describe request validation and response shapes
 * only — never database rows. Hard rules carried over from the auth contracts:
 *  - no response field ever carries a persistence-only column (no
 *    `createdByUserId`, no soft-delete/archive internals beyond `status`);
 *  - no permission fields appear anywhere — permissions are a deliberate
 *    later-sprint concern and adding a field here is a reviewed contract change.
 */

/** Maximum lengths guard against denial-of-service via oversized inputs. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100;
export const MAX_ORGANIZATION_SLUG_LENGTH = 48;

/**
 * Slug format: lowercase alphanumeric segments joined by single hyphens. This
 * is the shape the server generates and the only shape a client may request.
 * The slug is a UI-friendly label and is NEVER an authorization input.
 */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `personal` is the auto-provisioned workspace; `team` is user-created. */
export const organizationTypeSchema = z.enum(['personal', 'team']);
export type OrganizationType = z.infer<typeof organizationTypeSchema>;

/**
 * Organization lifecycle. Only `active` is produced in Sprint 4; the other
 * states are part of the stable enum so the lifecycle model does not change
 * shape when those flows arrive.
 */
export const organizationStatusSchema = z.enum([
  'active',
  'archived',
  'suspended',
]);
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;

/** Membership lifecycle exposed to clients. */
export const membershipStatusSchema = z.enum(['active', 'removed']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/**
 * Minimal, secret-free view of a role. Exposes identity only (id, machine key,
 * display name) — NEVER permissions. The role is the membership's
 * organization-scoped role baseline.
 */
export const roleSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

/**
 * Public representation of an organization. This is the ONLY organization shape
 * that crosses the API boundary — it intentionally omits `createdByUserId` and
 * archive internals. The `id` is the authority boundary; `slug` is display-only.
 */
export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: organizationTypeSchema,
  status: organizationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;

/**
 * The caller's membership context for an organization. Carries enough to drive
 * a future workspace switcher (which org, what role, since when) without
 * exposing other members or any permission data.
 */
export const membershipSummarySchema = z.object({
  id: z.string(),
  status: membershipStatusSchema,
  role: roleSummarySchema,
  joinedAt: z.string(),
  createdAt: z.string(),
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/**
 * POST /v1/organizations request body. `slug` is optional: when omitted the
 * server derives a unique slug from the name; when provided it must be unique
 * (a taken slug is a CONFLICT, never silently changed).
 */
export const organizationCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ORGANIZATION_NAME_LENGTH),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ORGANIZATION_SLUG_LENGTH)
    .regex(
      ORGANIZATION_SLUG_PATTERN,
      'Slug must be lowercase alphanumeric segments separated by single hyphens',
    )
    .optional(),
});
export type OrganizationCreateRequest = z.infer<
  typeof organizationCreateRequestSchema
>;

/**
 * Organization + the caller's membership in it. Shared by create, read, and
 * each list item so a client always receives the same pairing.
 */
export const organizationWithMembershipSchema = z.object({
  organization: organizationSchema,
  membership: membershipSummarySchema,
});
export type OrganizationWithMembership = z.infer<
  typeof organizationWithMembershipSchema
>;

/** POST /v1/organizations response body. */
export const organizationCreateResponseSchema =
  organizationWithMembershipSchema;
export type OrganizationCreateResponse = z.infer<
  typeof organizationCreateResponseSchema
>;

/** GET /v1/organizations/:organizationId response body. */
export const organizationReadResponseSchema = organizationWithMembershipSchema;
export type OrganizationReadResponse = z.infer<
  typeof organizationReadResponseSchema
>;

/**
 * GET /v1/organizations response body. Cursor-paginated list of the active
 * organizations where the caller has an active membership (the platform
 * standardizes list endpoints on opaque cursor pagination — see the session
 * list contract).
 */
export const organizationListResponseSchema = z.object({
  items: z.array(organizationWithMembershipSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type OrganizationListResponse = z.infer<
  typeof organizationListResponseSchema
>;
