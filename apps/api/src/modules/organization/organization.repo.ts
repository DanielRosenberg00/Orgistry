import type { Database, DbExecutor, RoleRow } from '@orgistry/db';
import { ROLE_IDS, schema } from '@orgistry/db';
import type { PermissionKey } from '@orgistry/contracts';
import { createId } from '@orgistry/shared';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import { memberNotFoundError, lastOwnerRequiredError } from './member.errors';
import { MEMBER_EVENT_TYPES, type MemberEventType } from './member.events';
import { organizationSlugTakenError } from './organization.errors';
import {
  insertOrganizationWithOwnerMembership,
  isSlugTaken,
  resolveUniqueSlug,
  slugify,
} from './organization.provisioning';
import type {
  ChangeMemberRoleParams,
  CreateTeamOrganizationParams,
  ListMembersParams,
  ListOrganizationsParams,
  MemberAuditContext,
  MemberView,
  MembershipWithRole,
  OrganizationMembershipView,
  OrganizationRepository,
  RemoveMemberParams,
} from './organization.types';

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Drizzle-backed implementation of the organization persistence boundary. All
 * SQL for the organization module lives here; the service depends only on
 * `OrganizationRepository`.
 */
export function createDbOrganizationRepository(
  db: Database,
): OrganizationRepository {
  async function loadOwnerRole(
    executor: DbExecutor,
    roleId: string,
  ): Promise<RoleRow> {
    const [role] = await executor
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, roleId))
      .limit(1);
    // The role baseline is seeded by migration; a membership always references
    // a seeded role, so this is present in practice.
    if (!role) {
      throw new Error(`Role ${roleId} is missing from the role baseline.`);
    }
    return role;
  }

  /**
   * Record an organization-scoped member-management audit event in the same
   * transaction as the mutation. Metadata is sanitized; secrets never appear here.
   */
  async function recordMemberAuditEvent(
    executor: DbExecutor,
    input: {
      organizationId: string;
      actorUserId: string;
      eventType: MemberEventType;
      metadata: Record<string, unknown>;
      ctx: MemberAuditContext;
    },
  ): Promise<void> {
    await executor.insert(schema.securityEvents).values({
      id: createId('sevt'),
      userId: input.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata(input.metadata),
      ipAddress: input.ctx.ipAddress,
      userAgent: input.ctx.userAgent,
      requestId: input.ctx.requestId,
    });
  }

  /** Lock the organization's active-owner memberships, returning their ids. */
  async function lockActiveOwners(
    executor: DbExecutor,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.organizationId, organizationId),
          eq(schema.memberships.status, 'active'),
          eq(schema.memberships.roleId, ROLE_IDS.owner),
        ),
      )
      // Deterministic lock order serializes concurrent owner-affecting mutations
      // on the same organization, so the Last Owner check can never race.
      .orderBy(schema.memberships.id)
      .for('update');
    return rows.map((row) => row.id);
  }

  /** Load a member view (membership + role + user) by membership id, or null. */
  async function loadMemberView(
    executor: DbExecutor,
    membershipId: string,
  ): Promise<MemberView | null> {
    const [row] = await executor
      .select({
        membership: schema.memberships,
        role: schema.roles,
        user: schema.users,
      })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.memberships.roleId, schema.roles.id))
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.id, membershipId))
      .limit(1);
    return row ?? null;
  }

  return {
    async createTeamOrganization(params: CreateTeamOrganizationParams) {
      try {
        return await db.transaction(async (tx) => {
          // Slug policy: an explicit slug is honored or rejected (never silently
          // changed); a derived slug is auto-resolved to a free value.
          let slug: string;
          if (params.requestedSlug) {
            if (await isSlugTaken(tx, params.requestedSlug)) {
              throw organizationSlugTakenError();
            }
            slug = params.requestedSlug;
          } else {
            slug = await resolveUniqueSlug(tx, slugify(params.name));
          }

          const { organization, membership } =
            await insertOrganizationWithOwnerMembership(tx, {
              type: 'team',
              name: params.name,
              slug,
              createdByUserId: params.userId,
              ownerUserId: params.userId,
            });

          const role = await loadOwnerRole(tx, membership.roleId);
          return { organization, membership, role };
        });
      } catch (error) {
        // The unique index on slug is the authoritative guard for the
        // check-then-insert race; surface the same public conflict.
        if (isUniqueViolation(error)) {
          throw organizationSlugTakenError();
        }
        throw error;
      }
    },

    async findOrganizationById(organizationId: string) {
      const [organization] = await db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId))
        .limit(1);
      return organization ?? null;
    },

    async findActiveMembership(
      userId: string,
      organizationId: string,
    ): Promise<MembershipWithRole | null> {
      const [row] = await db
        .select({ membership: schema.memberships, role: schema.roles })
        .from(schema.memberships)
        .innerJoin(schema.roles, eq(schema.memberships.roleId, schema.roles.id))
        .where(
          and(
            eq(schema.memberships.userId, userId),
            eq(schema.memberships.organizationId, organizationId),
            eq(schema.memberships.status, 'active'),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listActiveOrganizationsForUser(
      params: ListOrganizationsParams,
    ): Promise<OrganizationMembershipView[]> {
      // Keyset pagination on (membership.created_at desc, membership.id desc).
      const cursorClause = params.cursor
        ? or(
            lt(
              schema.memberships.createdAt,
              new Date(params.cursor.createdAtMs),
            ),
            and(
              eq(
                schema.memberships.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.memberships.id, params.cursor.id),
            ),
          )
        : undefined;

      const rows = await db
        .select({
          organization: schema.organizations,
          membership: schema.memberships,
          role: schema.roles,
        })
        .from(schema.memberships)
        .innerJoin(
          schema.organizations,
          eq(schema.memberships.organizationId, schema.organizations.id),
        )
        .innerJoin(schema.roles, eq(schema.memberships.roleId, schema.roles.id))
        .where(
          and(
            eq(schema.memberships.userId, params.userId),
            eq(schema.memberships.status, 'active'),
            // Only active organizations are listed — removed/archived orgs are
            // never surfaced through the user-facing list.
            eq(schema.organizations.status, 'active'),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(
          desc(schema.memberships.createdAt),
          desc(schema.memberships.id),
        )
        .limit(params.limit + 1);

      return rows;
    },

    async findPermissionKeysForRole(roleId: string): Promise<PermissionKey[]> {
      const rows = await db
        .select({ key: schema.permissions.key })
        .from(schema.rolePermissions)
        .innerJoin(
          schema.permissions,
          eq(schema.rolePermissions.permissionId, schema.permissions.id),
        )
        .where(eq(schema.rolePermissions.roleId, roleId));
      return rows.map((row) => row.key);
    },

    async listActiveMembers(params: ListMembersParams): Promise<MemberView[]> {
      // Keyset pagination on (membership.created_at desc, membership.id desc),
      // identical to the organization-list keyset. Removed members are excluded.
      const cursorClause = params.cursor
        ? or(
            lt(
              schema.memberships.createdAt,
              new Date(params.cursor.createdAtMs),
            ),
            and(
              eq(
                schema.memberships.createdAt,
                new Date(params.cursor.createdAtMs),
              ),
              lt(schema.memberships.id, params.cursor.id),
            ),
          )
        : undefined;

      const rows = await db
        .select({
          membership: schema.memberships,
          role: schema.roles,
          user: schema.users,
        })
        .from(schema.memberships)
        .innerJoin(schema.roles, eq(schema.memberships.roleId, schema.roles.id))
        .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
        .where(
          and(
            eq(schema.memberships.organizationId, params.organizationId),
            eq(schema.memberships.status, 'active'),
            ...(cursorClause ? [cursorClause] : []),
          ),
        )
        .orderBy(
          desc(schema.memberships.createdAt),
          desc(schema.memberships.id),
        )
        .limit(params.limit + 1);

      return rows;
    },

    async changeMemberRole(params: ChangeMemberRoleParams): Promise<MemberView> {
      return db.transaction(async (tx) => {
        // Lock the active-owner set FIRST (deterministic order) so concurrent
        // owner-affecting mutations serialize and the invariant cannot race.
        const activeOwnerIds = await lockActiveOwners(tx, params.organizationId);

        const [target] = await tx
          .select()
          .from(schema.memberships)
          .where(eq(schema.memberships.id, params.membershipId))
          .for('update')
          .limit(1);

        // Only an ACTIVE member of THIS organization is addressable.
        if (
          !target ||
          target.organizationId !== params.organizationId ||
          target.status !== 'active'
        ) {
          throw memberNotFoundError();
        }

        const demotingOwner =
          target.roleId === ROLE_IDS.owner &&
          params.newRoleId !== ROLE_IDS.owner;
        // Last Owner invariant: demoting the only active Owner is forbidden.
        if (demotingOwner && activeOwnerIds.length <= 1) {
          throw lastOwnerRequiredError();
        }

        const fromRoleId = target.roleId;
        await tx
          .update(schema.memberships)
          .set({ roleId: params.newRoleId, updatedAt: new Date() })
          .where(eq(schema.memberships.id, params.membershipId));

        await recordMemberAuditEvent(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          eventType: MEMBER_EVENT_TYPES.memberRoleChanged,
          metadata: {
            membershipId: params.membershipId,
            targetUserId: target.userId,
            fromRoleId,
            toRoleId: params.newRoleId,
          },
          ctx: params.ctx,
        });

        const view = await loadMemberView(tx, params.membershipId);
        if (!view) {
          // Unreachable: we just updated this row inside the transaction.
          throw new Error('Member view missing after role change.');
        }
        return view;
      });
    },

    async removeMember(params: RemoveMemberParams): Promise<MemberView> {
      return db.transaction(async (tx) => {
        const activeOwnerIds = await lockActiveOwners(tx, params.organizationId);

        const [target] = await tx
          .select()
          .from(schema.memberships)
          .where(eq(schema.memberships.id, params.membershipId))
          .for('update')
          .limit(1);

        if (!target || target.organizationId !== params.organizationId) {
          throw memberNotFoundError();
        }

        // Idempotent: removing an already-removed membership is a safe no-op.
        if (target.status === 'removed') {
          const existing = await loadMemberView(tx, params.membershipId);
          if (!existing) {
            throw new Error('Member view missing for removed membership.');
          }
          return existing;
        }

        // Last Owner invariant: removing the only active Owner is forbidden.
        if (target.roleId === ROLE_IDS.owner && activeOwnerIds.length <= 1) {
          throw lastOwnerRequiredError();
        }

        const now = new Date();
        await tx
          .update(schema.memberships)
          .set({
            status: 'removed',
            removedAt: now,
            removedByUserId: params.actorUserId,
            updatedAt: now,
          })
          .where(eq(schema.memberships.id, params.membershipId));

        await recordMemberAuditEvent(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          eventType: MEMBER_EVENT_TYPES.memberRemoved,
          metadata: {
            membershipId: params.membershipId,
            targetUserId: target.userId,
            roleId: target.roleId,
          },
          ctx: params.ctx,
        });

        const view = await loadMemberView(tx, params.membershipId);
        if (!view) {
          throw new Error('Member view missing after removal.');
        }
        return view;
      });
    },
  };
}
