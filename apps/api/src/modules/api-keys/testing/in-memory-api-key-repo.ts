import type { ApiKeyRow } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import { apiKeyNotFoundError } from '../api-key.errors';
import {
  API_KEY_EVENT_TYPES,
  type ApiKeyEventType,
} from '../api-key.events';
import type {
  ApiKeyActionContext,
  ApiKeyAuthEventInput,
  ApiKeyRepository,
  CreateApiKeyParams,
  ListApiKeysParams,
  RevokeApiKeyParams,
  RevokeApiKeyResult,
} from '../api-key.types';

/** Stable target type recorded on every API key event. */
const API_KEY_TARGET_TYPE = 'api_key';

/**
 * In-memory `ApiKeyRepository` for unit/route tests.
 *
 * Mirrors the database repository's observable behavior — prefixed ids,
 * timestamps, organization-scoped management lookups, hash lookup, active-count
 * filtering, keyset ordering, idempotent revoke, throttled last-used writes, and
 * the action/auth event writes — over the shared `InMemoryOrgStore`, so API key
 * and external-API workflows can be exercised end-to-end with no PostgreSQL.
 */
export function createInMemoryApiKeyRepository(
  store: InMemoryOrgStore,
): ApiKeyRepository {
  function recordKeyEvent(input: {
    organizationId: string;
    eventType: ApiKeyEventType;
    apiKeyId: string;
    metadata: Record<string, unknown>;
    ctx: ApiKeyActionContext;
  }): void {
    store.securityEvents.push({
      userId: input.ctx.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata({
        actorMembershipId: input.ctx.actorMembershipId,
        targetType: API_KEY_TARGET_TYPE,
        targetKeyId: input.apiKeyId,
        ...input.metadata,
      }),
      requestId: input.ctx.requestId,
    });
  }

  return {
    async createApiKey(params: CreateApiKeyParams): Promise<ApiKeyRow> {
      const now = new Date();
      const key: ApiKeyRow = {
        id: createId('key'),
        organizationId: params.organizationId,
        name: params.name,
        displayPrefix: params.displayPrefix,
        secretHash: params.secretHash,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        revokedByUserId: null,
        createdByUserId: params.createdByUserId,
        createdAt: now,
        updatedAt: now,
      };
      store.apiKeys.push(key);

      recordKeyEvent({
        organizationId: params.organizationId,
        eventType: API_KEY_EVENT_TYPES.created,
        apiKeyId: key.id,
        metadata: { displayPrefix: key.displayPrefix, scopes: key.scopes },
        ctx: params.ctx,
      });

      return key;
    },

    async listApiKeys(params: ListApiKeysParams): Promise<ApiKeyRow[]> {
      const ordered = store.apiKeys
        .filter((k) => k.organizationId === params.organizationId)
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          return byCreated !== 0 ? byCreated : a.id < b.id ? 1 : -1;
        });

      const afterCursor = params.cursor
        ? ordered.filter((k) => {
            const created = k.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs && k.id < params.cursor!.id
            );
          })
        : ordered;

      return afterCursor.slice(0, params.limit + 1);
    },

    async countActiveApiKeys(
      organizationId: string,
      now: Date,
    ): Promise<number> {
      // Active = not revoked AND not expired (mirrors the DB repository).
      const nowMs = now.getTime();
      return store.apiKeys.filter(
        (k) =>
          k.organizationId === organizationId &&
          k.revokedAt === null &&
          (k.expiresAt === null || k.expiresAt.getTime() > nowMs),
      ).length;
    },

    async findBySecretHash(secretHash: string): Promise<ApiKeyRow | null> {
      return (
        store.apiKeys.find((k) => k.secretHash === secretHash) ?? null
      );
    },

    // Synchronous read-classify-write (no await before the mutation) -> atomic
    // under Node's single-threaded loop, mirroring the DB transaction + row lock.
    async revokeApiKey(params: RevokeApiKeyParams): Promise<RevokeApiKeyResult> {
      const target = store.apiKeys.find(
        (k) =>
          k.id === params.apiKeyId &&
          k.organizationId === params.organizationId,
      );
      if (!target) {
        throw apiKeyNotFoundError();
      }

      if (target.revokedAt !== null) {
        return { apiKeyId: target.id, alreadyRevoked: true };
      }

      const now = new Date();
      target.revokedAt = now;
      target.revokedByUserId = params.ctx.actorUserId;
      target.updatedAt = now;

      recordKeyEvent({
        organizationId: params.organizationId,
        eventType: API_KEY_EVENT_TYPES.revoked,
        apiKeyId: target.id,
        metadata: {},
        ctx: params.ctx,
      });

      return { apiKeyId: target.id, alreadyRevoked: false };
    },

    async touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void> {
      const target = store.apiKeys.find((k) => k.id === apiKeyId);
      if (target) {
        target.lastUsedAt = usedAt;
      }
    },

    async recordAuthEvent(input: ApiKeyAuthEventInput): Promise<void> {
      store.securityEvents.push({
        userId: null,
        organizationId: input.organizationId,
        actorType: input.apiKeyId ? 'api_key' : 'anonymous',
        eventType: input.eventType,
        metadata: sanitizeSecurityMetadata({
          targetType: API_KEY_TARGET_TYPE,
          ...(input.apiKeyId ? { targetKeyId: input.apiKeyId } : {}),
          ...input.metadata,
        }),
        requestId: input.ctx.requestId,
      });
    },
  };
}
