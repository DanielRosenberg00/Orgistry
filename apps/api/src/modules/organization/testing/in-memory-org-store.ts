import {
  type ApiKeyRow,
  type MembershipRow,
  type OrganizationPlanRow,
  type OrganizationRow,
  type PermissionRow,
  type PlanRow,
  type ProjectRow,
  type RolePermissionRow,
  type RoleRow,
  type UserRow,
  DEFAULT_PLAN_KEY,
  PERMISSION_SEED,
  PLAN_SEED,
  ROLE_PERMISSION_SEED,
  ROLE_SEED,
} from '@orgistry/db';
import { createId } from '@orgistry/shared';

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
  /** Organization-scoped API keys (Sprint 8), written by the in-memory API key repo. */
  apiKeys: ApiKeyRow[];
  /** Fixed internal demo plan catalog (Sprint 7), pre-seeded from PLAN_SEED. */
  plans: PlanRow[];
  /**
   * Per-organization current-plan state (Sprint 7). Written at org provisioning
   * (registration / team creation) and updated by a demo plan change.
   */
  organizationPlans: OrganizationPlanRow[];
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
  const plans: PlanRow[] = PLAN_SEED.map((seed) => ({
    id: seed.id,
    key: seed.key,
    name: seed.name,
    description: seed.description,
    maxMembers: seed.maxMembers,
    maxProjects: seed.maxProjects,
    apiKeysAccess: seed.apiKeysAccess,
    maxApiKeys: seed.maxApiKeys,
    auditLogAccess: seed.auditLogAccess,
    auditRetentionDays: seed.auditRetentionDays,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    organizations: [],
    memberships: [],
    roles,
    permissions,
    rolePermissions,
    users: [],
    projects: [],
    apiKeys: [],
    plans,
    organizationPlans: [],
    securityEvents: [],
  };
}

/**
 * Provision default plan state for a newly created organization — the in-memory
 * mirror of the database provisioning seam
 * (`insertOrganizationWithOwnerMembership`). Both registration and team-org
 * creation call this so every organization receives the default Free plan,
 * exactly as production does.
 */
export function provisionDefaultOrganizationPlan(
  store: InMemoryOrgStore,
  organizationId: string,
  createdByUserId: string,
): OrganizationPlanRow {
  const now = new Date();
  const planState: OrganizationPlanRow = {
    id: createId('oplan'),
    organizationId,
    planKey: DEFAULT_PLAN_KEY,
    assignedAt: now,
    changedByUserId: createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
  store.organizationPlans.push(planState);
  return planState;
}
