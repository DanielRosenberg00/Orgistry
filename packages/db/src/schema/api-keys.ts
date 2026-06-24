import type { ApiKeyScope } from '@orgistry/contracts';
import { createId } from '@orgistry/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './auth';

/**
 * API key persistence (Sprint 8) — organization-scoped MACHINE credentials.
 *
 * An API key is NOT a user session and never impersonates a user. It belongs to
 * exactly ONE organization (the tenant authority boundary, derived from the key
 * row on the external API — never from a client request) and carries its own
 * typed scopes that govern what it may do once it authenticates.
 *
 * Secret handling rules (inherited from the auth token tables):
 *  - the raw secret is NEVER stored. Only a deterministic SHA-256 hash of the
 *    secret component lives in `secret_hash`, which is unique so a presented key
 *    resolves to at most one row;
 *  - `display_prefix` is the safe, non-secret identifier shown to humans;
 *  - the raw secret is returned by the create response exactly once and is
 *    unrecoverable thereafter.
 *
 * Lifecycle is explicit and append-only: a key is REVOKED (`revoked_at` +
 * `revoked_by_user_id`), never hard-deleted during normal operation. A revoked
 * or expired key cannot authenticate.
 */

// Shared timestamp helpers — identical to the organization schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('key')),
    // The owning tenant. Every query is scoped by this column; on the external
    // API it is derived from the key row, never trusted from the request.
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    // Display-safe identifier (the key prefix, e.g. `orgistry_AB12CD34`). Never
    // the secret — safe to show in lists and logs.
    displayPrefix: text('display_prefix').notNull(),
    // SHA-256 of the secret component. The raw secret is shown once and never
    // stored; this hash is the only persisted, lookup-able representation.
    secretHash: text('secret_hash').notNull(),
    // Typed scopes (`projects:read`, …). Stored as JSON so the set can grow
    // without a schema change; values are validated against the scope enum.
    scopes: jsonb('scopes').$type<ApiKeyScope[]>().notNull(),
    // Optional expiry. Null means the key never expires.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Last successful authentication. Written with throttling (not on every
    // request); null until first use.
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Revocation markers. A null `revoked_at` means active; a set value is
    // terminal and blocks authentication. `revoked_by_user_id` records who did it.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: text('revoked_by_user_id').references(() => users.id),
    // The actor that created the key (recorded from the authenticated user).
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Authentication lookup: resolve a presented key by its secret hash. Unique
    // so a hash maps to at most one row (and a hash collision is rejected).
    uniqueIndex('uq_api_keys_secret_hash').on(table.secretHash),
    // Management list/pagination: one organization's keys ordered by
    // (created_at desc, id desc). Lists include active AND revoked keys (status
    // is shown), so this index is intentionally NOT partial.
    index('ix_api_keys_org_created').on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    // Active-key filtering / quota counting: the active set per organization.
    // Partial on `revoked_at IS NULL` so revoked keys never bloat the scan.
    index('ix_api_keys_org_active')
      .on(table.organizationId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
