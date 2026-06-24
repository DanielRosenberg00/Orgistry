import { ROLE_IDS, type RoleRow, type UserRow } from '@orgistry/db';
import {
  ERROR_CODES,
  PERMISSION_KEYS,
  type Member,
  type MemberListResponse,
  type MemberRemovalResponse,
  type MemberRoleChangeResponse,
  type RoleKey,
  type RoleSummary,
  type UserSummary,
} from '@orgistry/contracts';
import { decodeCursor, encodeCursor } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import {
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from './access-control';
import type { MemberAuditContext, MemberView, OrganizationRepository } from './organization.types';

/**
 * Member-management workflows (listing, role change, removal).
 *
 * The organization-scoped RBAC READ surfaces (roles / permissions / matrix /
 * effective permissions) live in `org-rbac.service.ts`; this module is the
 * member lifecycle only.
 *
 * Every method composes the standard organization-scoped pipeline:
 *
 *   requireMembership (active member of this org?)
 *     -> requirePermission (does the actor hold the permission key?)
 *       -> repository workflow (transactional where it mutates)
 *         -> map persistence rows to public DTOs (never raw rows)
 *
 * Authorization is ALWAYS by permission key, never by role name. The one
 * structural role check — the Last Owner invariant — lives in the repository
 * transaction, not here. The service never returns a raw database row and never
 * exposes auth/session internals (password hashes, normalized email, etc.).
 */

export interface MemberServiceOptions {
  repo: OrganizationRepository;
}

export interface ListMembersInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
  limit: number;
  cursor: string | null;
}

export interface ChangeMemberRoleInput {
  userId: string;
  organizationId: string;
  membershipId: string;
  newRole: RoleKey;
  ctx: MemberAuditContext;
}

export interface RemoveMemberInput {
  userId: string;
  organizationId: string;
  membershipId: string;
  ctx: MemberAuditContext;
}

export interface MemberService {
  listMembers(input: ListMembersInput): Promise<MemberListResponse>;
  changeMemberRole(input: ChangeMemberRoleInput): Promise<MemberRoleChangeResponse>;
  removeMember(input: RemoveMemberInput): Promise<MemberRemovalResponse>;
}

/** Internal member-list cursor shape. Opaque to clients. */
interface MemberCursor {
  c: number; // membership createdAt epoch millis
  i: string; // membership id (tiebreak)
}

/** Map a role row to the identity-only role summary (never permissions). */
function toRoleSummary(role: RoleRow): RoleSummary {
  return { id: role.id, key: role.key, name: role.name };
}

/** Map a user row to the secret-free user summary (no hash, no normalized email). */
function toUserSummary(user: UserRow): UserSummary {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/** Map a membership + role + user to the public Member DTO. */
function toMember(view: MemberView): Member {
  return {
    id: view.membership.id,
    user: toUserSummary(view.user),
    role: toRoleSummary(view.role),
    status: view.membership.status,
    joinedAt: view.membership.joinedAt.toISOString(),
    createdAt: view.membership.createdAt.toISOString(),
    removedAt: view.membership.removedAt
      ? view.membership.removedAt.toISOString()
      : null,
  };
}

/** Decode a member-list cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeMemberCursor(
  cursor: string | null,
): { createdAtMs: number; id: string } | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<MemberCursor>(cursor);
  if (!decoded || typeof decoded.c !== 'number' || typeof decoded.i !== 'string') {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

export function createMemberService(
  options: MemberServiceOptions,
): MemberService {
  const { repo } = options;

  /** Resolve the actor (active membership + effective permissions) for a request. */
  async function actorFor(input: {
    userId: string;
    organizationId: string;
    requestId: string | null;
  }): Promise<OrganizationActor> {
    return requireMembership(repo, {
      userId: input.userId,
      organizationId: input.organizationId,
      requestId: input.requestId,
    });
  }

  return {
    async listMembers(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.membersRead);

      const rows = await repo.listActiveMembers({
        organizationId: actor.organizationId,
        limit: input.limit,
        cursor: decodeMemberCursor(input.cursor),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.membership.createdAt.getTime(),
              i: last.membership.id,
            } satisfies MemberCursor)
          : null;

      return { items: page.map(toMember), nextCursor, hasMore };
    },

    async changeMemberRole(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.membersChangeRole);

      // The new role is a fixed system role (validated at the contract boundary);
      // map it to its stable seeded id. The Last Owner invariant is enforced
      // transactionally inside the repository.
      const view = await repo.changeMemberRole({
        organizationId: actor.organizationId,
        membershipId: input.membershipId,
        newRoleId: ROLE_IDS[input.newRole],
        actorUserId: actor.userId,
        ctx: input.ctx,
      });

      return { member: toMember(view) };
    },

    async removeMember(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.membersRemove);

      const view = await repo.removeMember({
        organizationId: actor.organizationId,
        membershipId: input.membershipId,
        actorUserId: actor.userId,
        ctx: input.ctx,
      });

      return { member: toMember(view) };
    },
  };
}
