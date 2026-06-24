import { z } from 'zod';
import { membershipStatusSchema, roleSummarySchema } from './organizations';

/**
 * Access-control contracts (Sprint 5) — the permission-first RBAC boundary.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the fixed v1 role keys, the
 * fixed v1 permission catalog, and the canonical role→permission mapping. The
 * database seed (`@orgistry/db`) derives its seed rows from these constants, the
 * API's `requirePermission` helper checks these typed keys, and the read-only
 * roles/permissions/matrix endpoints reflect the SEEDED rows (which originate
 * here) so nothing can drift.
 *
 * Hard rules carried over from the auth/organization contracts:
 *  - permissions are the authorization primitive — business authorization checks
 *    a permission KEY, never a role name;
 *  - roles and permissions are fixed in v1 — there is no creation/edit/delete
 *    surface and no per-organization custom role;
 *  - DTOs never carry persistence-only columns, password hashes, or
 *    auth/session internals;
 *  - permission keys are NOT entitlements and NOT quotas — a key existing in the
 *    catalog does not imply the owning module is implemented.
 */

// ---------------------------------------------------------------------------
// Fixed v1 role keys
// ---------------------------------------------------------------------------

/**
 * The fixed v1 system role keys. Stable machine strings; clients and code may
 * branch on them ONLY for structural role-identity invariants (e.g. Last Owner
 * protection) — never for ordinary authorization, which uses permission keys.
 *
 * These mirror `ROLE_KEYS` in `@orgistry/db`; the API asserts the two agree.
 */
export const ROLE_KEYS = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
} as const;

export const roleKeySchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type RoleKey = z.infer<typeof roleKeySchema>;

/** The fixed v1 role keys in canonical (most→least privileged) order. */
export const ROLE_KEY_ORDER: readonly RoleKey[] = [
  ROLE_KEYS.owner,
  ROLE_KEYS.admin,
  ROLE_KEYS.member,
  ROLE_KEYS.viewer,
];

// ---------------------------------------------------------------------------
// Fixed v1 permission catalog
// ---------------------------------------------------------------------------

/**
 * The fixed v1 permission catalog keys.
 *
 * Keys are dotted `<resource>.<action>` strings. Some keys (invitations.*,
 * projects.*, api_keys.*, audit_events.*, plan.*) are reserved for modules that
 * are NOT implemented in Sprint 5 — they exist so the catalog and the
 * role→permission mapping are stable, not because the owning feature exists.
 */
export const PERMISSION_KEYS = {
  orgRead: 'org.read',
  orgUpdate: 'org.update',
  membersRead: 'members.read',
  membersInvite: 'members.invite',
  membersChangeRole: 'members.change_role',
  membersRemove: 'members.remove',
  invitationsRead: 'invitations.read',
  invitationsCreate: 'invitations.create',
  invitationsRevoke: 'invitations.revoke',
  rolesRead: 'roles.read',
  permissionsRead: 'permissions.read',
  projectsRead: 'projects.read',
  projectsCreate: 'projects.create',
  projectsUpdate: 'projects.update',
  projectsDelete: 'projects.delete',
  apiKeysRead: 'api_keys.read',
  apiKeysCreate: 'api_keys.create',
  apiKeysRevoke: 'api_keys.revoke',
  auditEventsRead: 'audit_events.read',
  planRead: 'plan.read',
  planChangeDemo: 'plan.change_demo',
  sessionsRead: 'sessions.read',
  sessionsRevoke: 'sessions.revoke',
} as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

/** All permission keys, in catalog order. */
export const PERMISSION_KEY_LIST: readonly PermissionKey[] = Object.values(
  PERMISSION_KEYS,
);

export const permissionKeySchema = z.enum(
  PERMISSION_KEY_LIST as [PermissionKey, ...PermissionKey[]],
);

/** A single catalog entry: a stable key plus human-readable metadata. */
export interface PermissionCatalogEntry {
  key: PermissionKey;
  /** Short, human display name. */
  name: string;
  /** What the permission authorizes. Describes a capability, not a module's status. */
  description: string;
}

/**
 * The canonical permission catalog. Order here is the order surfaced by the
 * permissions/matrix endpoints and used to build the seed.
 */
export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = [
  { key: PERMISSION_KEYS.orgRead, name: 'Read organization', description: 'View organization details.' },
  { key: PERMISSION_KEYS.orgUpdate, name: 'Update organization', description: 'Edit organization settings.' },
  { key: PERMISSION_KEYS.membersRead, name: 'Read members', description: 'List the organization\'s members.' },
  { key: PERMISSION_KEYS.membersInvite, name: 'Invite members', description: 'Invite people to the organization.' },
  { key: PERMISSION_KEYS.membersChangeRole, name: 'Change member roles', description: 'Change the role of a member.' },
  { key: PERMISSION_KEYS.membersRemove, name: 'Remove members', description: 'Remove a member from the organization.' },
  { key: PERMISSION_KEYS.invitationsRead, name: 'Read invitations', description: 'View pending invitations.' },
  { key: PERMISSION_KEYS.invitationsCreate, name: 'Create invitations', description: 'Create new invitations.' },
  { key: PERMISSION_KEYS.invitationsRevoke, name: 'Revoke invitations', description: 'Revoke pending invitations.' },
  { key: PERMISSION_KEYS.rolesRead, name: 'Read roles', description: 'View the role catalog.' },
  { key: PERMISSION_KEYS.permissionsRead, name: 'Read permissions', description: 'View the permission catalog and matrix.' },
  { key: PERMISSION_KEYS.projectsRead, name: 'Read projects', description: 'View projects.' },
  { key: PERMISSION_KEYS.projectsCreate, name: 'Create projects', description: 'Create new projects.' },
  { key: PERMISSION_KEYS.projectsUpdate, name: 'Update projects', description: 'Edit existing projects.' },
  { key: PERMISSION_KEYS.projectsDelete, name: 'Delete projects', description: 'Delete projects.' },
  { key: PERMISSION_KEYS.apiKeysRead, name: 'Read API keys', description: 'View API keys.' },
  { key: PERMISSION_KEYS.apiKeysCreate, name: 'Create API keys', description: 'Create new API keys.' },
  { key: PERMISSION_KEYS.apiKeysRevoke, name: 'Revoke API keys', description: 'Revoke API keys.' },
  { key: PERMISSION_KEYS.auditEventsRead, name: 'Read audit events', description: 'View organization audit events.' },
  { key: PERMISSION_KEYS.planRead, name: 'Read plan', description: 'View the organization\'s plan.' },
  { key: PERMISSION_KEYS.planChangeDemo, name: 'Change plan (demo)', description: 'Change the organization\'s demo plan.' },
  { key: PERMISSION_KEYS.sessionsRead, name: 'Read sessions', description: 'View organization sessions.' },
  { key: PERMISSION_KEYS.sessionsRevoke, name: 'Revoke sessions', description: 'Revoke organization sessions.' },
];

// ---------------------------------------------------------------------------
// Canonical role → permission mapping (the matrix source of truth)
// ---------------------------------------------------------------------------

const P = PERMISSION_KEYS;

/**
 * The canonical v1 role→permission assignment.
 *
 * Semantics:
 *  - Owner   — every permission in the catalog.
 *  - Admin   — broadly capable: everything EXCEPT `plan.change_demo`, the single
 *              Owner-only capability (so an Owner is always strictly more capable
 *              than an Admin). Member management is granted; the structural Last
 *              Owner invariant — enforced transactionally regardless of role —
 *              still prevents an Admin from demoting/removing the last Owner.
 *  - Member  — organization/resource read plus normal project contribution
 *              (read/create/update), and may read the org's RBAC reference data
 *              (roles.read / permissions.read), but has no administrative or
 *              member-management surface.
 *  - Viewer  — read-only visibility of the organization and its first-class
 *              resources only. Viewer does NOT receive `roles.read` /
 *              `permissions.read` (RBAC introspection is treated as an
 *              administrative/contributor concern) and does NOT receive
 *              `members.read` (the member roster is withheld from the most
 *              restricted role), giving a clean privilege gradient.
 *
 * This object IS the matrix: the database seed is generated from it, and the
 * matrix endpoint returns the seeded rows that originate here.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly PermissionKey[]>> = {
  owner: PERMISSION_KEY_LIST,
  admin: [
    P.orgRead, P.orgUpdate,
    P.membersRead, P.membersInvite, P.membersChangeRole, P.membersRemove,
    P.invitationsRead, P.invitationsCreate, P.invitationsRevoke,
    P.rolesRead, P.permissionsRead,
    P.projectsRead, P.projectsCreate, P.projectsUpdate, P.projectsDelete,
    P.apiKeysRead, P.apiKeysCreate, P.apiKeysRevoke,
    P.auditEventsRead,
    P.planRead,
    P.sessionsRead, P.sessionsRevoke,
  ],
  member: [
    P.orgRead,
    P.membersRead,
    P.rolesRead, P.permissionsRead,
    P.projectsRead, P.projectsCreate, P.projectsUpdate,
    P.planRead,
  ],
  viewer: [
    P.orgRead,
    P.projectsRead,
    P.planRead,
  ],
};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Public Role DTO (roles list / matrix). Identity + description only — a role
 * never carries its permissions inline; the matrix expresses the mapping.
 */
export const roleSchema = z.object({
  id: z.string(),
  key: roleKeySchema,
  name: z.string(),
  description: z.string(),
});
export type Role = z.infer<typeof roleSchema>;

/**
 * Public Permission DTO. The stable public identifier is the `key`; the internal
 * `perm_…` row id is never exposed.
 */
export const permissionSchema = z.object({
  key: permissionKeySchema,
  name: z.string(),
  description: z.string(),
});
export type Permission = z.infer<typeof permissionSchema>;

/** GET /v1/roles response. The fixed role set (not paginated — always four). */
export const roleListResponseSchema = z.object({
  items: z.array(roleSchema),
});
export type RoleListResponse = z.infer<typeof roleListResponseSchema>;

/** GET /v1/permissions response. The fixed catalog (not paginated). */
export const permissionListResponseSchema = z.object({
  items: z.array(permissionSchema),
});
export type PermissionListResponse = z.infer<typeof permissionListResponseSchema>;

/**
 * GET /v1/permissions/matrix response. Roles, the permission catalog, and the
 * mapping (keyed by role key → permission keys). Built from the SEEDED rows so
 * it can never drift from what `requirePermission` actually enforces.
 */
export const permissionMatrixResponseSchema = z.object({
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
  matrix: z.record(roleKeySchema, z.array(permissionKeySchema)),
});
export type PermissionMatrixResponse = z.infer<typeof permissionMatrixResponseSchema>;

/**
 * GET /v1/organizations/:organizationId/permissions response. The authenticated
 * caller's EFFECTIVE permissions in one organization, derived from their active
 * membership's role through the role→permission mapping.
 */
export const effectivePermissionsResponseSchema = z.object({
  organizationId: z.string(),
  role: roleSummarySchema,
  permissions: z.array(permissionKeySchema),
});
export type EffectivePermissionsResponse = z.infer<
  typeof effectivePermissionsResponseSchema
>;

/**
 * Minimal, secret-free view of a user as seen inside a member listing. Carries
 * identity and contact display only — NEVER password hashes, normalized email,
 * verification state, or any auth/session internal.
 */
export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * Public Member DTO. The organization-scoped view of one membership: who the
 * member is (user summary), their role, and lifecycle timestamps. No auth or
 * session internals cross this boundary.
 */
export const memberSchema = z.object({
  id: z.string(),
  user: userSummarySchema,
  role: roleSummarySchema,
  status: membershipStatusSchema,
  joinedAt: z.string(),
  createdAt: z.string(),
  removedAt: z.string().nullable(),
});
export type Member = z.infer<typeof memberSchema>;

/** GET /v1/organizations/:organizationId/members response (cursor-paginated). */
export const memberListResponseSchema = z.object({
  items: z.array(memberSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

/**
 * PATCH …/members/:membershipId/role request. The new role is one of the fixed
 * system role keys; any other value is a validation error.
 */
export const memberRoleChangeRequestSchema = z.object({
  role: roleKeySchema,
});
export type MemberRoleChangeRequest = z.infer<typeof memberRoleChangeRequestSchema>;

/** PATCH …/members/:membershipId/role response. */
export const memberRoleChangeResponseSchema = z.object({
  member: memberSchema,
});
export type MemberRoleChangeResponse = z.infer<typeof memberRoleChangeResponseSchema>;

/** DELETE …/members/:membershipId response (the now-removed member). */
export const memberRemovalResponseSchema = z.object({
  member: memberSchema,
});
export type MemberRemovalResponse = z.infer<typeof memberRemovalResponseSchema>;
