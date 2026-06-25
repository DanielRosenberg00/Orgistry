import { z } from 'zod';
import { cursorPageParamsSchema } from './pagination';

/**
 * Audit Log read API contracts (Sprint 10) — the stable public boundary for
 * reading an organization's audit/action events.
 *
 * Sprint 10 does NOT introduce a new event system. Organization-scoped ACTION
 * events have been written to the internal `security_events` seam since Sprints
 * 5–9 (member, project, plan, API key, and invitation lifecycle actions). This
 * module defines the read-side public shapes only; the API maps the internal
 * persisted rows onto these DTOs and never exposes a raw persistence row.
 *
 * Hard rules carried over from every prior domain contract:
 *  - no response field carries a persistence-only column or any secret material;
 *  - authorization is by permission key (`audit_events.read`) and entitlement
 *    (`audit_log_access`), enforced server-side — neither appears in this shape;
 *  - the organization id is the authority boundary and comes from the route,
 *    never from a request body.
 */

// ---------------------------------------------------------------------------
// Event category & public event-type catalog
// ---------------------------------------------------------------------------

/**
 * The category of an audit event as PRESENTED to clients. v1 exposes only
 * organization-scoped `action` events. `security` is reserved: authentication /
 * session security events are NOT part of the default audit stream (see the
 * audit-log design doc for the boundary). Modeling it as an enum keeps the field
 * stable when a future sprint safely organization-attributes security events.
 */
export const auditEventCategorySchema = z.enum(['action']);
export type AuditEventCategory = z.infer<typeof auditEventCategorySchema>;

/**
 * Public audit/action event types. These are the STABLE names clients branch on.
 * They are decoupled from the internally persisted event names: the API owns a
 * mapping layer (some persisted names differ, e.g. the member events carry an
 * `org.` prefix internally). Adding a public type here is a reviewed contract
 * change; renaming one is a breaking change requiring a migration/review.
 */
export const AUDIT_EVENT_TYPES = {
  memberRoleChanged: 'member.role_changed',
  memberRemoved: 'member.removed',
  projectCreated: 'project.created',
  projectUpdated: 'project.updated',
  projectDeleted: 'project.deleted',
  planChangedDemo: 'plan.changed_demo',
  apiKeyCreated: 'api_key.created',
  apiKeyRevoked: 'api_key.revoked',
  invitationCreated: 'invitation.created',
  invitationRevoked: 'invitation.revoked',
  invitationAccepted: 'invitation.accepted',
  membershipCreatedFromInvitation: 'membership.created_from_invitation',
} as const;

export type AuditEventType =
  (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];

export const AUDIT_EVENT_TYPE_LIST: readonly AuditEventType[] = Object.values(
  AUDIT_EVENT_TYPES,
);

export const auditEventTypeSchema = z.enum(
  AUDIT_EVENT_TYPE_LIST as [AuditEventType, ...AuditEventType[]],
);

// ---------------------------------------------------------------------------
// Actor & target summaries
// ---------------------------------------------------------------------------

/**
 * Public actor types. `user` is an organization member acting; `api_key` is a
 * machine actor; `system` is a platform-initiated action; `unknown` is an
 * unauthenticated/unattributable actor. The reader never invents identity — an
 * incomplete event stays `unknown`.
 */
export const auditActorTypeSchema = z.enum([
  'user',
  'api_key',
  'system',
  'unknown',
]);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

/**
 * Safe, derived view of who performed an event. Only non-secret identifiers
 * appear: the opaque user id (when a user actor), the actor's membership id
 * (when known), and the API key id (when an api_key actor). `label` is an
 * optional display string when one is safely available. Fields that do not
 * apply to the actor type are null — never fabricated.
 */
export const auditActorSummarySchema = z.object({
  type: auditActorTypeSchema,
  userId: z.string().nullable(),
  membershipId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  label: z.string().nullable(),
});
export type AuditActorSummary = z.infer<typeof auditActorSummarySchema>;

/**
 * Public target types — the kind of resource an event acted upon. `plan` maps
 * from the internally persisted `organization_plan` target; `unknown` covers an
 * event whose target cannot be safely classified.
 */
export const auditTargetTypeSchema = z.enum([
  'membership',
  'project',
  'plan',
  'api_key',
  'invitation',
  'organization',
  'unknown',
]);
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

/**
 * Safe, derived view of what an event acted upon. `id` is the opaque target id
 * when one exists; `label` is an optional non-secret display string (e.g. the
 * new plan key for a plan change). No secret-bearing target metadata appears.
 */
export const auditTargetSummarySchema = z.object({
  type: auditTargetTypeSchema,
  id: z.string().nullable(),
  label: z.string().nullable(),
});
export type AuditTargetSummary = z.infer<typeof auditTargetSummarySchema>;

// ---------------------------------------------------------------------------
// Audit event DTO
// ---------------------------------------------------------------------------

/**
 * Public representation of a single audit event. This is the ONLY audit-event
 * shape that crosses the API boundary.
 *
 *  - `id` / `organizationId` are opaque authority identifiers;
 *  - `type` is a public `AuditEventType` (mapped from the persisted name);
 *  - `category` is `action` in v1;
 *  - `actor` / `target` are safe derived summaries;
 *  - `metadata` is the event's structured context AFTER defensive sanitization
 *    (secrets, tokens, hashes, cookies, and Authorization headers are removed) —
 *    it is never the raw persistence row and never a full request body;
 *  - `requestId` correlates the event to the originating request when recorded;
 *  - `createdAt` is an ISO-8601 timestamp.
 */
export const auditEventSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.string(),
  category: auditEventCategorySchema,
  actor: auditActorSummarySchema,
  target: auditTargetSummarySchema,
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ---------------------------------------------------------------------------
// List query (filters + cursor pagination)
// ---------------------------------------------------------------------------

/**
 * GET …/audit-events query params. Extends the platform cursor-pagination
 * baseline (opaque cursor + bounded limit) with the v1 audit filters. Every
 * filter is optional and validated here; an invalid value is a VALIDATION_ERROR.
 * Filters NEVER widen organization scope — the route organization id is applied
 * independently and always.
 *
 *  - `eventType`  — restrict to a single public event type;
 *  - `actorType`  — restrict by actor kind;
 *  - `targetType` — restrict by target kind;
 *  - `actorId`    — restrict to a single acting user id (optional);
 *  - `targetId`   — restrict to a single target id (optional);
 *  - `createdAfter` / `createdBefore` — ISO-8601 time-range bounds.
 */
export const auditListQuerySchema = cursorPageParamsSchema.extend({
  eventType: auditEventTypeSchema.optional(),
  actorType: auditActorTypeSchema.optional(),
  targetType: auditTargetTypeSchema.optional(),
  actorId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/** Route params for the audit list surface. The org id is the authority boundary. */
export const auditRouteParamsSchema = z.object({
  organizationId: z.string().min(1),
});
export type AuditRouteParams = z.infer<typeof auditRouteParamsSchema>;

// ---------------------------------------------------------------------------
// List response (+ metadata)
// ---------------------------------------------------------------------------

/**
 * Response metadata for an audit page. `auditRetentionDays` is the organization
 * plan's modeled retention window. IMPORTANT: it is DISPLAY-ONLY in v1 — Sprint
 * 10 does not delete events, does not enforce retention, and runs no cleanup
 * job. The value reflects policy, not the age of returned data.
 */
export const auditListResponseMetaSchema = z.object({
  auditRetentionDays: z.number().int().nonnegative(),
});
export type AuditListResponseMeta = z.infer<typeof auditListResponseMetaSchema>;

/**
 * GET …/audit-events response body — a cursor-paginated page of audit events
 * plus retention metadata. `nextCursor` is null when there are no more events.
 */
export const auditListResponseSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: auditListResponseMetaSchema,
});
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;
