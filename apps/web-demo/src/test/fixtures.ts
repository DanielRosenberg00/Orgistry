import type {
  ApiKey,
  AuditEvent,
  AuthUser,
  EffectivePermissionsResponse,
  EntitlementsResponse,
  Invitation,
  Member,
  OrganizationPlanResponse,
  OrganizationWithMembership,
  PermissionKey,
  Project,
} from '@orgistry/contracts';

/**
 * Typed DTO fixtures used across the smoke tests. They are real contract shapes
 * (typed against `@orgistry/contracts`), so rendering them exercises the same
 * data the backend produces.
 */

export const USER: AuthUser = {
  id: 'usr_demo',
  email: 'admin@example.com',
  displayName: 'Demo Admin',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const ORGANIZATION: OrganizationWithMembership = {
  organization: {
    id: 'org_demo',
    name: 'Acme Inc',
    slug: 'acme-inc',
    type: 'team',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  membership: {
    id: 'mem_demo',
    status: 'active',
    role: { id: 'role_owner', key: 'owner', name: 'Owner' },
    joinedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

/** All permission keys an Owner holds — used as the default effective set. */
export const OWNER_PERMISSIONS: PermissionKey[] = [
  'org.read',
  'members.read',
  'members.change_role',
  'members.remove',
  'invitations.read',
  'invitations.create',
  'invitations.revoke',
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.delete',
  'api_keys.read',
  'api_keys.create',
  'api_keys.revoke',
  'audit_events.read',
  'plan.read',
  'plan.change_demo',
];

export function effectivePermissions(
  permissions: PermissionKey[] = OWNER_PERMISSIONS,
): EffectivePermissionsResponse {
  return {
    organizationId: ORGANIZATION.organization.id,
    role: ORGANIZATION.membership.role,
    permissions,
  };
}

export const MEMBER: Member = {
  id: 'mem_other',
  user: { id: 'usr_bea', email: 'bea@example.com', displayName: 'Bea Carter' },
  role: { id: 'role_member', key: 'member', name: 'Member' },
  status: 'active',
  joinedAt: '2026-01-05T00:00:00.000Z',
  createdAt: '2026-01-05T00:00:00.000Z',
  removedAt: null,
};

export const PROJECT: Project = {
  id: 'prj_demo',
  organizationId: 'org_demo',
  name: 'Website redesign',
  createdByUserId: 'usr_demo',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

export const INVITATION: Invitation = {
  id: 'inv_demo',
  organizationId: 'org_demo',
  invitedEmail: 'new@example.com',
  role: { id: 'role_member', key: 'member', name: 'Member' },
  status: 'pending',
  invitedByUserId: 'usr_demo',
  expiresAt: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
};

export const API_KEY: ApiKey = {
  id: 'key_demo',
  organizationId: 'org_demo',
  name: 'CI pipeline',
  displayPrefix: 'orgistry_AB12CD34',
  scopes: ['projects:read'],
  status: 'active',
  createdByUserId: 'usr_demo',
  createdAt: '2026-03-01T00:00:00.000Z',
  lastUsedAt: '2026-06-20T00:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
};

export const PLAN: OrganizationPlanResponse = {
  organizationId: 'org_demo',
  plan: { key: 'pro', name: 'Pro', description: 'Growth demo plan.' },
  assignedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const ENTITLEMENTS: EntitlementsResponse = {
  organizationId: 'org_demo',
  planKey: 'pro',
  entitlements: {
    max_members: 10,
    max_projects: 20,
    api_keys_access: true,
    max_api_keys: 5,
    audit_log_access: true,
    audit_retention_days: 30,
  },
};

export const AUDIT_EVENT: AuditEvent = {
  id: 'aud_demo',
  organizationId: 'org_demo',
  type: 'project.created',
  category: 'action',
  actor: {
    type: 'user',
    userId: 'usr_demo',
    membershipId: 'mem_demo',
    apiKeyId: null,
    label: 'Demo Admin',
  },
  target: { type: 'project', id: 'prj_demo', label: 'Website redesign' },
  metadata: { name: 'Website redesign' },
  requestId: 'req_demo_123',
  createdAt: '2026-06-21T10:00:00.000Z',
};
