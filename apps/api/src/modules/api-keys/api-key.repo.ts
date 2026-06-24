import type { Database, DbExecutor, ApiKeyRow } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import { apiKeyNotFoundError } from './api-key.errors';
import {
  API_KEY_EVENT_TYPES,
  type ApiKeyEventType,
} from './api-key.events';
import type {
  ApiKeyAuthEventInput,
  ApiKeyActionContext,
  ApiKeyRepository,
  CreateApiKeyParams,
  ListApiKeysParams,
  RevokeApiKeyParams,
  RevokeApiKeyResult,
} from './api-key.types';

/** Stable target type recorded on every API key action event. */
const API_KEY_TARGET_TYPE = 'api_key';

/**
 * Drizzle-backed implementation of the tenant-aware API key persistence
 * boundary. All API key SQL lives here; the service and authenticator depend
 * only on `ApiKeyRepository`.
 *
 * Rules that hold for every management method:
 *  1. management reads/mutations are scoped by `organization_id` — a key is
 *     never addressed by id alone, so cross-tenant access cannot occur;
 *  2. the raw secret is never persisted (only its hash and the display prefix);
 *  3. keys are revoked, never hard-deleted.
 *
 * `findBySecretHash` is the single authentication lookup: it resolves a key by
 * its unique hash and the caller derives the organization from the row.
 */
export function createDbApiKeyRepository(db: Database): ApiKeyRepository {
  /**
   * Record an API key action event in the SAME transaction as the mutation, on
   * the existing organization-scoped `security_events` seam. Actor membership,
   * target type, and target id live in sanitized metadata; the metadata key for
   * the key id deliberately avoids the sanitizer's `api_key`/`apikey` denylist
   * substrings (it is `targetKeyId`), and secrets/hashes never appear here.
   */
  async function recordKeyEvent(
    executor: DbExecutor,
    input: {
      organizationId: string;
      eventType: ApiKeyEventType;
      apiKeyId: string;
      metadata: Record<string, unknown>;
      ctx: ApiKeyActionContext;
    },
  ): Promise<void> {
    await executor.insert(schema.securityEvents).values({
      id: createId('sevt'),
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
      ipAddress: input.ctx.ipAddress,
      userAgent: input.ctx.userAgent,
      requestId: input.ctx.requestId,
    });
  }

  return {
    async createApiKey(params: CreateApiKeyParams): Promise<ApiKeyRow> {
      return db.transaction(async (tx) => {
        const [key] = await tx
          .insert(schema.apiKeys)
          .values({
            id: createId('key'),
            organizationId: params.organizationId,
            name: params.name,
            displayPrefix: params.displayPrefix,
            secretHash: params.secretHash,
            scopes: params.scopes,
            expiresAt: params.expiresAt,
            createdByUserId: params.createdByUserId,
          })
          .returning();

        await recordKeyEvent(tx, {
          organizationId: params.organizationId,
          eventType: API_KEY_EVENT_TYPES.created,
          apiKeyId: key.id,
          // Display prefix + scopes are safe (non-secret) and useful in audit.
          metadata: {
            displayPrefix: key.displayPrefix,
            scopes: key.scopes,
          },
          ctx: params.ctx,
        });

        return key;
      });
    },

    async listApiKeys(params: ListApiKeysParams): Promise<ApiKeyRow[]> {
      // Keyset pagination on (created_at desc, id desc) within the organization.
      // Lists include active AND revoked keys (status is shown), so there is no
      // active-only filter here.
      const cursorClause = params.cursor
        ? or(
            lt(schema.apiKeys.createdAt, new Date(params.cursor.createdAtMs)),
            and(
              eq(schema.apiKeys.createdAt, new Date(params.cursor.createdAtMs)),
              lt(schema.apiKeys.id, params.cursor.id),
            ),
          )
        : undefined;

      return db
        .select()
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.organizationId, params.organizationId),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(desc(schema.apiKeys.createdAt), desc(schema.apiKeys.id))
        .limit(params.limit + 1);
    },

    async countActiveApiKeys(
      organizationId: string,
      now: Date,
    ): Promise<number> {
      // Active = not revoked AND not expired. The partial index on
      // (organization_id) WHERE revoked_at IS NULL narrows the scan to
      // non-revoked rows; the expiry predicate then drops expired keys so a key
      // past its expiry never blocks the quota.
      const [row] = await db
        .select({ value: count() })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.organizationId, organizationId),
            isNull(schema.apiKeys.revokedAt),
            or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, now)),
          ),
        );
      return row?.value ?? 0;
    },

    async findBySecretHash(secretHash: string): Promise<ApiKeyRow | null> {
      const [key] = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.secretHash, secretHash))
        .limit(1);
      return key ?? null;
    },

    async revokeApiKey(params: RevokeApiKeyParams): Promise<RevokeApiKeyResult> {
      return db.transaction(async (tx) => {
        // Lock the row, scoped by org + id. A missing or cross-tenant key is a
        // uniform not-found.
        const [target] = await tx
          .select()
          .from(schema.apiKeys)
          .where(
            and(
              eq(schema.apiKeys.organizationId, params.organizationId),
              eq(schema.apiKeys.id, params.apiKeyId),
            ),
          )
          .for('update')
          .limit(1);
        if (!target) {
          throw apiKeyNotFoundError();
        }

        // Idempotent: revoking an already-revoked key is a safe no-op and
        // records no second event.
        if (target.revokedAt !== null) {
          return { apiKeyId: target.id, alreadyRevoked: true };
        }

        const now = new Date();
        await tx
          .update(schema.apiKeys)
          .set({
            revokedAt: now,
            revokedByUserId: params.ctx.actorUserId,
            updatedAt: now,
          })
          .where(eq(schema.apiKeys.id, target.id));

        await recordKeyEvent(tx, {
          organizationId: params.organizationId,
          eventType: API_KEY_EVENT_TYPES.revoked,
          apiKeyId: target.id,
          metadata: {},
          ctx: params.ctx,
        });

        return { apiKeyId: target.id, alreadyRevoked: false };
      });
    },

    async touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void> {
      await db
        .update(schema.apiKeys)
        .set({ lastUsedAt: usedAt })
        .where(eq(schema.apiKeys.id, apiKeyId));
    },

    async recordAuthEvent(input: ApiKeyAuthEventInput): Promise<void> {
      // Best-effort security record for a failed/observed external auth attempt.
      // Attribution rules: a null api key id / organization id stays null (no
      // invented attribution). The metadata key for the resolved id avoids the
      // sanitizer denylist (`targetKeyId`), and no token material is included.
      await db.insert(schema.securityEvents).values({
        id: createId('sevt'),
        userId: null,
        organizationId: input.organizationId,
        actorType: input.apiKeyId ? 'api_key' : 'anonymous',
        eventType: input.eventType,
        metadata: sanitizeSecurityMetadata({
          targetType: API_KEY_TARGET_TYPE,
          ...(input.apiKeyId ? { targetKeyId: input.apiKeyId } : {}),
          ...input.metadata,
        }),
        ipAddress: input.ctx.ipAddress,
        userAgent: input.ctx.userAgent,
        requestId: input.ctx.requestId,
      });
    },
  };
}
