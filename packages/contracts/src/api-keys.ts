import { z } from 'zod';

/**
 * API key & external-API contracts (Sprint 8) — organization-scoped MACHINE
 * credentials and the read-only external Projects surface.
 *
 * Two strictly separate authorization concepts meet here and must never be
 * merged (see the Sprint 8 docs):
 *
 *   Permission   — what the USER managing keys may do (RBAC; `api_keys.*`).
 *   Entitlement  — whether the ORGANIZATION'S plan allows keys (`api_keys_access`).
 *   Quota        — how many keys the organization may hold (`max_api_keys`).
 *   Scope        — what a KEY may do once it authenticates (`projects:read`).
 *
 * Hard rules carried over from the project/plan contracts:
 *  - no response field ever carries the raw secret or the secret hash. The
 *    create response is the ONE place the raw secret appears, exactly once;
 *  - the organization id is the authority boundary. Management routes take it
 *    from the route path; the external API derives it from the key row and never
 *    accepts it from the client;
 *  - DTOs never expose persistence-only columns (the secret hash is never shaped
 *    here at all).
 */

/** Maximum key name length guards against denial-of-service via oversized input. */
export const MAX_API_KEY_NAME_LENGTH = 120;

// ---------------------------------------------------------------------------
// Scopes — the shallow, typed, future-extensible key scope model
// ---------------------------------------------------------------------------

/**
 * The fixed v1 API key scopes. A scope is what a key may do AFTER it
 * authenticates — distinct from the user permissions that govern key
 * management and the plan entitlement that governs whether keys may exist.
 *
 * v1 ships exactly one scope. The model is deliberately a flat enum so it can
 * grow (`projects:write`, …) without an advanced policy engine, custom scopes,
 * or resource-level scopes — none of which are in scope for Sprint 8.
 */
export const API_KEY_SCOPES = {
  projectsRead: 'projects:read',
} as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[keyof typeof API_KEY_SCOPES];

/** All scopes, in catalog order. */
export const API_KEY_SCOPE_LIST: readonly ApiKeyScope[] =
  Object.values(API_KEY_SCOPES);

export const apiKeyScopeSchema = z.enum(
  API_KEY_SCOPE_LIST as [ApiKeyScope, ...ApiKeyScope[]],
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a key, derived server-side from its row:
 *  - `revoked`  — `revoked_at` is set (terminal; cannot authenticate);
 *  - `expired`  — not revoked, but `expires_at` has passed (cannot authenticate);
 *  - `active`   — neither revoked nor expired (may authenticate).
 *
 * It is a derived view, never a stored column, so it can never drift from the
 * timestamps that define it.
 */
export const apiKeyStatusSchema = z.enum(['active', 'revoked', 'expired']);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Public representation of an API key. This is the ONLY key shape that crosses
 * the management API boundary, and it NEVER contains the raw secret or the
 * secret hash. `displayPrefix` is the safe, non-secret identifier shown to
 * humans (e.g. `orgistry_AB12CD34`) so a key is recognizable in a list without
 * exposing anything that can authenticate.
 */
export const apiKeySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  /** Display-safe identifier (the key prefix, never the secret). */
  displayPrefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  status: apiKeyStatusSchema,
  createdByUserId: z.string(),
  createdAt: z.string(),
  /** Last successful authentication (throttled write), or null if never used. */
  lastUsedAt: z.string().nullable(),
  /** Expiry instant, or null when the key does not expire. */
  expiresAt: z.string().nullable(),
  /** Revocation instant, or null when the key is not revoked. */
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

/**
 * POST …/api-keys request body. The organization is taken from the route path
 * (never the body) and the creator is the authenticated actor, so neither
 * appears here. `scopes` must be a non-empty set of valid scopes; `expiresAt`,
 * when present, must be a future instant.
 */
export const apiKeyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_API_KEY_NAME_LENGTH),
  scopes: z.array(apiKeyScopeSchema).min(1),
  /** Optional expiry. ISO-8601; must be in the future. */
  expiresAt: z.string().datetime().optional(),
});
export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>;

/**
 * POST …/api-keys response body. Carries the created key DTO AND the raw secret
 * — the ONLY response in the entire API that contains the raw secret, and it is
 * returned exactly once. It is unrecoverable afterwards (only its hash is
 * stored), so the client must persist it now.
 */
export const apiKeyCreateResponseSchema = z.object({
  apiKey: apiKeySchema,
  /** The raw API key. Shown ONCE. Never stored, never returned again. */
  secret: z.string(),
});
export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponseSchema>;

/** GET …/api-keys response body — cursor-paginated keys (active and revoked). */
export const apiKeyListResponseSchema = z.object({
  items: z.array(apiKeySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

/**
 * DELETE …/api-keys/:apiKeyId response body. Revocation returns a minimal
 * acknowledgement (the now-revoked key's id) rather than the row.
 */
export const apiKeyRevokeResponseSchema = z.object({
  id: z.string(),
  revoked: z.literal(true),
});
export type ApiKeyRevokeResponse = z.infer<typeof apiKeyRevokeResponseSchema>;

/**
 * Route parameters for the single-key surface (`…/api-keys/:apiKeyId`).
 * Presence/shape only — the id's authority is resolved server-side and an
 * unknown/cross-tenant id surfaces a uniform `API_KEY_NOT_FOUND`, matching the
 * project/member route convention.
 */
export const apiKeyRouteParamsSchema = z.object({
  organizationId: z.string().min(1),
  apiKeyId: z.string().min(1),
});
export type ApiKeyRouteParams = z.infer<typeof apiKeyRouteParamsSchema>;

/** GET …/api-keys query params — the platform cursor pagination baseline. */
export { cursorPageParamsSchema as apiKeyListQuerySchema } from './pagination';
export type { CursorPageParams as ApiKeyListQuery } from './pagination';

// ---------------------------------------------------------------------------
// External read-only Projects API
// ---------------------------------------------------------------------------

/**
 * Public representation of a project on the EXTERNAL API. Deliberately distinct
 * from the internal `Project` DTO so the two surfaces evolve independently and
 * the external shape never accidentally inherits an internal-only field. The
 * organization id is the key's own tenant (derived from the key, not the
 * request), included so a client can correlate results.
 */
export const externalProjectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExternalProject = z.infer<typeof externalProjectSchema>;

/** GET /v1/external/projects query params — cursor pagination baseline. */
export { cursorPageParamsSchema as externalProjectListQuerySchema } from './pagination';
export type { CursorPageParams as ExternalProjectListQuery } from './pagination';

/** GET /v1/external/projects response — cursor-paginated active projects. */
export const externalProjectListResponseSchema = z.object({
  items: z.array(externalProjectSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ExternalProjectListResponse = z.infer<
  typeof externalProjectListResponseSchema
>;

// ---------------------------------------------------------------------------
// Error details
// ---------------------------------------------------------------------------

/**
 * Structured `details` carried by an `API_KEY_SCOPE_REQUIRED` error. Names the
 * scope the authenticated key is missing, so a client can explain the failure.
 */
export const apiKeyScopeErrorDetailsSchema = z.object({
  requiredScope: apiKeyScopeSchema,
});
export type ApiKeyScopeErrorDetails = z.infer<
  typeof apiKeyScopeErrorDetailsSchema
>;
