import type { OrganizationRow } from '@orgistry/db';
import type { ApiKeyScope } from '@orgistry/contracts';
import { type Clock, systemClock } from '@orgistry/shared';
import type { RateLimiter } from '../../lib/rate-limit';
import { createNoopRateLimiter } from '../../lib/rate-limit';
import { entitlementRequiredError } from '../entitlements/entitlement.errors';
import { ENTITLEMENT_KEYS } from '@orgistry/contracts';
import {
  apiKeyRateLimitedError,
  apiKeyScopeRequiredError,
  apiKeyUnauthorizedError,
} from './api-key.errors';
import { API_KEY_SECURITY_EVENT_TYPES } from './api-key.events';
import { hashApiKeySecret, parseApiKey } from './api-key-secret';
import type {
  ApiKeyActor,
  ApiKeyRepository,
  ApiKeyRequestContext,
} from './api-key.types';

/**
 * External API key authenticator — the auth boundary for `/v1/external/*`.
 *
 * It validates a presented Bearer API key against persistence (the SOLE source
 * of truth) and produces a MACHINE actor context. It is deliberately separate
 * from the user/session boundary: it accepts NO browser JWT, derives the
 * organization ONLY from the resolved key row (never from the request), grants
 * NO user permissions, and never impersonates the key's creator.
 *
 * Validation order (each failure is safe and uniform):
 *
 *   parse format        -> malformed          -> 401 (no token material logged)
 *     -> hash + lookup  -> unknown            -> 401 (no key attribution)
 *       -> not revoked  -> revoked            -> 401
 *         -> not expired -> expired           -> 401
 *           -> org active -> inactive org     -> 401
 *             -> entitlement still applies     -> 403 ENTITLEMENT_REQUIRED
 *               -> required scope present      -> 403 API_KEY_SCOPE_REQUIRED
 *                 -> rate limits (per key/org) -> 429 RATE_LIMITED
 *                   -> touch last_used (throttled) -> ApiKeyActor
 *
 * Auth correctness lives entirely above the rate-limit step: the limiter is
 * Redis-backed and FAILS OPEN, so a Redis outage can never accept an invalid
 * key nor reject a valid one — it can only stop enforcing the throughput cap.
 */

/** Per-bucket external API rate limits (from `config.rateLimit.external`). */
export interface ExternalRateLimits {
  windowSeconds: number;
  perKeyMax: number;
  perOrgMax: number;
}

/** The narrow organization lookup the authenticator needs (org-active check). */
export interface OrganizationLookup {
  findOrganizationById(organizationId: string): Promise<OrganizationRow | null>;
}

/** The entitlement surface the authenticator needs (re-checked every request). */
export interface ApiKeyEntitlementResolver {
  resolveApiKeyEntitlements(
    organizationId: string,
  ): Promise<{ access: boolean; max: number }>;
}

export interface ApiKeyAuthenticatorOptions {
  apiKeys: ApiKeyRepository;
  organizations: OrganizationLookup;
  entitlements: ApiKeyEntitlementResolver;
  /** Redis-backed in production; a no-op limiter when omitted. */
  rateLimiter?: RateLimiter;
  rateLimits?: ExternalRateLimits;
  /** Minimum seconds between `last_used_at` writes for a single key. */
  lastUsedThrottleSeconds: number;
  clock?: Clock;
}

export interface ApiKeyAuthenticator {
  /**
   * Authenticate a presented raw API key and require `requiredScope`. Returns a
   * machine `ApiKeyActor` on success; throws a uniform, safe error otherwise.
   * `rawKey` is null when the Authorization header was missing or non-Bearer.
   */
  authenticate(
    rawKey: string | null,
    ctx: ApiKeyRequestContext,
    requiredScope: ApiKeyScope,
  ): Promise<ApiKeyActor>;
}

export function createApiKeyAuthenticator(
  options: ApiKeyAuthenticatorOptions,
): ApiKeyAuthenticator {
  const {
    apiKeys,
    organizations,
    entitlements,
    rateLimiter = createNoopRateLimiter(),
    lastUsedThrottleSeconds,
    clock = systemClock,
  } = options;

  // Permissive default if no limits are wired (e.g. unit tests not exercising
  // rate limiting). Production passes real values from config.
  const limits: ExternalRateLimits = options.rateLimits ?? {
    windowSeconds: 60,
    perKeyMax: Number.MAX_SAFE_INTEGER,
    perOrgMax: Number.MAX_SAFE_INTEGER,
  };

  return {
    async authenticate(rawKey, ctx, requiredScope) {
      // 1. Parse the format. A missing/non-Bearer header arrives as null; a
      // malformed credential (including a browser JWT) parses to null. Neither
      // carries safe key attribution and neither logs token material.
      const parsed = parseApiKey(rawKey);
      if (!parsed) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authMalformed,
          apiKeyId: null,
          organizationId: null,
          metadata: { reason: rawKey ? 'malformed' : 'missing' },
          ctx,
        });
        throw apiKeyUnauthorizedError();
      }

      // 2. Resolve by the secret-component hash. An unknown key invents no
      // attribution (no id, no org).
      const row = await apiKeys.findBySecretHash(
        hashApiKeySecret(parsed.secretComponent),
      );
      if (!row) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authUnknown,
          apiKeyId: null,
          organizationId: null,
          metadata: {},
          ctx,
        });
        throw apiKeyUnauthorizedError();
      }

      // From here the key id and organization are SAFELY resolved and may be
      // attributed on events.
      const nowMs = clock.epochMillis();

      // 3. Revoked keys cannot authenticate.
      if (row.revokedAt !== null) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authRevoked,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: {},
          ctx,
        });
        throw apiKeyUnauthorizedError();
      }

      // 4. Expired keys cannot authenticate.
      if (row.expiresAt !== null && row.expiresAt.getTime() <= nowMs) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authExpired,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: {},
          ctx,
        });
        throw apiKeyUnauthorizedError();
      }

      // 5. The organization (derived from the row) must be active.
      const organization = await organizations.findOrganizationById(
        row.organizationId,
      );
      if (!organization || organization.status !== 'active') {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authOrganizationInactive,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: {},
          ctx,
        });
        throw apiKeyUnauthorizedError();
      }

      // 6. The org's plan must STILL grant api_keys_access (a downgrade disables
      // existing keys). Distinct, informative 403 — the key owner controls it.
      const entitlement = await entitlements.resolveApiKeyEntitlements(
        row.organizationId,
      );
      if (!entitlement.access) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authEntitlementMissing,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: {},
          ctx,
        });
        throw entitlementRequiredError(ENTITLEMENT_KEYS.apiKeysAccess);
      }

      // 7. The key must hold the required scope.
      if (!row.scopes.includes(requiredScope)) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.authScopeMissing,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: { requiredScope },
          ctx,
        });
        throw apiKeyScopeRequiredError(requiredScope);
      }

      // 8. Rate limits (per key, then per organization). AFTER auth correctness,
      // so the limiter is never on the correctness path. Fail-open by design.
      const perKeyOk = await rateLimiter.consume(
        `rl:ext:key:${row.id}`,
        limits.perKeyMax,
        limits.windowSeconds,
      );
      const perOrgOk = await rateLimiter.consume(
        `rl:ext:org:${row.organizationId}`,
        limits.perOrgMax,
        limits.windowSeconds,
      );
      if (!perKeyOk || !perOrgOk) {
        await apiKeys.recordAuthEvent({
          eventType: API_KEY_SECURITY_EVENT_TYPES.rateLimitExceeded,
          apiKeyId: row.id,
          organizationId: row.organizationId,
          metadata: { bucket: !perKeyOk ? 'per_key' : 'per_organization' },
          ctx,
        });
        throw apiKeyRateLimitedError();
      }

      // 9. Record successful use with throttling: only write when the key has
      // never been used or the throttle window has elapsed. A write failure must
      // never break a valid request, so it is best-effort.
      const throttleMs = lastUsedThrottleSeconds * 1000;
      const shouldTouch =
        row.lastUsedAt === null ||
        nowMs - row.lastUsedAt.getTime() >= throttleMs;
      if (shouldTouch) {
        await apiKeys.touchLastUsed(row.id, new Date(nowMs));
      }

      return {
        actorType: 'api_key',
        apiKeyId: row.id,
        organizationId: row.organizationId,
        scopes: row.scopes,
        requestId: ctx.requestId,
      };
    },
  };
}
