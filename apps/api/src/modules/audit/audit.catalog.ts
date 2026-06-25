import {
  AUDIT_EVENT_TYPES,
  type AuditEventType,
  type AuditTargetType,
} from '@orgistry/contracts';

/**
 * The audit public/persisted mapping layer (Sprint 10).
 *
 * Organization-scoped ACTION events are persisted to the internal
 * `security_events` seam under dotted, stable names owned by their producing
 * modules (Sprints 5–9). Most persisted names are already the public names; the
 * member-management events are the exception — they carry an `org.` prefix
 * internally. Rather than rewrite historical producers, Sprint 10 adds this thin
 * mapping layer so the PUBLIC API stays stable and decoupled from storage.
 *
 * This catalog is also the AUDIT/SECURITY BOUNDARY in code: it is the ALLOWLIST
 * of persisted event names the read API will surface. Authentication/session
 * security events (`auth.*`) and API-key failed-auth security events
 * (`api_key.auth_*`, `api_key.rate_limit_exceeded`) are deliberately absent, so
 * they never leak into the default organization audit stream.
 */

/**
 * Public event type -> persisted event name. The single source of truth; the
 * reverse map and the persisted allowlist are derived from it.
 */
const PUBLIC_TO_PERSISTED: Readonly<Record<AuditEventType, string>> = {
  [AUDIT_EVENT_TYPES.memberRoleChanged]: 'org.member_role_changed',
  [AUDIT_EVENT_TYPES.memberRemoved]: 'org.member_removed',
  [AUDIT_EVENT_TYPES.projectCreated]: 'project.created',
  [AUDIT_EVENT_TYPES.projectUpdated]: 'project.updated',
  [AUDIT_EVENT_TYPES.projectDeleted]: 'project.deleted',
  [AUDIT_EVENT_TYPES.planChangedDemo]: 'plan.changed_demo',
  [AUDIT_EVENT_TYPES.apiKeyCreated]: 'api_key.created',
  [AUDIT_EVENT_TYPES.apiKeyRevoked]: 'api_key.revoked',
  [AUDIT_EVENT_TYPES.invitationCreated]: 'invitation.created',
  [AUDIT_EVENT_TYPES.invitationRevoked]: 'invitation.revoked',
  [AUDIT_EVENT_TYPES.invitationAccepted]: 'invitation.accepted',
  [AUDIT_EVENT_TYPES.membershipCreatedFromInvitation]:
    'membership.created_from_invitation',
};

/** Persisted event name -> public event type. */
const PERSISTED_TO_PUBLIC: Readonly<Record<string, AuditEventType>> =
  Object.fromEntries(
    (Object.entries(PUBLIC_TO_PERSISTED) as [AuditEventType, string][]).map(
      ([publicType, persisted]) => [persisted, publicType],
    ),
  );

/** The target kind each public event type acts upon (event type fully determines it). */
const TARGET_TYPE_BY_EVENT: Readonly<Record<AuditEventType, AuditTargetType>> = {
  [AUDIT_EVENT_TYPES.memberRoleChanged]: 'membership',
  [AUDIT_EVENT_TYPES.memberRemoved]: 'membership',
  [AUDIT_EVENT_TYPES.projectCreated]: 'project',
  [AUDIT_EVENT_TYPES.projectUpdated]: 'project',
  [AUDIT_EVENT_TYPES.projectDeleted]: 'project',
  [AUDIT_EVENT_TYPES.planChangedDemo]: 'plan',
  [AUDIT_EVENT_TYPES.apiKeyCreated]: 'api_key',
  [AUDIT_EVENT_TYPES.apiKeyRevoked]: 'api_key',
  [AUDIT_EVENT_TYPES.invitationCreated]: 'invitation',
  [AUDIT_EVENT_TYPES.invitationRevoked]: 'invitation',
  [AUDIT_EVENT_TYPES.invitationAccepted]: 'invitation',
  [AUDIT_EVENT_TYPES.membershipCreatedFromInvitation]: 'membership',
};

/** The full allowlist of persisted action-event names the read API exposes. */
export const AUDITABLE_PERSISTED_EVENT_TYPES: readonly string[] =
  Object.values(PUBLIC_TO_PERSISTED);

/** Translate a persisted event name to its public type, or null if not auditable. */
export function toPublicEventType(persisted: string): AuditEventType | null {
  return PERSISTED_TO_PUBLIC[persisted] ?? null;
}

/** Translate a public event type to its persisted name. */
export function toPersistedEventType(publicType: AuditEventType): string {
  return PUBLIC_TO_PERSISTED[publicType];
}

/** The target kind for a public event type (or `unknown` for an unmapped name). */
export function targetTypeForEvent(publicType: string): AuditTargetType {
  return TARGET_TYPE_BY_EVENT[publicType as AuditEventType] ?? 'unknown';
}

/**
 * Resolve the set of persisted event names a list query should match, given the
 * optional public `eventType` and `targetType` filters. Returns the intersection
 * of:
 *  - the full auditable allowlist (always applied — the security boundary),
 *  - the single event type (when `eventType` is set),
 *  - all event types whose target kind matches (when `targetType` is set).
 *
 * An empty array means the filters select nothing — the caller returns an empty
 * page WITHOUT querying. This keeps `targetType` filtering precise and
 * index-friendly (it filters the indexed `event_type` column, never JSON).
 */
export function resolvePersistedEventTypes(filters: {
  eventType?: AuditEventType | null;
  targetType?: AuditTargetType | null;
}): string[] {
  let publicTypes = Object.keys(PUBLIC_TO_PERSISTED) as AuditEventType[];

  if (filters.eventType) {
    publicTypes = publicTypes.filter((t) => t === filters.eventType);
  }
  if (filters.targetType) {
    publicTypes = publicTypes.filter(
      (t) => TARGET_TYPE_BY_EVENT[t] === filters.targetType,
    );
  }

  return publicTypes.map((t) => PUBLIC_TO_PERSISTED[t]);
}
