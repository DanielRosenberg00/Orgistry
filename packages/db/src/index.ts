export {
  createDbClient,
  type DbClient,
  type Database,
  type Transaction,
  type DbExecutor,
} from './client';
export { pingDatabase } from './health';
export { runMigrations, MIGRATIONS_FOLDER } from './migrator';
export * as schema from './schema/index';

// Row/insert types are re-exported at the top level for ergonomic consumption
// by repositories in `apps/api`.
export type {
  UserStatus,
  SecurityActorType,
  UserRow,
  UserInsert,
  SessionRow,
  SessionInsert,
  RefreshTokenRow,
  RefreshTokenInsert,
  SecurityEventInsert,
} from './schema/auth';

// Organization foundation (Sprint 4).
export {
  ROLE_KEYS,
  ROLE_IDS,
  ROLE_SEED,
} from './schema/organizations';
export type {
  RoleKey,
  OrganizationType,
  OrganizationStatus,
  MembershipStatus,
  RoleRow,
  OrganizationRow,
  OrganizationInsert,
  MembershipRow,
  MembershipInsert,
} from './schema/organizations';

// Permissions & role-permission mapping (Sprint 5).
export {
  permissionRowId,
  PERMISSION_SEED,
  ROLE_PERMISSION_SEED,
} from './schema/permissions';
export type {
  PermissionRow,
  PermissionInsert,
  RolePermissionRow,
} from './schema/permissions';

// Projects — first organization-scoped business resource (Sprint 6).
export type { ProjectRow, ProjectInsert } from './schema/projects';

// Plans, entitlements & quotas (Sprint 7).
export {
  DEFAULT_PLAN_KEY,
  planRowId,
  PLAN_SEED,
} from './schema/plans';
export type {
  PlanKey,
  PlanRow,
  PlanInsert,
  OrganizationPlanRow,
  OrganizationPlanInsert,
} from './schema/plans';
