import type { Database } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { and, desc, eq, gte, inArray, lte, lt, or, sql } from 'drizzle-orm';
import type {
  AuditEventRecord,
  AuditRepository,
  ListAuditEventsParams,
} from './audit.types';

/**
 * Drizzle-backed audit READ repository over the internal `security_events` seam.
 *
 * This is a pure query boundary. Every method:
 *  1. requires an organization id and scopes the query by it FIRST (tenant
 *     isolation is structural — there is no cross-tenant lookup path here);
 *  2. restricts to the auditable persisted event names the service supplies
 *     (the action/security boundary — never the raw event universe);
 *  3. applies the validated filters and keyset pagination;
 *  4. returns NORMALIZED records, never raw rows, and never the columns the
 *     audit API does not expose (ip address, user agent, session id).
 *
 * It owns NO permission or entitlement policy and mutates nothing.
 *
 * Ordering is `created_at DESC, id DESC` — stable and total (id breaks
 * created_at ties), matching the keyset cursor so pages never duplicate or skip.
 */

/** Metadata keys that may carry a target id, matched by the `targetId` filter. */
const TARGET_ID_METADATA_KEYS = [
  'targetProjectId',
  'targetKeyId',
  'targetInvitationId',
  'targetMembershipId',
  'membershipId',
] as const;

export function createDbAuditRepository(db: Database): AuditRepository {
  return {
    async listAuditEvents(
      params: ListAuditEventsParams,
    ): Promise<AuditEventRecord[]> {
      // Keyset clause on (created_at desc, id desc), matching the order below.
      const cursorClause = params.cursor
        ? or(
            lt(schema.securityEvents.createdAt, new Date(params.cursor.createdAtMs)),
            and(
              eq(
                schema.securityEvents.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.securityEvents.id, params.cursor.id),
            ),
          )
        : undefined;

      // The `targetId` filter matches the value across the known target-id
      // metadata keys (each event type uses exactly one). Bounded OR — no
      // free-text search.
      const targetIdClause = params.targetId
        ? or(
            ...TARGET_ID_METADATA_KEYS.map(
              (key) =>
                sql`${schema.securityEvents.metadata} ->> ${key} = ${params.targetId}`,
            ),
          )
        : undefined;

      const conditions = [
        // Tenant scope first — the authoritative boundary.
        eq(schema.securityEvents.organizationId, params.organizationId),
        // Action/security boundary: only the auditable persisted names.
        inArray(schema.securityEvents.eventType, [...params.eventTypes]),
        ...(params.actorType
          ? [eq(schema.securityEvents.actorType, params.actorType)]
          : []),
        ...(params.actorId
          ? [eq(schema.securityEvents.userId, params.actorId)]
          : []),
        ...(params.createdAfter
          ? [gte(schema.securityEvents.createdAt, params.createdAfter)]
          : []),
        ...(params.createdBefore
          ? [lte(schema.securityEvents.createdAt, params.createdBefore)]
          : []),
        ...(targetIdClause ? [targetIdClause] : []),
        ...(cursorClause ? [cursorClause] : []),
      ];

      const rows = await db
        .select({
          id: schema.securityEvents.id,
          organizationId: schema.securityEvents.organizationId,
          eventType: schema.securityEvents.eventType,
          actorType: schema.securityEvents.actorType,
          userId: schema.securityEvents.userId,
          metadata: schema.securityEvents.metadata,
          requestId: schema.securityEvents.requestId,
          createdAt: schema.securityEvents.createdAt,
        })
        .from(schema.securityEvents)
        .where(and(...conditions))
        .orderBy(desc(schema.securityEvents.createdAt), desc(schema.securityEvents.id))
        .limit(params.limit + 1);

      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        eventType: row.eventType,
        actorType: row.actorType,
        actorUserId: row.userId,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        requestId: row.requestId,
        createdAt: row.createdAt,
      }));
    },
  };
}
