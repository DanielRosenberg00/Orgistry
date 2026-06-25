import type {
  Database,
  DbExecutor,
  InvitationRow,
  RoleRow,
} from '@orgistry/db';
import { schema } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { and, count, desc, eq, gt, lt, or } from 'drizzle-orm';
import {
  acceptInvitationWithinTransaction,
  recordInvitationEvent,
} from './invitation.acceptance';
import {
  duplicatePendingInvitationError,
  invitationInvalidError,
} from './invitation.errors';
import { INVITATION_EVENT_TYPES } from './invitation.events';
import { assertAcceptable } from './invitation.lifecycle';
import type {
  AcceptInvitationParams,
  AcceptInvitationResult,
  CreateInvitationParams,
  InvitationContextView,
  InvitationRepository,
  InvitationView,
  ListInvitationsParams,
  RevokeInvitationParams,
} from './invitation.types';

/** Stable target type recorded on every invitation action event. */
const INVITATION_TARGET_TYPE = 'invitation';

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

function uniqueViolationConstraint(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  ) {
    const constraint = (error as { constraint_name?: unknown }).constraint_name;
    return typeof constraint === 'string' ? constraint : '';
  }
  return null;
}

/** Load a seeded role row by id (always present for a referenced role). */
async function loadRole(executor: DbExecutor, roleId: string): Promise<RoleRow> {
  const [role] = await executor
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.id, roleId))
    .limit(1);
  if (!role) {
    throw new Error(`Role ${roleId} is missing from the role baseline.`);
  }
  return role;
}

/**
 * Drizzle-backed implementation of the tenant-aware invitation persistence
 * boundary. All invitation SQL lives here; the service depends only on
 * `InvitationRepository`. The acceptance transaction body is shared with the
 * registration flow (see `invitation.acceptance.ts`).
 *
 * Rules that hold for every method:
 *  1. management reads/mutations are scoped by `organization_id` — an invitation
 *     is never addressed by id alone, so cross-tenant access cannot occur;
 *  2. the raw token is never persisted (only its hash) and never appears in any
 *     event metadata;
 *  3. invitations are never hard-deleted — every transition is a status change.
 */
export function createDbInvitationRepository(
  db: Database,
): InvitationRepository {
  return {
    async createInvitation(
      params: CreateInvitationParams,
    ): Promise<InvitationView> {
      try {
        return await db.transaction(async (tx) => {
          // Lazy expiry: free the partial-unique slot held by any STALE (expired)
          // pending invitation for this email before inserting the new one. A
          // still-valid pending row is left intact, so the unique index then
          // rejects the insert (mapped to a duplicate-pending conflict below).
          const now = new Date();
          await tx
            .update(schema.invitations)
            .set({ status: 'expired', updatedAt: now })
            .where(
              and(
                eq(schema.invitations.organizationId, params.organizationId),
                eq(
                  schema.invitations.invitedEmailNormalized,
                  params.invitedEmailNormalized,
                ),
                eq(schema.invitations.status, 'pending'),
                lt(schema.invitations.expiresAt, now),
              ),
            );

          const [invitation] = await tx
            .insert(schema.invitations)
            .values({
              id: createId('inv'),
              organizationId: params.organizationId,
              invitedEmail: params.invitedEmail,
              invitedEmailNormalized: params.invitedEmailNormalized,
              roleId: params.roleId,
              tokenHash: params.tokenHash,
              status: 'pending',
              invitedByUserId: params.ctx.actorUserId,
              expiresAt: params.expiresAt,
            })
            .returning();

          await recordInvitationEvent(tx, {
            organizationId: params.organizationId,
            eventType: INVITATION_EVENT_TYPES.created,
            metadata: {
              targetType: INVITATION_TARGET_TYPE,
              targetInvitationId: invitation.id,
              invitedEmailNormalized: invitation.invitedEmailNormalized,
              roleId: invitation.roleId,
            },
            ctx: params.ctx,
          });

          return { invitation, role: await loadRole(tx, invitation.roleId) };
        });
      } catch (error) {
        // The partial unique index on (organization_id, invited_email_normalized)
        // WHERE status='pending' is the authoritative duplicate-pending guard.
        if (
          uniqueViolationConstraint(error) === 'uq_invitations_org_email_pending'
        ) {
          throw duplicatePendingInvitationError();
        }
        throw error;
      }
    },

    async listInvitations(
      params: ListInvitationsParams,
    ): Promise<InvitationView[]> {
      // Keyset pagination on (created_at desc, id desc) within the organization.
      // Every lifecycle state is listed (status is presented), so no status filter.
      const cursorClause = params.cursor
        ? or(
            lt(
              schema.invitations.createdAt,
              new Date(params.cursor.createdAtMs),
            ),
            and(
              eq(
                schema.invitations.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.invitations.id, params.cursor.id),
            ),
          )
        : undefined;

      return db
        .select({ invitation: schema.invitations, role: schema.roles })
        .from(schema.invitations)
        .innerJoin(schema.roles, eq(schema.invitations.roleId, schema.roles.id))
        .where(
          and(
            eq(schema.invitations.organizationId, params.organizationId),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(desc(schema.invitations.createdAt), desc(schema.invitations.id))
        .limit(params.limit + 1);
    },

    async findContextByTokenHash(
      tokenHash: string,
    ): Promise<InvitationContextView | null> {
      const [row] = await db
        .select({
          invitation: schema.invitations,
          role: schema.roles,
          organization: schema.organizations,
        })
        .from(schema.invitations)
        .innerJoin(schema.roles, eq(schema.invitations.roleId, schema.roles.id))
        .innerJoin(
          schema.organizations,
          eq(schema.invitations.organizationId, schema.organizations.id),
        )
        .where(eq(schema.invitations.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async acceptInvitation(
      params: AcceptInvitationParams,
    ): Promise<AcceptInvitationResult> {
      // The acceptance body is shared with the registration transaction; here it
      // runs in its own transaction for the existing-user accept endpoint.
      return db.transaction((tx) => acceptInvitationWithinTransaction(tx, params));
    },

    async revokeInvitation(params: RevokeInvitationParams): Promise<void> {
      await db.transaction(async (tx) => {
        const now = new Date();

        // Lock the invitation, scoped by org + id. A missing or cross-tenant
        // invitation is a uniform not-found.
        const [invitation] = await tx
          .select()
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.organizationId, params.organizationId),
              eq(schema.invitations.id, params.invitationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!invitation) {
          throw invitationInvalidError();
        }

        // Only a pending, non-expired invitation may be revoked. Accepted /
        // revoked / expired each surface their precise, stable error.
        assertAcceptable(invitation, now);

        await tx
          .update(schema.invitations)
          .set({
            status: 'revoked',
            revokedAt: now,
            revokedByUserId: params.ctx.actorUserId,
            updatedAt: now,
          })
          .where(eq(schema.invitations.id, invitation.id));

        await recordInvitationEvent(tx, {
          organizationId: params.organizationId,
          eventType: INVITATION_EVENT_TYPES.revoked,
          metadata: {
            targetType: INVITATION_TARGET_TYPE,
            targetInvitationId: invitation.id,
            invitedEmailNormalized: invitation.invitedEmailNormalized,
            roleId: invitation.roleId,
          },
          ctx: params.ctx,
        });
      });
    },

    async findPendingInvitation(
      organizationId: string,
      invitedEmailNormalized: string,
    ): Promise<InvitationRow | null> {
      const now = new Date();
      // Only a NON-expired pending invitation is an active reservation; a stale
      // (expired) pending row does not block re-inviting.
      const [row] = await db
        .select()
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.organizationId, organizationId),
            eq(
              schema.invitations.invitedEmailNormalized,
              invitedEmailNormalized,
            ),
            eq(schema.invitations.status, 'pending'),
            gt(schema.invitations.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async hasActiveMemberWithEmail(
      organizationId: string,
      invitedEmailNormalized: string,
    ): Promise<boolean> {
      const [row] = await db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
        .where(
          and(
            eq(schema.memberships.organizationId, organizationId),
            eq(schema.memberships.status, 'active'),
            eq(schema.users.normalizedEmail, invitedEmailNormalized),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async countPendingInvitations(organizationId: string): Promise<number> {
      const now = new Date();
      // Reservation basis: non-expired pending invitations only.
      const [row] = await db
        .select({ value: count() })
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.organizationId, organizationId),
            eq(schema.invitations.status, 'pending'),
            gt(schema.invitations.expiresAt, now),
          ),
        );
      return row?.value ?? 0;
    },
  };
}
