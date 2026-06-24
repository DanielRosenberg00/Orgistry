import type { ApiKeyRow } from '@orgistry/db';
import {
  PERMISSION_KEYS,
  type ApiKey,
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type ApiKeyRevokeResponse,
  type ApiKeyScope,
  type ApiKeyStatus,
  ERROR_CODES,
} from '@orgistry/contracts';
import {
  type Clock,
  decodeCursor,
  encodeCursor,
  systemClock,
} from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import type { EntitlementService } from '../entitlements/entitlement.service';
import {
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from '../organization/access-control';
import type { AccessControlRepository } from '../organization/organization.types';
import { generateApiKeySecret } from './api-key-secret';
import type {
  ApiKeyActionContext,
  ApiKeyRepository,
} from './api-key.types';

/**
 * API key management workflows (create / list / revoke) — the USER-facing,
 * organization-scoped surface for machine credentials.
 *
 * Every method composes the standard organization pipeline, with the Sprint 7
 * entitlement/quota layer made explicit for create:
 *
 *   requireMembership                 (active member of this org? -> actor)
 *     -> requirePermission(api_keys.*) (does the user hold the permission key?)
 *       -> requireApiKeysAccess         (does the org's PLAN grant API keys?)   [create/list/revoke]
 *         -> requireApiKeyCreationQuota (is the org under max_api_keys?)        [create only]
 *           -> tenant-scoped key write  (always scoped by the route org id)
 *             -> map row to public DTO  (NEVER the secret hash)
 *
 * Authorization is ALWAYS by permission key, never role name. The organization
 * id comes from the route (`OrganizationActor.organizationId`), never a request
 * body. The raw secret is generated here and returned by create exactly once;
 * only its hash is ever persisted.
 */

export interface ApiKeyServiceOptions {
  /** Resolves active membership + effective permissions (the org repo satisfies this). */
  accessControl: AccessControlRepository;
  /** Tenant-aware API key persistence. */
  apiKeys: ApiKeyRepository;
  /** Organization-level entitlement/quota service (the api_keys_access + max_api_keys gates). */
  entitlements: EntitlementService;
  clock?: Clock;
}

/** Per-request security metadata threaded from the route into action events. */
export interface ApiKeyRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateApiKeyInput {
  userId: string;
  organizationId: string;
  name: string;
  scopes: ApiKeyScope[];
  /** Optional expiry instant (already validated as future by the route). */
  expiresAt: Date | null;
  ctx: ApiKeyRequestContext;
}

export interface ListApiKeysInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
  limit: number;
  cursor: string | null;
}

export interface RevokeApiKeyInput {
  userId: string;
  organizationId: string;
  apiKeyId: string;
  ctx: ApiKeyRequestContext;
}

export interface ApiKeyService {
  createApiKey(input: CreateApiKeyInput): Promise<ApiKeyCreateResponse>;
  listApiKeys(input: ListApiKeysInput): Promise<ApiKeyListResponse>;
  revokeApiKey(input: RevokeApiKeyInput): Promise<ApiKeyRevokeResponse>;
}

/** Internal API-key-list cursor shape. Opaque to clients. */
interface ApiKeyCursor {
  c: number; // createdAt epoch millis
  i: string; // key id (tiebreak)
}

/** Derive a key's lifecycle status from its row (never a stored column). */
function apiKeyStatus(row: ApiKeyRow, nowMs: number): ApiKeyStatus {
  if (row.revokedAt !== null) {
    return 'revoked';
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= nowMs) {
    return 'expired';
  }
  return 'active';
}

/** Map a key row to the public DTO. The secret hash is NEVER shaped here. */
function toApiKey(row: ApiKeyRow, nowMs: number): ApiKey {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    displayPrefix: row.displayPrefix,
    scopes: row.scopes,
    status: apiKeyStatus(row, nowMs),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/** Decode an API-key-list cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeApiKeyCursor(
  cursor: string | null,
): { createdAtMs: number; id: string } | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<ApiKeyCursor>(cursor);
  if (!decoded || typeof decoded.c !== 'number' || typeof decoded.i !== 'string') {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

/** Build the repository action context from an actor + request metadata. */
function actionContext(
  actor: OrganizationActor,
  ctx: ApiKeyRequestContext,
): ApiKeyActionContext {
  return {
    actorUserId: actor.userId,
    actorMembershipId: actor.membershipId,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  };
}

export function createApiKeyService(
  options: ApiKeyServiceOptions,
): ApiKeyService {
  const { accessControl, apiKeys, entitlements, clock = systemClock } = options;

  async function actorFor(input: {
    userId: string;
    organizationId: string;
    requestId: string | null;
  }): Promise<OrganizationActor> {
    return requireMembership(accessControl, {
      userId: input.userId,
      organizationId: input.organizationId,
      requestId: input.requestId,
    });
  }

  return {
    async createApiKey(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.apiKeysCreate);

      // Entitlement THEN quota, both AFTER the permission check. A user without
      // api_keys.create is already blocked; an authorized user is blocked when
      // the org's plan lacks api_keys_access, then again when it is at the
      // max_api_keys ceiling. Both throw BEFORE any write, so a failure creates
      // no key and records no api_key.created event.
      await entitlements.requireApiKeysAccess(actor.organizationId);
      // Active = not revoked AND not expired, so a revoked or expired key never
      // blocks creation. `clock.now()` keeps the count deterministic in tests.
      const activeCount = await apiKeys.countActiveApiKeys(
        actor.organizationId,
        clock.now(),
      );
      await entitlements.requireApiKeyCreationQuota(
        actor.organizationId,
        activeCount,
      );

      // Generate the secret. The raw value is returned to the client ONCE; only
      // the hash and the display-safe prefix are persisted.
      const generated = generateApiKeySecret();
      const row = await apiKeys.createApiKey({
        organizationId: actor.organizationId,
        name: input.name,
        displayPrefix: generated.displayPrefix,
        secretHash: generated.secretHash,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        createdByUserId: actor.userId,
        ctx: actionContext(actor, input.ctx),
      });

      return {
        apiKey: toApiKey(row, clock.epochMillis()),
        secret: generated.raw,
      };
    },

    async listApiKeys(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.apiKeysRead);
      await entitlements.requireApiKeysAccess(actor.organizationId);

      const rows = await apiKeys.listApiKeys({
        organizationId: actor.organizationId,
        limit: input.limit,
        cursor: decodeApiKeyCursor(input.cursor),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.createdAt.getTime(),
              i: last.id,
            } satisfies ApiKeyCursor)
          : null;

      const nowMs = clock.epochMillis();
      return {
        items: page.map((row) => toApiKey(row, nowMs)),
        nextCursor,
        hasMore,
      };
    },

    async revokeApiKey(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.apiKeysRevoke);
      await entitlements.requireApiKeysAccess(actor.organizationId);

      // Scoped by org + id. An unknown or cross-tenant key is a uniform
      // not-found; an already-revoked key is a safe no-op (no second event).
      await apiKeys.revokeApiKey({
        organizationId: actor.organizationId,
        apiKeyId: input.apiKeyId,
        ctx: actionContext(actor, input.ctx),
      });

      return { id: input.apiKeyId, revoked: true };
    },
  };
}
