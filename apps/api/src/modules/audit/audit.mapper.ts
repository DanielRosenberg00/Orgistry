import type {
  AuditActorSummary,
  AuditActorType,
  AuditEvent,
  AuditTargetSummary,
  AuditTargetType,
} from '@orgistry/contracts';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import {
  targetTypeForEvent,
  toPublicEventType,
} from './audit.catalog';
import type { AuditEventRecord } from './audit.types';

/**
 * Public DTO shaping for audit events — the layer that turns a normalized
 * internal record into the safe, public `AuditEvent`.
 *
 * Three defenses live here:
 *  1. Metadata is re-sanitized at READ time via `sanitizeSecurityMetadata`
 *     (defense in depth — producers already sanitize at write time, but the
 *     reader does not trust them). Secrets, tokens, hashes, cookies, and
 *     Authorization headers are removed recursively before reaching a client.
 *  2. The actor summary is derived honestly: identity is read from safe fields
 *     only and an unattributable actor stays `unknown` — never fabricated.
 *  3. The target summary is derived from the event type (which fully determines
 *     the target kind) plus safe, non-secret id fields in the metadata.
 */

/** Read a string-valued metadata field, or null when absent/non-string. */
function readString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

/** Map the persisted actor-type column to the public actor type. */
function toPublicActorType(actorType: string): AuditActorType {
  switch (actorType) {
    case 'user':
      return 'user';
    case 'api_key':
      return 'api_key';
    case 'system':
      return 'system';
    default:
      // `anonymous` and any unrecognized value collapse to `unknown` — the
      // reader never invents an identity for an unattributed event.
      return 'unknown';
  }
}

/** Derive the safe actor summary from the record + sanitized metadata. */
function toActorSummary(
  record: AuditEventRecord,
  metadata: Record<string, unknown>,
): AuditActorSummary {
  const type = toPublicActorType(record.actorType);

  if (type === 'user') {
    return {
      type,
      userId: record.actorUserId,
      membershipId: readString(metadata, 'actorMembershipId'),
      apiKeyId: null,
      label: null,
    };
  }

  if (type === 'api_key') {
    return {
      type,
      userId: null,
      membershipId: null,
      // The acting key id, when the event safely resolved one. Token-derived
      // identifiers from malformed attempts are never present in metadata.
      apiKeyId: readString(metadata, 'targetKeyId'),
      label: null,
    };
  }

  // system / unknown carry no safe identity.
  return { type, userId: null, membershipId: null, apiKeyId: null, label: null };
}

/** Resolve the target id for a target kind from known, non-secret metadata keys. */
function targetIdFor(
  targetType: AuditTargetType,
  metadata: Record<string, unknown>,
): string | null {
  switch (targetType) {
    case 'project':
      return readString(metadata, 'targetProjectId');
    case 'api_key':
      return readString(metadata, 'targetKeyId');
    case 'invitation':
      return readString(metadata, 'targetInvitationId');
    case 'membership':
      return (
        readString(metadata, 'targetMembershipId') ??
        readString(metadata, 'membershipId')
      );
    case 'plan':
    case 'organization':
    case 'unknown':
    default:
      // The org plan has no discrete target id; the org target is the tenant
      // itself. Neither exposes an id field.
      return null;
  }
}

/** Derive the safe target summary from the public event type + sanitized metadata. */
function toTargetSummary(
  publicType: string,
  metadata: Record<string, unknown>,
): AuditTargetSummary {
  const targetType = targetTypeForEvent(publicType);
  // The plan key is a safe display label for a plan change; nothing else has a
  // safe label in v1.
  const label =
    targetType === 'plan' ? readString(metadata, 'newPlanKey') : null;

  return { type: targetType, id: targetIdFor(targetType, metadata), label };
}

/**
 * Map a normalized audit record to the public `AuditEvent` DTO.
 *
 * `organizationId` is taken from the authoritative tenant boundary the caller
 * resolved (never the raw row), so a record can never present another tenant's
 * id. An event whose persisted name is somehow not in the auditable catalog is
 * dropped by the caller; here it falls back to the raw name defensively.
 */
export function toAuditEvent(
  record: AuditEventRecord,
  organizationId: string,
): AuditEvent {
  const metadata = sanitizeSecurityMetadata(record.metadata ?? {});
  const publicType = toPublicEventType(record.eventType) ?? record.eventType;

  return {
    id: record.id,
    organizationId,
    type: publicType,
    category: 'action',
    actor: toActorSummary(record, metadata),
    target: toTargetSummary(publicType, metadata),
    metadata,
    requestId: record.requestId,
    createdAt: record.createdAt.toISOString(),
  };
}
