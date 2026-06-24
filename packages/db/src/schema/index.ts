/**
 * Schema registry.
 *
 * Drizzle reads every table re-exported from this barrel. New schema files are
 * added here as later sprints introduce tables. Keeping a single registry means
 * `drizzle-kit generate` and the runtime client always see the same schema.
 */
export { appMeta, type AppMetaRow } from './meta';
export {
  users,
  sessions,
  refreshTokens,
  emailVerificationTokens,
  securityEvents,
  type UserStatus,
  type SecurityActorType,
  type UserRow,
  type UserInsert,
  type SessionRow,
  type SessionInsert,
  type RefreshTokenRow,
  type EmailVerificationTokenRow,
  type SecurityEventRow,
  type SecurityEventInsert,
} from './auth';
export {
  roles,
  organizations,
  memberships,
  ROLE_KEYS,
  ROLE_IDS,
  ROLE_SEED,
  type RoleKey,
  type OrganizationType,
  type OrganizationStatus,
  type MembershipStatus,
  type RoleRow,
  type OrganizationRow,
  type OrganizationInsert,
  type MembershipRow,
  type MembershipInsert,
} from './organizations';
export {
  permissions,
  rolePermissions,
  permissionRowId,
  PERMISSION_SEED,
  ROLE_PERMISSION_SEED,
  type PermissionRow,
  type PermissionInsert,
  type RolePermissionRow,
} from './permissions';
export {
  projects,
  type ProjectRow,
  type ProjectInsert,
} from './projects';
export {
  plans,
  organizationPlans,
  PLAN_KEYS,
  DEFAULT_PLAN_KEY,
  planRowId,
  PLAN_SEED,
  type PlanKey,
  type PlanRow,
  type PlanInsert,
  type OrganizationPlanRow,
  type OrganizationPlanInsert,
} from './plans';
export {
  apiKeys,
  type ApiKeyRow,
  type ApiKeyInsert,
} from './api-keys';
