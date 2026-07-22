import type { DbExecutor } from '@orgistry/db';
import { schema } from '@orgistry/db';
import { ENTITLEMENT_KEYS } from '@orgistry/contracts';
import { and, count, eq } from 'drizzle-orm';
import { createId } from '@orgistry/shared';
import { quotaExceededError } from '../entitlements/entitlement.errors';
import { acquireOrganizationQuotaLock } from '../entitlements/quota-lock';
import { lockOrganizationEntitlements } from '../entitlements/entitlement.snapshot';
import { sanitizeSecurityMetadata } from '../../lib/security-metadata';
import {
  alreadyActiveMemberError,
  invitationEmailMismatchError,
  invitationInvalidError,
} from './invitation.errors';
import {
  INVITATION_EVENT_TYPES,
  type InvitationEventType,
} from './invitation.events';
import { assertAcceptable } from './invitation.lifecycle';
import type {
  AcceptInvitationParams,
  AcceptInvitationResult,
  InvitationActionContext,
} from './invitation.types';

/**
 * The invitation acceptance transaction body — the SINGLE security-sensitive
 * seam that turns a valid token into an active membership.
 *
 * It is written against a `DbExecutor` (a transaction handle) rather than a
 * `Database` so it can run inside ANY caller's transaction:
 *  - the invitation repository wraps it in its own `db.transaction` for the
 *    existing-user accept endpoint;
 *  - the auth repository runs it INSIDE the registration transaction, so a
 *    new user's account, personal workspace, invited membership, and invitation
 *    acceptance all commit or roll back together (no partial state).
 *
 * The checks run in a fixed, auditable order:
 *   0. organization member-quota lock (Sprint 20 — serializes DISTINCT-token
 *      acceptances and every other member-capacity consumer), then the plan
 *      snapshot resolved through THIS transaction (plan row FOR SHARE)
 *   1. lookup (locked by token hash)
 *   2. lifecycle validation (accepted / revoked / expired)
 *   3. email match
 *   4. duplicate active membership prevention
 *   5. active-member quota (now race-free under the step-0 lock)
 *   6. membership creation
 *   7. invitation accepted mutation
 *   8. event recording (invitation.accepted + membership.created_from_invitation)
 *
 * The raw token and its hash NEVER appear in event metadata.
 */

const INVITATION_TARGET_TYPE = 'invitation';
const MEMBERSHIP_TARGET_TYPE = 'membership';

/** PostgreSQL unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Record an invitation action event on the existing organization-scoped
 * `security_events` seam, using the caller's executor so the event commits with
 * the mutation. Metadata is sanitized; the raw token and hash never appear here.
 * Shared by create / revoke / accept so the event shape stays identical.
 */
export async function recordInvitationEvent(
  executor: DbExecutor,
  input: {
    organizationId: string;
    eventType: InvitationEventType;
    metadata: Record<string, unknown>;
    ctx: InvitationActionContext;
  },
): Promise<void> {
  await executor.insert(schema.securityEvents).values({
    id: createId('sevt'),
    userId: input.ctx.actorUserId,
    organizationId: input.organizationId,
    actorType: 'user',
    eventType: input.eventType,
    metadata: sanitizeSecurityMetadata({
      actorMembershipId: input.ctx.actorMembershipId,
      ...input.metadata,
    }),
    ipAddress: input.ctx.ipAddress,
    userAgent: input.ctx.userAgent,
    requestId: input.ctx.requestId,
  });
}

export async function acceptInvitationWithinTransaction(
  tx: DbExecutor,
  params: AcceptInvitationParams,
): Promise<AcceptInvitationResult> {
  const now = new Date();

  const lookup =
    'tokenHash' in params.selector
      ? eq(schema.invitations.tokenHash, params.selector.tokenHash)
      : eq(schema.invitations.id, params.selector.invitationId);

  // 0. Member-quota serialization (Sprint 20, ORG-PR-029): the row lock below
  //    only serializes acceptances of the SAME invitation; two DISTINCT valid
  //    tokens for one organization would each count `limit - 1` members and
  //    both insert. The organization's member-quota lock serializes all
  //    member-capacity consumers. The organization id comes from a non-locking
  //    pre-read (it is immutable on an invitation row), so the quota lock is
  //    acquired BEFORE any invitation row lock — the documented lock order.
  const [preRead] = await tx
    .select({ organizationId: schema.invitations.organizationId })
    .from(schema.invitations)
    .where(lookup)
    .limit(1);
  if (!preRead) {
    throw invitationInvalidError();
  }
  await acquireOrganizationQuotaLock(tx, preRead.organizationId, 'members');

  // 0b. Plan snapshot — the `max_members` ceiling is resolved INSIDE this
  //     transaction (plan row FOR SHARE), never captured by a caller
  //     beforehand: plan assignment is runtime-mutable, so a pre-resolved
  //     limit could reflect a plan state that no longer exists. The FOR SHARE
  //     lock also blocks a concurrent plan change from committing between
  //     this read and the membership insert.
  const { values } = await lockOrganizationEntitlements(
    tx,
    preRead.organizationId,
  );

  // 1. Lookup — lock the invitation row so two concurrent acceptances of the
  //    same invitation serialize. The selector is either the presented token's
  //    hash (existing-user accept) or the stable invitation ID a pending
  //    registration stored at request time (Sprint 18 completion).
  const [invitation] = await tx
    .select()
    .from(schema.invitations)
    .where(lookup)
    .for('update')
    .limit(1);
  if (!invitation) {
    throw invitationInvalidError();
  }

  // 2. Lifecycle — reject accepted / revoked / expired with precise errors.
  assertAcceptable(invitation, now);

  // 3. Email match — the token is bound to the invited address.
  if (
    invitation.invitedEmailNormalized !== params.acceptingUserNormalizedEmail
  ) {
    throw invitationEmailMismatchError();
  }

  // 4. Duplicate active membership — friendly pre-check (the unique index is the
  //    authoritative guard at insert time).
  const [existingMembership] = await tx
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, params.acceptingUserId),
        eq(schema.memberships.organizationId, invitation.organizationId),
        eq(schema.memberships.status, 'active'),
      ),
    )
    .limit(1);
  if (existingMembership) {
    throw alreadyActiveMemberError();
  }

  // 5. Active-member quota — counted inside the transaction, atomic with the
  //    membership insert below, against the ceiling this SAME transaction
  //    resolved in step 0b.
  const [memberCountRow] = await tx
    .select({ value: count() })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, invitation.organizationId),
        eq(schema.memberships.status, 'active'),
      ),
    );
  const activeMembers = memberCountRow?.value ?? 0;
  if (activeMembers >= values.max_members) {
    throw quotaExceededError({
      quota: ENTITLEMENT_KEYS.maxMembers,
      limit: values.max_members,
      current: activeMembers,
    });
  }

  const [organization] = await tx
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, invitation.organizationId))
    .limit(1);
  if (!organization) {
    // Unreachable: a pending invitation always references a live organization.
    throw invitationInvalidError();
  }
  const [role] = await tx
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.id, invitation.roleId))
    .limit(1);
  if (!role) {
    throw new Error(`Role ${invitation.roleId} is missing from the baseline.`);
  }

  // 6. Membership creation — the unique index uq_memberships_active_user_org
  //    backstops the duplicate-active guard under a race.
  let membership;
  try {
    [membership] = await tx
      .insert(schema.memberships)
      .values({
        userId: params.acceptingUserId,
        organizationId: invitation.organizationId,
        roleId: invitation.roleId,
        status: 'active',
        invitedByUserId: invitation.invitedByUserId,
        joinedAt: now,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw alreadyActiveMemberError();
    }
    throw error;
  }

  // 7. Invitation accepted mutation (single use), same transaction.
  const [accepted] = await tx
    .update(schema.invitations)
    .set({
      status: 'accepted',
      acceptedAt: now,
      acceptedByUserId: params.acceptingUserId,
      updatedAt: now,
    })
    .where(eq(schema.invitations.id, invitation.id))
    .returning();

  // 8. Event recording — both the acceptance and the membership provenance.
  await recordInvitationEvent(tx, {
    organizationId: invitation.organizationId,
    eventType: INVITATION_EVENT_TYPES.accepted,
    metadata: {
      targetType: INVITATION_TARGET_TYPE,
      targetInvitationId: invitation.id,
      targetUserId: params.acceptingUserId,
      targetMembershipId: membership.id,
      invitedEmailNormalized: invitation.invitedEmailNormalized,
      roleId: invitation.roleId,
    },
    ctx: params.ctx,
  });
  await recordInvitationEvent(tx, {
    organizationId: invitation.organizationId,
    eventType: INVITATION_EVENT_TYPES.membershipCreatedFromInvitation,
    metadata: {
      targetType: MEMBERSHIP_TARGET_TYPE,
      targetMembershipId: membership.id,
      targetUserId: params.acceptingUserId,
      targetInvitationId: invitation.id,
      roleId: invitation.roleId,
    },
    ctx: params.ctx,
  });

  return { invitation: accepted, membership, organization, role };
}
