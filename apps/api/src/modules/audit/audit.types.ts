import type { SecurityActorType } from '@orgistry/db';

/**
 * The audit READ boundary types.
 *
 * The repository is a pure query boundary over the internal `security_events`
 * seam: it requires an organization id, applies tenant scope + filters +
 * keyset pagination, and returns a NORMALIZED record (never a raw Drizzle row to
 * the route). It owns NO permission or entitlement policy — those live in the
 * service.
 */

/** Keyset cursor position decoded from the opaque page cursor. */
export interface AuditCursor {
  /** `created_at` epoch milliseconds of the last item on the previous page. */
  createdAtMs: number;
  /** Event id of the last item on the previous page (tiebreak). */
  id: string;
}

/** Tenant-scoped query parameters for one page of audit events. */
export interface ListAuditEventsParams {
  /** The authoritative tenant boundary. Required — never optional. */
  organizationId: string;
  /** Page size; the repository fetches `limit + 1` to detect a next page. */
  limit: number;
  /** Keyset position, or null for the first page. */
  cursor: AuditCursor | null;
  /**
   * The persisted event names to match — the auditable allowlist intersected
   * with the event-type/target-type filters. Never empty (the service skips the
   * query when the filters select nothing).
   */
  eventTypes: readonly string[];
  /** Restrict to a single persisted actor-type column value, or null. */
  actorType: SecurityActorType | null;
  /** Restrict to a single acting user id, or null. */
  actorId: string | null;
  /** Restrict to a single target id (matched across known metadata keys), or null. */
  targetId: string | null;
  /** Inclusive lower time bound, or null. */
  createdAfter: Date | null;
  /** Inclusive upper time bound, or null. */
  createdBefore: Date | null;
}

/**
 * Normalized audit record returned by the repository. Carries only the fields
 * the mapper needs; it is not the raw persistence row and never includes the
 * `security_events` columns the audit API does not expose (ip address, user
 * agent, session id).
 */
export interface AuditEventRecord {
  id: string;
  organizationId: string | null;
  eventType: string;
  actorType: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: Date;
}

/** The audit read repository boundary (DB- and in-memory-backed). */
export interface AuditRepository {
  listAuditEvents(params: ListAuditEventsParams): Promise<AuditEventRecord[]>;
}
