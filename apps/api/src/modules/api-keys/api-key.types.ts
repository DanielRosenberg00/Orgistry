import type { ApiKeyRow } from '@orgistry/db';
import type { ApiKeyScope } from '@orgistry/contracts';
import type {
  ApiKeyEventType,
  ApiKeySecurityEventType,
} from './api-key.events';

/**
 * Internal API key module types.
 *
 * `ApiKeyRow` is the persistence shape used INSIDE the module only; it is never
 * returned from a route — the service maps it to the public `ApiKey` DTO first,
 * and the secret hash never crosses any boundary.
 */

/**
 * Per-request action context attached to an API key LIFECYCLE event
 * (create/revoke). Carries the server-derived USER actor identity plus
 * non-secret request metadata. Secrets are never placed here; metadata is
 * sanitized before persistence regardless.
 */
export interface ApiKeyActionContext {
  /** The acting user (recorded as the event actor and on created/revoked columns). */
  actorUserId: string;
  /** The actor's active membership in the organization (recorded in metadata). */
  actorMembershipId: string;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Server-derived MACHINE actor context for an external API request authenticated
 * by an API key. This is deliberately SEPARATE from the user `OrganizationActor`
 * — an API key is not a member, holds no user permissions, and never impersonates
 * the user who created it.
 */
export interface ApiKeyActor {
  actorType: 'api_key';
  apiKeyId: string;
  /** The tenant, derived from the key row — never from the request. */
  organizationId: string;
  scopes: readonly ApiKeyScope[];
  requestId: string | null;
}

/** Per-request, non-secret metadata for an external auth security event. */
export interface ApiKeyRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Inputs for creating a key under an organization (hash already computed). */
export interface CreateApiKeyParams {
  organizationId: string;
  name: string;
  displayPrefix: string;
  secretHash: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  createdByUserId: string;
  ctx: ApiKeyActionContext;
}

/** Cursor-pagination inputs for listing an organization's keys. */
export interface ListApiKeysParams {
  organizationId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/** Inputs for revoking a key (scoped by org + id). */
export interface RevokeApiKeyParams {
  organizationId: string;
  apiKeyId: string;
  ctx: ApiKeyActionContext;
}

/** Outcome of a revoke: whether the key was already revoked (idempotent path). */
export interface RevokeApiKeyResult {
  apiKeyId: string;
  alreadyRevoked: boolean;
}

/** Inputs for a failed/observed external-auth security event. */
export interface ApiKeyAuthEventInput {
  eventType: ApiKeySecurityEventType;
  /** Resolved key id, or null when no key was safely resolved (malformed/unknown). */
  apiKeyId: string | null;
  /** Resolved organization id, or null when none was safely resolved. */
  organizationId: string | null;
  metadata: Record<string, unknown>;
  ctx: ApiKeyRequestContext;
}

/**
 * Tenant-aware persistence boundary for API key workflows.
 *
 * Every management method is organization-scoped: a key is never addressed by
 * id alone. `findBySecretHash` is the ONE exception — it is the authentication
 * lookup, where the organization is DERIVED from the resolved row, never taken
 * from the request. The repository owns API key SQL and the lifecycle
 * action-event writes that commit with each mutation; it does NOT own permission,
 * entitlement, or quota policy and does NOT shape HTTP responses.
 */
export interface ApiKeyRepository {
  /** Create a key under `organizationId` and record `api_key.created`. */
  createApiKey(params: CreateApiKeyParams): Promise<ApiKeyRow>;

  /**
   * List an organization's keys (active AND revoked), newest first, one page at
   * a time. Returns up to `limit + 1` rows so the caller can detect a further
   * page without a second query.
   */
  listApiKeys(params: ListApiKeysParams): Promise<ApiKeyRow[]>;

  /**
   * Count the organization's ACTIVE keys — the `max_api_keys` quota basis.
   * Active means BOTH not revoked (`revoked_at IS NULL`) AND not expired
   * (`expires_at IS NULL OR expires_at > now`), so a revoked or expired key never
   * occupies a quota slot. `now` is supplied by the caller (from its clock) so
   * the count is deterministic and testable; it never depends on Redis.
   */
  countActiveApiKeys(organizationId: string, now: Date): Promise<number>;

  /**
   * Resolve a key by its secret hash for authentication, or null. The caller
   * derives the organization from the returned row; a hash that matches nothing
   * returns null (mapped to a uniform unauthorized).
   */
  findBySecretHash(secretHash: string): Promise<ApiKeyRow | null>;

  /**
   * Revoke an active key (scoped by org + id): set `revoked_at` +
   * `revoked_by_user_id` and record `api_key.revoked`. Throws
   * `API_KEY_NOT_FOUND` when the key is unknown or belongs to another
   * organization. Revoking an ALREADY-revoked key is a safe no-op that returns
   * `alreadyRevoked: true` and records no second event. Keys are never
   * hard-deleted.
   */
  revokeApiKey(params: RevokeApiKeyParams): Promise<RevokeApiKeyResult>;

  /**
   * Update `last_used_at` for a key (best-effort, called with throttling by the
   * authenticator). Never throws into the auth path on a write failure.
   */
  touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void>;

  /** Record a failed/observed external-auth security event (best-effort). */
  recordAuthEvent(input: ApiKeyAuthEventInput): Promise<void>;
}

/** Re-exported for repositories that key their metadata on the event type. */
export type { ApiKeyEventType };
