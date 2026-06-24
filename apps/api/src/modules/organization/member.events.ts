/**
 * Organization member-management audit event types — the audit seam.
 *
 * Member role changes and removals are meaningful administrative actions. Sprint
 * 5 does NOT build a user-facing organization audit log; instead it records these
 * actions as durable, organization-scoped rows in the existing `security_events`
 * table (which already carries an `organization_id` column), written INSIDE the
 * same transaction as the mutation so the record and the change commit together.
 *
 * This is the seam a future organization audit-log feature attaches to: it would
 * read these (and future) organization-scoped events and expose them through a
 * dedicated, permission-gated (`audit_events.read`) surface. No such read API
 * exists yet, by design.
 *
 * Event names are dotted and stable, mirroring the auth `SECURITY_EVENT_TYPES`
 * convention so they stay understandable to whoever reads them later.
 */
export const MEMBER_EVENT_TYPES = {
  memberRoleChanged: 'org.member_role_changed',
  memberRemoved: 'org.member_removed',
} as const;

export type MemberEventType =
  (typeof MEMBER_EVENT_TYPES)[keyof typeof MEMBER_EVENT_TYPES];
