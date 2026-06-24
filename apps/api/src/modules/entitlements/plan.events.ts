/**
 * Plan action event types — the internal action-event seam for plan changes.
 *
 * A demo plan change is a meaningful, organization-scoped ACTION. Like the
 * Sprint 5 member-management and Sprint 6 project actions, it is persisted
 * through the existing internal event seam — the `security_events` table, which
 * already carries an `organization_id` column — written INSIDE the same
 * transaction as the plan-state mutation so the record and the change commit
 * together. The table is reused as the durable sink; that is an implementation
 * detail and does NOT commit to a future public audit-log shape.
 *
 * Sprint 7 deliberately does NOT add a user-facing audit-log read API. This is
 * only the internal writer seam a future, permission-gated (`audit_events.read`)
 * audit feature would read from. Metadata is sanitized
 * (`sanitizeSecurityMetadata`) before persistence and must never contain secrets.
 *
 * Event names are dotted and stable, mirroring the auth `SECURITY_EVENT_TYPES`,
 * member `MEMBER_EVENT_TYPES`, and project `PROJECT_EVENT_TYPES` conventions.
 */
export const PLAN_EVENT_TYPES = {
  changedDemo: 'plan.changed_demo',
} as const;

export type PlanEventType =
  (typeof PLAN_EVENT_TYPES)[keyof typeof PLAN_EVENT_TYPES];
