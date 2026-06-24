/**
 * Project action event types — the internal action-event seam for Projects.
 *
 * Project create/update/delete are meaningful, organization-scoped ACTIONS (not
 * security/authentication events). Like the Sprint 5 member-management actions,
 * they are *currently persisted through the existing internal event seam* — the
 * `security_events` table, which already carries an `organization_id` column —
 * written INSIDE the same transaction as the mutation so the record and the
 * change commit together. The table is reused as the durable sink; that is an
 * implementation detail and does NOT commit to a future public audit-log shape.
 *
 * Sprint 6 deliberately does NOT add a user-facing audit-log read API. This is
 * only the internal writer seam a future, permission-gated (`audit_events.read`)
 * audit feature would read from. Metadata is sanitized
 * (`sanitizeSecurityMetadata`) before persistence and must never contain secrets
 * or full request bodies.
 *
 * Event names are dotted and stable, mirroring the auth `SECURITY_EVENT_TYPES`
 * and member `MEMBER_EVENT_TYPES` conventions.
 */
export const PROJECT_EVENT_TYPES = {
  created: 'project.created',
  updated: 'project.updated',
  deleted: 'project.deleted',
} as const;

export type ProjectEventType =
  (typeof PROJECT_EVENT_TYPES)[keyof typeof PROJECT_EVENT_TYPES];
