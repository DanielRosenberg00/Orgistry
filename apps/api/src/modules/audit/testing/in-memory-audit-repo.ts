import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import type {
  AuditEventRecord,
  AuditRepository,
  ListAuditEventsParams,
} from '../audit.types';

/**
 * In-memory audit READ repository over the shared org store's `securityEvents`
 * array — the test mirror of `createDbAuditRepository`.
 *
 * It applies the SAME tenant scope + allowlist + filters + keyset pagination +
 * `created_at DESC, id DESC` ordering as the database repository, so route tests
 * exercise real behavior. Producer fakes (Sprints 5–9) push events without an
 * id/createdAt; this repo synthesizes deterministic, monotonic values from
 * insertion order so ordering is stable. Tests that need precise control over
 * time/identity seed events with explicit `id` and `createdAt`.
 */

/** The same target-id metadata keys the DB repo matches for the `targetId` filter. */
const TARGET_ID_METADATA_KEYS = [
  'targetProjectId',
  'targetKeyId',
  'targetInvitationId',
  'targetMembershipId',
  'membershipId',
] as const;

export function createInMemoryAuditRepository(
  store: InMemoryOrgStore,
): AuditRepository {
  return {
    async listAuditEvents(
      params: ListAuditEventsParams,
    ): Promise<AuditEventRecord[]> {
      const allowed = new Set(params.eventTypes);

      // Normalize first so id/createdAt are stable for filtering AND ordering.
      const normalized: AuditEventRecord[] = store.securityEvents.map(
        (event, index) => ({
          id: event.id ?? `sevt_seed_${index}`,
          organizationId: event.organizationId,
          eventType: event.eventType,
          actorType: event.actorType,
          actorUserId: event.userId,
          metadata: event.metadata ?? {},
          requestId: event.requestId,
          // Monotonic with insertion order when the producer fake omitted it.
          createdAt: event.createdAt ?? new Date(index + 1),
        }),
      );

      const filtered = normalized.filter((record) => {
        if (record.organizationId !== params.organizationId) return false;
        if (!allowed.has(record.eventType)) return false;
        if (params.actorType && record.actorType !== params.actorType) {
          return false;
        }
        if (params.actorId && record.actorUserId !== params.actorId) {
          return false;
        }
        if (
          params.createdAfter &&
          record.createdAt.getTime() < params.createdAfter.getTime()
        ) {
          return false;
        }
        if (
          params.createdBefore &&
          record.createdAt.getTime() > params.createdBefore.getTime()
        ) {
          return false;
        }
        if (params.targetId && !matchesTargetId(record, params.targetId)) {
          return false;
        }
        return true;
      });

      // created_at DESC, id DESC — total order, matching the keyset cursor.
      filtered.sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

      const afterCursor = params.cursor
        ? filtered.filter((record) => {
            const created = record.createdAt.getTime();
            const cursorMs = params.cursor!.createdAtMs;
            if (created < cursorMs) return true;
            return created === cursorMs && record.id < params.cursor!.id;
          })
        : filtered;

      return afterCursor.slice(0, params.limit + 1);
    },
  };
}

function matchesTargetId(record: AuditEventRecord, targetId: string): boolean {
  return TARGET_ID_METADATA_KEYS.some(
    (key) => record.metadata[key] === targetId,
  );
}
