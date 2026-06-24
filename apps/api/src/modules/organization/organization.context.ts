import type { MembershipRow, OrganizationRow, RoleRow } from '@orgistry/db';
import { organizationNotFoundError } from './organization.errors';
import type { MembershipWithRole } from './organization.types';

/**
 * Reusable organization context resolver.
 *
 * This is the baseline every future organization-scoped route will build on: it
 * resolves and authorizes access to a single organization for an authenticated
 * user. It verifies, in order, that the organization exists, is active, and that
 * the user has an ACTIVE membership in it — then returns the organization +
 * membership context.
 *
 * Authorization here is membership-based and keyed on organization ID. It does
 * NOT check permissions and does NOT branch on role NAME — it is intentionally
 * not the future `requirePermission` helper. When permissions arrive, they layer
 * ON TOP of this resolver; they do not replace it.
 *
 * Failure is uniform: a missing organization, an inactive organization, and a
 * missing/removed membership all surface the SAME `ORGANIZATION_NOT_FOUND`, so a
 * caller can never distinguish "does not exist" from "you are not a member" —
 * organizations the user does not belong to never leak.
 */

export interface OrganizationContext {
  organization: OrganizationRow;
  membership: MembershipRow;
  role: RoleRow;
}

/** The repository surface the resolver needs (a subset of OrganizationRepository). */
export interface OrganizationContextRepository {
  findOrganizationById(organizationId: string): Promise<OrganizationRow | null>;
  findActiveMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipWithRole | null>;
}

export async function resolveOrganizationContext(
  repo: OrganizationContextRepository,
  input: { userId: string; organizationId: string },
): Promise<OrganizationContext> {
  const organization = await repo.findOrganizationById(input.organizationId);
  // Not found OR not active -> indistinguishable 404 (no lifecycle leak).
  if (!organization || organization.status !== 'active') {
    throw organizationNotFoundError();
  }

  const membership = await repo.findActiveMembership(
    input.userId,
    input.organizationId,
  );
  // No active membership -> identical 404 so non-members cannot probe existence.
  if (!membership) {
    throw organizationNotFoundError();
  }

  return {
    organization,
    membership: membership.membership,
    role: membership.role,
  };
}
