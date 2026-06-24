import type { PermissionKey, RoleKey } from '@orgistry/contracts';
import { resolveOrganizationContext } from './organization.context';
import { permissionDeniedError } from './member.errors';
import type { AccessControlRepository } from './organization.types';

/**
 * Organization-scoped access control — the reusable authorization layer every
 * organization-scoped route composes on top of authentication.
 *
 * The composition for an organization-scoped route is always:
 *
 *   authenticate (Bearer)            // who is the user?            -> auth boundary
 *     -> requireMembership(...)      // active member of this org?  -> OrganizationActor
 *       -> requirePermission(actor, key)  // may they do this?      -> permission check
 *
 * Two non-negotiable rules live here:
 *  1. Removed/inactive memberships never authorize anything — `requireMembership`
 *     resolves ONLY active memberships in active organizations (and fails with an
 *     indistinguishable 404 otherwise, so non-members cannot probe).
 *  2. Ordinary authorization checks a PERMISSION KEY, never a role name. The
 *     effective permission set is derived once (through the role→permission
 *     mapping) when the actor is built; `requirePermission` is a pure check
 *     against that set. Role names are reserved for structural invariants (Last
 *     Owner) handled elsewhere — they never appear in route authorization.
 */

/**
 * Server-derived actor context for an organization-scoped request. Everything
 * here is resolved from the authenticated user + organization id on the server;
 * the client never supplies any of it. Suitable to thread into future
 * organization-scoped workflows (projects, invitations, API keys, audit).
 */
export interface OrganizationActor {
  /** The authenticated user. */
  userId: string;
  /** The organization the actor is acting within (the tenant authority boundary). */
  organizationId: string;
  /** The actor's active membership in that organization. */
  membershipId: string;
  /** The actor's role identity (for structural invariants and display — NOT for authorization). */
  role: {
    id: string;
    key: RoleKey;
    name: string;
  };
  /** The actor's effective permissions, derived from the role→permission mapping. */
  permissions: ReadonlySet<PermissionKey>;
  /** The originating request id, when available (for audit/security records). */
  requestId: string | null;
}

export interface RequireMembershipInput {
  userId: string;
  organizationId: string;
  /** Request id carried into the actor for downstream audit records. */
  requestId?: string | null;
}

/**
 * Resolve and authorize an organization-scoped actor.
 *
 * Verifies (via `resolveOrganizationContext`) that the organization exists, is
 * active, and that the user has an ACTIVE membership in it — then derives the
 * membership role's effective permissions through the role→permission mapping
 * and returns a complete `OrganizationActor`.
 *
 * Fails safely: a missing organization, an inactive organization, and a
 * missing/removed membership all surface the same `ORGANIZATION_NOT_FOUND` 404,
 * so cross-organization access is indistinguishable from non-existence.
 */
export async function requireMembership(
  repo: AccessControlRepository,
  input: RequireMembershipInput,
): Promise<OrganizationActor> {
  const context = await resolveOrganizationContext(repo, {
    userId: input.userId,
    organizationId: input.organizationId,
  });

  const permissionKeys = await repo.findPermissionKeysForRole(context.role.id);

  return {
    userId: input.userId,
    organizationId: context.organization.id,
    membershipId: context.membership.id,
    role: {
      id: context.role.id,
      key: context.role.key,
      name: context.role.name,
    },
    permissions: new Set(permissionKeys),
    requestId: input.requestId ?? null,
  };
}

/** True when the actor's effective permissions include `permission`. */
export function actorHasPermission(
  actor: OrganizationActor,
  permission: PermissionKey,
): boolean {
  return actor.permissions.has(permission);
}

/**
 * Require that the actor holds `permission`, or reject with a standard 403.
 *
 * This is a pure check against the already-resolved effective permission set —
 * the authorization primitive for every organization-scoped mutation/read. It
 * never branches on the actor's role name.
 */
export function requirePermission(
  actor: OrganizationActor,
  permission: PermissionKey,
): void {
  if (!actorHasPermission(actor, permission)) {
    throw permissionDeniedError();
  }
}
