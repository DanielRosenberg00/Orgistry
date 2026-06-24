import {
  PERMISSION_KEYS,
  type EffectivePermissionsResponse,
  type PermissionKey,
  type PermissionListResponse,
  type PermissionMatrixResponse,
  type RoleListResponse,
} from '@orgistry/contracts';
import type { RbacService } from '../rbac/rbac.service';
import { requireMembership, requirePermission } from './access-control';
import type { AccessControlRepository } from './organization.types';

/**
 * Organization-scoped RBAC read workflows — the permission-enforced equivalents
 * of the global static RBAC reference endpoints.
 *
 * These compose the standard organization pipeline (requireMembership ->
 * requirePermission) and then return the SAME fixed reference data the global
 * endpoints expose, but only to a member of the organization who holds the
 * required permission:
 *
 *   GET …/roles               -> roles.read
 *   GET …/permissions         -> permissions.read
 *   GET …/permissions/matrix  -> permissions.read
 *   GET …/permissions/effective -> active membership only (the caller's OWN
 *                                  effective permissions; no extra gate)
 *
 * The reference DTOs themselves are built by `RbacService` (single source of the
 * mapping logic); this service adds the organization-scoped authorization.
 */
export interface OrganizationRbacServiceOptions {
  repo: AccessControlRepository;
  rbacService: RbacService;
}

export interface OrgScopedReadInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
}

export interface OrganizationRbacService {
  listRoles(input: OrgScopedReadInput): Promise<RoleListResponse>;
  listPermissions(input: OrgScopedReadInput): Promise<PermissionListResponse>;
  getMatrix(input: OrgScopedReadInput): Promise<PermissionMatrixResponse>;
  getEffectivePermissions(
    input: OrgScopedReadInput,
  ): Promise<EffectivePermissionsResponse>;
}

export function createOrganizationRbacService(
  options: OrganizationRbacServiceOptions,
): OrganizationRbacService {
  const { repo, rbacService } = options;

  return {
    async listRoles(input) {
      const actor = await requireMembership(repo, input);
      requirePermission(actor, PERMISSION_KEYS.rolesRead);
      return rbacService.listRoles();
    },

    async listPermissions(input) {
      const actor = await requireMembership(repo, input);
      requirePermission(actor, PERMISSION_KEYS.permissionsRead);
      return rbacService.listPermissions();
    },

    async getMatrix(input) {
      const actor = await requireMembership(repo, input);
      requirePermission(actor, PERMISSION_KEYS.permissionsRead);
      return rbacService.getMatrix();
    },

    async getEffectivePermissions(input) {
      // Any active member may read THEIR OWN effective permissions; membership is
      // the only requirement (no additional permission gate).
      const actor = await requireMembership(repo, input);
      return {
        organizationId: actor.organizationId,
        role: actor.role,
        permissions: [...actor.permissions] as PermissionKey[],
      };
    },
  };
}
