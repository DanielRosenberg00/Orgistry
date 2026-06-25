import {
  ERROR_CODES,
  PERMISSION_KEYS,
  type AuditActorType,
  type AuditEventType,
  type AuditListResponse,
  type AuditTargetType,
} from '@orgistry/contracts';
import type { SecurityActorType } from '@orgistry/db';
import { decodeCursor, encodeCursor } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import type { EntitlementService } from '../entitlements/entitlement.service';
import {
  requireMembership,
  requirePermission,
} from '../organization/access-control';
import type { AccessControlRepository } from '../organization/organization.types';
import { resolvePersistedEventTypes } from './audit.catalog';
import { toAuditEvent } from './audit.mapper';
import type { AuditCursor, AuditRepository } from './audit.types';

/**
 * Audit log read workflow (Sprint 10) — the single place audit policy + shaping
 * are composed. The fixed enforcement order is:
 *
 *   1. requireMembership            (active member of THIS org? -> actor)
 *   2. requirePermission(audit_events.read)
 *   3. requireEntitlement(audit_log_access)
 *   4. resolve audit_retention_days (for response metadata)
 *   5. query organization-scoped events through the repository
 *   6. sanitize metadata + shape public DTOs (the mapper)
 *   7. return a cursor-paginated response (standard success envelope, added by
 *      the route)
 *
 * Authorization is ALWAYS by permission key, never role name. The entitlement
 * gate is INDEPENDENT of the permission: a user may hold `audit_events.read`
 * while the organization's plan lacks `audit_log_access`, and vice versa — both
 * must pass. The organization id is the actor's (resolved from the route), never
 * a request body value.
 */

export interface AuditServiceOptions {
  /** Resolves active membership + effective permissions (the org repo satisfies this). */
  accessControl: AccessControlRepository;
  /** Tenant-scoped audit read persistence. */
  audit: AuditRepository;
  /** Resolves the `audit_log_access` gate and `audit_retention_days` metadata. */
  entitlements: EntitlementService;
}

export interface ListAuditEventsInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
  limit: number;
  cursor: string | null;
  eventType: AuditEventType | null;
  actorType: AuditActorType | null;
  targetType: AuditTargetType | null;
  actorId: string | null;
  targetId: string | null;
  /** ISO-8601 bounds, validated by the contract; converted to Date here. */
  createdAfter: string | null;
  createdBefore: string | null;
}

export interface AuditService {
  listAuditEvents(input: ListAuditEventsInput): Promise<AuditListResponse>;
}

/** Internal opaque audit-list cursor shape. */
interface RawAuditCursor {
  c: number; // createdAt epoch millis
  i: string; // event id (tiebreak)
}

/** Decode an audit-list cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeAuditCursor(cursor: string | null): AuditCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<RawAuditCursor>(cursor);
  if (
    !decoded ||
    typeof decoded.c !== 'number' ||
    typeof decoded.i !== 'string'
  ) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

/** Map a public actor-type filter to the persisted actor-type column value. */
function toPersistedActorType(
  actorType: AuditActorType | null,
): SecurityActorType | null {
  if (!actorType) {
    return null;
  }
  // `unknown` is persisted as `anonymous`; the others map by identity.
  return actorType === 'unknown' ? 'anonymous' : actorType;
}

/** Parse an ISO bound to a Date, or null when absent. */
function parseBound(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export function createAuditService(
  options: AuditServiceOptions,
): AuditService {
  const { accessControl, audit, entitlements } = options;

  return {
    async listAuditEvents(input) {
      // 1. Active membership in the route organization -> actor context.
      const actor = await requireMembership(accessControl, {
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.requestId,
      });

      // 2. Permission gate (by key, never role name).
      requirePermission(actor, PERMISSION_KEYS.auditEventsRead);

      // 3. Entitlement gate — INDEPENDENT of the permission above.
      await entitlements.requireAuditLogAccess(actor.organizationId);

      // 4. Retention policy for the response metadata (display-only).
      const auditEntitlements = await entitlements.resolveAuditEntitlements(
        actor.organizationId,
      );

      // Resolve the persisted event names the filters select. When the filters
      // select nothing (e.g. targetType=organization, which no v1 event uses),
      // return an empty page WITHOUT touching the database.
      const eventTypes = resolvePersistedEventTypes({
        eventType: input.eventType,
        targetType: input.targetType,
      });

      const meta = { auditRetentionDays: auditEntitlements.retentionDays };

      if (eventTypes.length === 0) {
        return { items: [], nextCursor: null, hasMore: false, meta };
      }

      // 5. Tenant-scoped query (org id applied inside the repository).
      const records = await audit.listAuditEvents({
        organizationId: actor.organizationId,
        limit: input.limit,
        cursor: decodeAuditCursor(input.cursor),
        eventTypes,
        actorType: toPersistedActorType(input.actorType),
        actorId: input.actorId,
        targetId: input.targetId,
        createdAfter: parseBound(input.createdAfter),
        createdBefore: parseBound(input.createdBefore),
      });

      const hasMore = records.length > input.limit;
      const page = hasMore ? records.slice(0, input.limit) : records;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.createdAt.getTime(),
              i: last.id,
            } satisfies RawAuditCursor)
          : null;

      // 6. Sanitize + shape (the mapper). The org id is the authoritative actor
      // boundary, so a record can never present another tenant's id.
      return {
        items: page.map((record) => toAuditEvent(record, actor.organizationId)),
        nextCursor,
        hasMore,
        meta,
      };
    },
  };
}
