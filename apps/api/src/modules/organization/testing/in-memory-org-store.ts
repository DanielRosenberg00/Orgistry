import {
  type MembershipRow,
  type OrganizationRow,
  type PermissionRow,
  type ProjectRow,
  type RolePermissionRow,
  type RoleRow,
  type UserRow,
  PERMISSION_SEED,
  ROLE_PERMISSION_SEED,
  ROLE_SEED,
} from '@orgistry/db';

/**
 * Shared in-memory organization persistence for unit/route tests.
 *
 * Registration (auth module) and the organization service write to and read
 * from the SAME organization/membership tables. The in-memory fakes for both
 * modules therefore share ONE store so a route test can register a user and
 * then see their personal workspace through the organization endpoints — exactly
 * as the database-backed code does.
 *
 * `roles`, `permissions`, and `rolePermissions` are pre-seeded from the canonical
 * seeds (`ROLE_SEED`, `PERMISSION_SEED`, `ROLE_PERMISSION_SEED`) so role
 * assignment, the role join, and effective-permission resolution behave like the
 * migrated database. `users` is shared so member listings can join user records;
 * the auth in-memory repo writes its users here. `securityEvents` is the
 * member-management audit seam's sink.
 */
export interface RecordedSecurityEvent {
  userId: string | null;
  organizationId: string | null;
  actorType: string;
  eventType: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

export interface InMemoryOrgStore {
  organizations: OrganizationRow[];
  memberships: MembershipRow[];
  roles: RoleRow[];
  permissions: PermissionRow[];
  rolePermissions: RolePermissionRow[];
  /** Shared user records (also written by the auth in-memory repo at registration). */
  users: UserRow[];
  /** Organization-scoped projects (Sprint 6), written by the in-memory project repo. */
  projects: ProjectRow[];
  /** Member-management & project action events recorded by the in-memory repos. */
  securityEvents: RecordedSecurityEvent[];
}

export function createInMemoryOrgStore(): InMemoryOrgStore {
  const now = new Date();
  const roles: RoleRow[] = ROLE_SEED.map((seed) => ({
    id: seed.id,
    key: seed.key,
    name: seed.name,
    description: seed.description,
    isSystem: true,
    createdAt: now,
    updatedAt: now,
  }));
  const permissions: PermissionRow[] = PERMISSION_SEED.map((seed) => ({
    id: seed.id,
    key: seed.key,
    name: seed.name,
    description: seed.description,
    createdAt: now,
    updatedAt: now,
  }));
  const rolePermissions: RolePermissionRow[] = ROLE_PERMISSION_SEED.map(
    (seed) => ({
      roleId: seed.roleId,
      permissionId: seed.permissionId,
      createdAt: now,
    }),
  );
  return {
    organizations: [],
    memberships: [],
    roles,
    permissions,
    rolePermissions,
    users: [],
    projects: [],
    securityEvents: [],
  };
}
