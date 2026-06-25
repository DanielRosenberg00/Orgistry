/**
 * Invitation action event types — the internal action-event seam for Sprint 9.
 *
 * Invitation create/revoke/accept and the membership created by an acceptance
 * are meaningful, organization-scoped ACTIONS (not authentication/security
 * events). Like the Sprint 5/6/8 member/project/api-key actions, they are
 * persisted through the existing internal event sink — the `security_events`
 * table, which already carries an `organization_id` column — written INSIDE the
 * same transaction as the mutation so the record and the change commit together.
 * Reusing that table is an implementation detail and does NOT commit to a public
 * audit-log shape; Sprint 9 deliberately adds NO user-facing audit-log read API.
 *
 * Metadata is sanitized (`sanitizeSecurityMetadata`) before persistence and must
 * NEVER contain the raw invitation token, the token hash, passwords, refresh
 * tokens, API key secrets, cookies, or full request bodies.
 *
 * Event names are dotted and stable, mirroring the auth `SECURITY_EVENT_TYPES`,
 * member `MEMBER_EVENT_TYPES`, project `PROJECT_EVENT_TYPES`, and api-key
 * `API_KEY_EVENT_TYPES` conventions.
 */
export const INVITATION_EVENT_TYPES = {
  created: 'invitation.created',
  revoked: 'invitation.revoked',
  accepted: 'invitation.accepted',
  /**
   * A membership created as the direct result of accepting an invitation.
   * Recorded ALONGSIDE `invitation.accepted` in the same acceptance transaction
   * so the membership's provenance (an invitation, not a self-service join) is
   * always durable.
   */
  membershipCreatedFromInvitation: 'membership.created_from_invitation',
} as const;

export type InvitationEventType =
  (typeof INVITATION_EVENT_TYPES)[keyof typeof INVITATION_EVENT_TYPES];
