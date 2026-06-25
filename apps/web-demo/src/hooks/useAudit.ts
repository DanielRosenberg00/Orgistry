import type {
  AuditActorType,
  AuditEvent,
  AuditEventType,
  AuditListResponse,
  AuditTargetType,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { useSelectedOrganizationId } from '../organization/useOrganization';
import { useCursorQuery } from './useCursorQuery';

/** Client-side audit filter selection. Every field is optional. */
export interface AuditFilters {
  eventType?: AuditEventType;
  actorType?: AuditActorType;
  targetType?: AuditTargetType;
  /** ISO-8601 lower time bound. */
  createdAfter?: string;
  /** ISO-8601 upper time bound. */
  createdBefore?: string;
}

/**
 * List the selected organization's audit events (load-more paginated, filtered).
 *
 * Filters NEVER widen organization scope — the backend applies the route org id
 * independently. Retention metadata (`auditRetentionDays`) is read from the
 * first page; it is a display-only policy value, not the age of returned data.
 */
export function useAuditEvents(filters: AuditFilters) {
  const organizationId = useSelectedOrganizationId();

  const result = useCursorQuery<AuditEvent, AuditListResponse>({
    queryKey: ['audit', organizationId, filters],
    fetchPage: (cursor) =>
      api.get<AuditListResponse>(
        `/v1/organizations/${organizationId}/audit-events`,
        {
          query: {
            cursor,
            eventType: filters.eventType,
            actorType: filters.actorType,
            targetType: filters.targetType,
            createdAfter: filters.createdAfter,
            createdBefore: filters.createdBefore,
          },
        },
      ),
  });

  return {
    ...result,
    auditRetentionDays: result.pages[0]?.meta.auditRetentionDays ?? null,
  };
}
