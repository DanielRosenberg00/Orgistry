import type {
  MembershipRow,
  OrganizationRow,
  OrganizationType,
  RoleRow,
  UserRow,
} from '@orgistry/db';
import type { PermissionKey } from '@orgistry/contracts';
import type { OrganizationContextRepository } from './organization.context';

/**
 * Internal organization-module types.
 *
 * `OrganizationRow`/`MembershipRow`/`RoleRow`/`UserRow` are the persistence
 * shapes; they are used INSIDE the module only and are never returned from a
 * route — the service maps them to the public `@orgistry/contracts` DTOs first.
 */

/** A membership paired with its (organization-scoped) role. */
export interface MembershipWithRole {
  membership: MembershipRow;
  role: RoleRow;
}

/** A membership paired with its role and the member's user record. */
export interface MemberView {
  membership: MembershipRow;
  role: RoleRow;
  user: UserRow;
}

/** Cursor-pagination inputs for listing an organization's active members. */
export interface ListMembersParams {
  organizationId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (membership createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/**
 * Per-request context attached to a member-management audit event. Carries only
 * non-secret request metadata; secrets are never placed here.
 */
export interface MemberAuditContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Inputs for a transactional member role change. */
export interface ChangeMemberRoleParams {
  organizationId: string;
  membershipId: string;
  /** The new role's seeded id (resolved from a fixed role key). */
  newRoleId: string;
  /** The acting user (for the audit event). */
  actorUserId: string;
  ctx: MemberAuditContext;
}

/** Inputs for a transactional member removal. */
export interface RemoveMemberParams {
  organizationId: string;
  membershipId: string;
  /** The acting user (recorded as `removedByUserId` and in the audit event). */
  actorUserId: string;
  ctx: MemberAuditContext;
}

/**
 * The repository surface the access-control helpers need: organization-context
 * resolution plus effective-permission resolution for a role. Defining it as an
 * extension of `OrganizationContextRepository` lets `requireMembership` /
 * `requirePermission` depend on the narrowest possible interface.
 */
export interface AccessControlRepository extends OrganizationContextRepository {
  /** The effective permission keys granted to a role via the role→permission mapping. */
  findPermissionKeysForRole(roleId: string): Promise<PermissionKey[]>;
}

/** An organization paired with the caller's membership and that membership's role. */
export interface OrganizationMembershipView {
  organization: OrganizationRow;
  membership: MembershipRow;
  role: RoleRow;
}

/** Inputs for creating a team organization (the creator becomes its Owner). */
export interface CreateTeamOrganizationParams {
  /** The authenticated user creating (and owning) the organization. */
  userId: string;
  name: string;
  /** Explicit slug requested by the client; auto-derived when omitted. */
  requestedSlug?: string;
}

/** Cursor-pagination inputs for listing a user's organizations. */
export interface ListOrganizationsParams {
  userId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (membership createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/**
 * Persistence boundary for the organization workflows.
 *
 * Defining the repository as an interface lets the service be unit-tested with
 * an in-memory fake and keeps all organization SQL in `organization.repo.ts`.
 */
export interface OrganizationRepository extends AccessControlRepository {
  /**
   * Atomically create a team organization and the creator's active Owner
   * membership. Resolves slug uniqueness (see the repo implementation).
   */
  createTeamOrganization(
    params: CreateTeamOrganizationParams,
  ): Promise<OrganizationMembershipView>;

  /** Look up an organization by its ID (any status), or null. */
  findOrganizationById(organizationId: string): Promise<OrganizationRow | null>;

  /** The caller's ACTIVE membership in an organization (with its role), or null. */
  findActiveMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipWithRole | null>;

  /**
   * List the active organizations where the user has an active membership,
   * newest membership first, one page at a time. Returns up to `limit + 1` rows
   * so the caller can detect a further page without a second query.
   */
  listActiveOrganizationsForUser(
    params: ListOrganizationsParams,
  ): Promise<OrganizationMembershipView[]>;

  /**
   * List an organization's ACTIVE members (with user + role), newest membership
   * first, one page at a time. Returns up to `limit + 1` rows so the caller can
   * detect a further page. Removed memberships are excluded.
   */
  listActiveMembers(params: ListMembersParams): Promise<MemberView[]>;

  /**
   * Change a member's role, transactionally enforcing the Last Owner invariant.
   *
   * Within a single transaction it locks the organization's active-owner set,
   * validates the target is an active member of the organization, rejects a
   * demotion that would remove the last active Owner (`LAST_OWNER_REQUIRED`),
   * applies the change, and records an audit event. Throws `MEMBER_NOT_FOUND`
   * when the target is not an active member of the organization.
   */
  changeMemberRole(params: ChangeMemberRoleParams): Promise<MemberView>;

  /**
   * Soft-remove a member, transactionally enforcing the Last Owner invariant.
   *
   * Within a single transaction it locks the organization's active-owner set,
   * validates the target belongs to the organization, rejects removing the last
   * active Owner (`LAST_OWNER_REQUIRED`), marks the membership removed (status +
   * removedAt + removedByUserId), and records an audit event. Idempotent: an
   * already-removed membership is returned unchanged. Throws `MEMBER_NOT_FOUND`
   * when the target does not belong to the organization. Rows are never deleted.
   */
  removeMember(params: RemoveMemberParams): Promise<MemberView>;
}

export type { OrganizationType };
