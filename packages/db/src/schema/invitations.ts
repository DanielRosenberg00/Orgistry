import { createId } from '@orgistry/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations, roles } from './organizations';

/**
 * Invitation persistence (Sprint 9) — the organization invitation lifecycle.
 *
 * An invitation is a single-use, expiring grant that lets ONE email join ONE
 * organization with ONE fixed role. Every invitation belongs to exactly one
 * organization (the `organization_id` is the tenant authority boundary, never
 * trusted from a request body) and references one seeded role.
 *
 * Secret handling rules (inherited from the auth token tables):
 *  - the raw invitation token is NEVER stored. Only a deterministic SHA-256 hash
 *    lives in `token_hash`, which is unique so a presented token resolves to at
 *    most one row. The raw token is delivered only in the invitation email and
 *    is unrecoverable from the database.
 *
 * Lifecycle is explicit and append-only: an invitation is `pending`, then
 * terminally `accepted` or `revoked`. Rows are NEVER hard-deleted — an
 * invitation is a durable lifecycle record. Expiry is DERIVED from `expires_at`
 * at read/accept time (there is no background expiration job and no persisted
 * `expired` status), so a still-`pending` row past its deadline is treated as
 * expired everywhere it is presented.
 */

// Shared timestamp helpers — identical to the organization schema's audit columns.
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Persisted invitation status. Only `pending`, `accepted`, and `revoked` are
 * ever WRITTEN; `expired` is a derived presentation state (see the file header)
 * and is included in the type for completeness only.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export const invitations = pgTable(
  'invitations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('inv')),
    // The owning tenant. Every query is scoped by this column; it is the
    // authority boundary and is taken from the route, never a request body.
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    // The address the invitation was issued to, as the inviter typed it (display).
    invitedEmail: text('invited_email').notNull(),
    // Lowercased/trimmed invited email. Email-match on acceptance and the
    // duplicate-pending guard both use this normalized form.
    invitedEmailNormalized: text('invited_email_normalized').notNull(),
    // The fixed system role the invitee receives on acceptance. References the
    // seeded role baseline; not a permission grant.
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    // SHA-256 of the raw token. The raw value is emailed once and never stored.
    tokenHash: text('token_hash').notNull(),
    status: text('status').$type<InvitationStatus>().notNull().default('pending'),
    // The user who created the invitation.
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => users.id),
    // Set when the invitation is accepted (who accepted it). Null while pending.
    acceptedByUserId: text('accepted_by_user_id').references(() => users.id),
    // Set when the invitation is revoked (who revoked it). Null while pending.
    revokedByUserId: text('revoked_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Authentication lookup: resolve a presented token by its hash. Unique so a
    // hash maps to at most one row (a hash collision is rejected at insert).
    uniqueIndex('uq_invitations_token_hash').on(table.tokenHash),
    // Duplicate-pending guard: at most ONE pending invitation per
    // (organization, normalized email). A partial unique index on
    // `status = 'pending'` lets a new invitation be issued after a prior one is
    // accepted/revoked, while preventing two outstanding invitations for the
    // same address. This is the authoritative guard; the service does a friendly
    // pre-check.
    uniqueIndex('uq_invitations_org_email_pending')
      .on(table.organizationId, table.invitedEmailNormalized)
      .where(sql`${table.status} = 'pending'`),
    // Primary list/pagination access path: one organization's invitations
    // ordered by (created_at desc, id desc).
    index('ix_invitations_org_created').on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    // Tenant-scoped point lookup: resolve an invitation by (organization_id, id).
    index('ix_invitations_org_id').on(table.organizationId, table.id),
  ],
);

export type InvitationRow = typeof invitations.$inferSelect;
export type InvitationInsert = typeof invitations.$inferInsert;
