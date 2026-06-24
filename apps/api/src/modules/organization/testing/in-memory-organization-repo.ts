import {
  type MembershipRow,
  type OrganizationRow,
  ROLE_IDS,
} from '@orgistry/db';
import type { PermissionKey } from '@orgistry/contracts';
import { createId } from '@orgistry/shared';
import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import { lastOwnerRequiredError, memberNotFoundError } from '../member.errors';
import { MEMBER_EVENT_TYPES } from '../member.events';
import { organizationSlugTakenError } from '../organization.errors';
import { slugify } from '../organization.provisioning';
import type {
  ChangeMemberRoleParams,
  CreateTeamOrganizationParams,
  ListMembersParams,
  ListOrganizationsParams,
  MemberView,
  MembershipWithRole,
  OrganizationMembershipView,
  OrganizationRepository,
  RemoveMemberParams,
} from '../organization.types';
import type { InMemoryOrgStore } from './in-memory-org-store';

/**
 * In-memory `OrganizationRepository` for unit tests.
 *
 * Mirrors the database repository's observable behavior — prefixed IDs,
 * timestamps, slug uniqueness, the active-membership join, and keyset ordering —
 * over the shared `InMemoryOrgStore`, so organization workflows can be exercised
 * end-to-end through the HTTP layer with no PostgreSQL.
 */
export function createInMemoryOrganizationRepository(
  store: InMemoryOrgStore,
): OrganizationRepository {
  function isSlugTaken(slug: string): boolean {
    return store.organizations.some((org) => org.slug === slug);
  }

  function resolveUniqueSlug(base: string): string {
    let candidate = base;
    for (let suffix = 2; ; suffix += 1) {
      if (!isSlugTaken(candidate)) {
        return candidate;
      }
      candidate = `${base}-${suffix}`;
    }
  }

  function requireRole(roleId: string) {
    const role = store.roles.find((r) => r.id === roleId);
    if (!role) {
      throw new Error(`Role ${roleId} is missing from the role baseline.`);
    }
    return role;
  }

  function requireUser(userId: string) {
    const user = store.users.find((u) => u.id === userId);
    if (!user) {
      throw new Error(`User ${userId} is missing from the user table.`);
    }
    return user;
  }

  function toMemberView(membership: MembershipRow): MemberView {
    return {
      membership,
      role: requireRole(membership.roleId),
      user: requireUser(membership.userId),
    };
  }

  function activeOwnerCount(organizationId: string): number {
    return store.memberships.filter(
      (m) =>
        m.organizationId === organizationId &&
        m.status === 'active' &&
        m.roleId === ROLE_IDS.owner,
    ).length;
  }

  function recordMemberAuditEvent(input: {
    organizationId: string;
    actorUserId: string;
    eventType: string;
    metadata: Record<string, unknown>;
    requestId: string | null;
  }): void {
    store.securityEvents.push({
      userId: input.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata(input.metadata),
      requestId: input.requestId,
    });
  }

  return {
    async createTeamOrganization(params: CreateTeamOrganizationParams) {
      let slug: string;
      if (params.requestedSlug) {
        if (isSlugTaken(params.requestedSlug)) {
          throw organizationSlugTakenError();
        }
        slug = params.requestedSlug;
      } else {
        slug = resolveUniqueSlug(slugify(params.name));
      }

      const now = new Date();
      const organization: OrganizationRow = {
        id: createId('org'),
        name: params.name,
        slug,
        type: 'team',
        status: 'active',
        createdByUserId: params.userId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      const membership: MembershipRow = {
        id: createId('mem'),
        userId: params.userId,
        organizationId: organization.id,
        roleId: ROLE_IDS.owner,
        status: 'active',
        invitedByUserId: null,
        joinedAt: now,
        removedAt: null,
        removedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      store.organizations.push(organization);
      store.memberships.push(membership);
      return { organization, membership, role: requireRole(membership.roleId) };
    },

    async findOrganizationById(organizationId: string) {
      return (
        store.organizations.find((org) => org.id === organizationId) ?? null
      );
    },

    async findActiveMembership(
      userId: string,
      organizationId: string,
    ): Promise<MembershipWithRole | null> {
      const membership = store.memberships.find(
        (m) =>
          m.userId === userId &&
          m.organizationId === organizationId &&
          m.status === 'active',
      );
      if (!membership) {
        return null;
      }
      return { membership, role: requireRole(membership.roleId) };
    },

    async listActiveOrganizationsForUser(
      params: ListOrganizationsParams,
    ): Promise<OrganizationMembershipView[]> {
      const views = store.memberships
        .filter((m) => m.userId === params.userId && m.status === 'active')
        .map((membership) => {
          const organization = store.organizations.find(
            (org) => org.id === membership.organizationId,
          );
          return organization ? { membership, organization } : null;
        })
        .filter(
          (v): v is { membership: MembershipRow; organization: OrganizationRow } =>
            v !== null && v.organization.status === 'active',
        )
        .sort((a, b) => {
          const byCreated =
            b.membership.createdAt.getTime() - a.membership.createdAt.getTime();
          if (byCreated !== 0) {
            return byCreated;
          }
          return a.membership.id < b.membership.id ? 1 : -1;
        });

      const afterCursor = params.cursor
        ? views.filter((v) => {
            const created = v.membership.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs &&
              v.membership.id < params.cursor!.id
            );
          })
        : views;

      return afterCursor.slice(0, params.limit + 1).map((v) => ({
        organization: v.organization,
        membership: v.membership,
        role: requireRole(v.membership.roleId),
      }));
    },

    async findPermissionKeysForRole(roleId: string): Promise<PermissionKey[]> {
      const permissionIds = new Set(
        store.rolePermissions
          .filter((rp) => rp.roleId === roleId)
          .map((rp) => rp.permissionId),
      );
      return store.permissions
        .filter((p) => permissionIds.has(p.id))
        .map((p) => p.key);
    },

    async listActiveMembers(params: ListMembersParams): Promise<MemberView[]> {
      const ordered = store.memberships
        .filter(
          (m) =>
            m.organizationId === params.organizationId && m.status === 'active',
        )
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          return byCreated !== 0 ? byCreated : a.id < b.id ? 1 : -1;
        });

      const afterCursor = params.cursor
        ? ordered.filter((m) => {
            const created = m.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs &&
              m.id < params.cursor!.id
            );
          })
        : ordered;

      return afterCursor.slice(0, params.limit + 1).map(toMemberView);
    },

    // Synchronous read-classify-write (no await before the mutation) -> atomic
    // under Node's single-threaded loop, mirroring the DB transaction + row lock.
    async changeMemberRole(params: ChangeMemberRoleParams): Promise<MemberView> {
      const target = store.memberships.find(
        (m) => m.id === params.membershipId,
      );
      if (
        !target ||
        target.organizationId !== params.organizationId ||
        target.status !== 'active'
      ) {
        throw memberNotFoundError();
      }

      const demotingOwner =
        target.roleId === ROLE_IDS.owner && params.newRoleId !== ROLE_IDS.owner;
      if (demotingOwner && activeOwnerCount(params.organizationId) <= 1) {
        throw lastOwnerRequiredError();
      }

      const fromRoleId = target.roleId;
      target.roleId = params.newRoleId;
      target.updatedAt = new Date();

      recordMemberAuditEvent({
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        eventType: MEMBER_EVENT_TYPES.memberRoleChanged,
        metadata: {
          membershipId: params.membershipId,
          targetUserId: target.userId,
          fromRoleId,
          toRoleId: params.newRoleId,
        },
        requestId: params.ctx.requestId,
      });

      return toMemberView(target);
    },

    async removeMember(params: RemoveMemberParams): Promise<MemberView> {
      const target = store.memberships.find(
        (m) => m.id === params.membershipId,
      );
      if (!target || target.organizationId !== params.organizationId) {
        throw memberNotFoundError();
      }

      // Idempotent: removing an already-removed membership is a safe no-op.
      if (target.status === 'removed') {
        return toMemberView(target);
      }

      if (
        target.roleId === ROLE_IDS.owner &&
        activeOwnerCount(params.organizationId) <= 1
      ) {
        throw lastOwnerRequiredError();
      }

      const now = new Date();
      target.status = 'removed';
      target.removedAt = now;
      target.removedByUserId = params.actorUserId;
      target.updatedAt = now;

      recordMemberAuditEvent({
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        eventType: MEMBER_EVENT_TYPES.memberRemoved,
        metadata: {
          membershipId: params.membershipId,
          targetUserId: target.userId,
          roleId: target.roleId,
        },
        requestId: params.ctx.requestId,
      });

      return toMemberView(target);
    },
  };
}
