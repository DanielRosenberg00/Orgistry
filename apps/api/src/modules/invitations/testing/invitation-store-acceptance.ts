import {
  type InvitationRow,
  type MembershipRow,
  type OrganizationRow,
  type RoleRow,
} from '@orgistry/db';
import { ENTITLEMENT_KEYS } from '@orgistry/contracts';
import { createId } from '@orgistry/shared';
import { quotaExceededError } from '../../entitlements/entitlement.errors';
import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import {
  alreadyActiveMemberError,
  invitationEmailMismatchError,
  invitationInvalidError,
} from '../invitation.errors';
import { INVITATION_EVENT_TYPES } from '../invitation.events';
import { assertAcceptable } from '../invitation.lifecycle';
import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';

/**
 * In-memory mirror of the database acceptance transaction
 * (`invitation.acceptance.ts`), split into a non-mutating VALIDATE step and a
 * mutating APPLY step.
 *
 * The split exists so the in-memory auth repository can run validation EARLY
 * (before pushing any account rows) and apply at commit — preserving the same
 * "no partial state" atomicity the real registration transaction provides under
 * Node's single-threaded loop (there is no `await` between validate and apply).
 */

const INVITATION_TARGET_TYPE = 'invitation';
const MEMBERSHIP_TARGET_TYPE = 'membership';

export interface StoreAcceptanceParams {
  tokenHash: string;
  acceptingUserId: string;
  acceptingUserNormalizedEmail: string;
  maxMembers: number;
}

/**
 * Validate an acceptance against the store WITHOUT mutating it. Returns the
 * invitation row to accept, or throws the precise error (invalid / lifecycle /
 * email mismatch / already-member / quota) — the same order as the DB seam.
 */
export function validateInvitationForAcceptanceInStore(
  store: InMemoryOrgStore,
  params: StoreAcceptanceParams,
): InvitationRow {
  const now = new Date();
  const invitation = store.invitations.find(
    (inv) => inv.tokenHash === params.tokenHash,
  );
  if (!invitation) {
    throw invitationInvalidError();
  }
  assertAcceptable(invitation, now);
  if (
    invitation.invitedEmailNormalized !== params.acceptingUserNormalizedEmail
  ) {
    throw invitationEmailMismatchError();
  }
  const alreadyMember = store.memberships.some(
    (m) =>
      m.userId === params.acceptingUserId &&
      m.organizationId === invitation.organizationId &&
      m.status === 'active',
  );
  if (alreadyMember) {
    throw alreadyActiveMemberError();
  }
  const activeMembers = store.memberships.filter(
    (m) => m.organizationId === invitation.organizationId && m.status === 'active',
  ).length;
  if (activeMembers >= params.maxMembers) {
    throw quotaExceededError({
      quota: ENTITLEMENT_KEYS.maxMembers,
      limit: params.maxMembers,
      current: activeMembers,
    });
  }
  return invitation;
}

export interface StoreAcceptanceResult {
  membership: MembershipRow;
  organization: OrganizationRow;
  role: RoleRow;
}

/**
 * Apply a validated acceptance to the store: create the active membership, mark
 * the invitation accepted, and record both action events. Call ONLY after
 * `validateInvitationForAcceptanceInStore` has returned the same invitation.
 */
export function applyInvitationAcceptanceInStore(
  store: InMemoryOrgStore,
  invitation: InvitationRow,
  ctx: { acceptingUserId: string; requestId: string | null },
): StoreAcceptanceResult {
  const now = new Date();
  const organization = store.organizations.find(
    (org) => org.id === invitation.organizationId,
  ) as OrganizationRow;
  const role = store.roles.find((r) => r.id === invitation.roleId) as RoleRow;

  const membership: MembershipRow = {
    id: createId('mem'),
    userId: ctx.acceptingUserId,
    organizationId: invitation.organizationId,
    roleId: invitation.roleId,
    status: 'active',
    invitedByUserId: invitation.invitedByUserId,
    joinedAt: now,
    removedAt: null,
    removedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.memberships.push(membership);

  invitation.status = 'accepted';
  invitation.acceptedAt = now;
  invitation.acceptedByUserId = ctx.acceptingUserId;
  invitation.updatedAt = now;

  store.securityEvents.push({
    userId: ctx.acceptingUserId,
    organizationId: invitation.organizationId,
    actorType: 'user',
    eventType: INVITATION_EVENT_TYPES.accepted,
    metadata: sanitizeSecurityMetadata({
      actorMembershipId: null,
      targetType: INVITATION_TARGET_TYPE,
      targetInvitationId: invitation.id,
      targetUserId: ctx.acceptingUserId,
      targetMembershipId: membership.id,
      invitedEmailNormalized: invitation.invitedEmailNormalized,
      roleId: invitation.roleId,
    }),
    requestId: ctx.requestId,
  });
  store.securityEvents.push({
    userId: ctx.acceptingUserId,
    organizationId: invitation.organizationId,
    actorType: 'user',
    eventType: INVITATION_EVENT_TYPES.membershipCreatedFromInvitation,
    metadata: sanitizeSecurityMetadata({
      actorMembershipId: null,
      targetType: MEMBERSHIP_TARGET_TYPE,
      targetMembershipId: membership.id,
      targetUserId: ctx.acceptingUserId,
      targetInvitationId: invitation.id,
      roleId: invitation.roleId,
    }),
    requestId: ctx.requestId,
  });

  return { membership, organization, role };
}
