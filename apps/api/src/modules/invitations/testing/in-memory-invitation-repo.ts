import { type InvitationRow, type RoleRow } from '@orgistry/db';
import { createId } from '@orgistry/shared';
import { sanitizeSecurityMetadata } from '../../../lib/security-metadata';
import type { InMemoryOrgStore } from '../../organization/testing/in-memory-org-store';
import {
  duplicatePendingInvitationError,
  invitationInvalidError,
} from '../invitation.errors';
import {
  INVITATION_EVENT_TYPES,
  type InvitationEventType,
} from '../invitation.events';
import { assertAcceptable, isExpired } from '../invitation.lifecycle';
import {
  applyInvitationAcceptanceInStore,
  validateInvitationForAcceptanceInStore,
} from './invitation-store-acceptance';
import type {
  AcceptInvitationParams,
  AcceptInvitationResult,
  CreateInvitationParams,
  InvitationActionContext,
  InvitationContextView,
  InvitationRepository,
  InvitationView,
  ListInvitationsParams,
  RevokeInvitationParams,
} from '../invitation.types';

const INVITATION_TARGET_TYPE = 'invitation';

/**
 * In-memory `InvitationRepository` for unit/route tests.
 *
 * Mirrors the database repository's observable behavior — prefixed ids,
 * timestamps, organization-scoped lookups, token-hash resolution, the
 * duplicate-pending guard with lazy expiry, the transactional acceptance
 * (email-match, duplicate-membership, quota, single-use), idempotent-safe revoke
 * errors, and the action-event writes — over the shared `InMemoryOrgStore`, so
 * invitation workflows can be exercised end-to-end with no PostgreSQL.
 *
 * Each mutating method performs its read-classify-write with NO intervening
 * `await`, so under Node's single-threaded loop it is atomic exactly as the DB
 * transaction + row lock is.
 */
export function createInMemoryInvitationRepository(
  store: InMemoryOrgStore,
): InvitationRepository {
  function requireRole(roleId: string): RoleRow {
    const role = store.roles.find((r) => r.id === roleId);
    if (!role) {
      throw new Error(`Role ${roleId} is missing from the role baseline.`);
    }
    return role;
  }

  function recordInvitationEvent(input: {
    organizationId: string;
    eventType: InvitationEventType;
    metadata: Record<string, unknown>;
    ctx: InvitationActionContext;
  }): void {
    store.securityEvents.push({
      userId: input.ctx.actorUserId,
      organizationId: input.organizationId,
      actorType: 'user',
      eventType: input.eventType,
      metadata: sanitizeSecurityMetadata({
        actorMembershipId: input.ctx.actorMembershipId,
        ...input.metadata,
      }),
      requestId: input.ctx.requestId,
    });
  }

  return {
    async createInvitation(
      params: CreateInvitationParams,
    ): Promise<InvitationView> {
      const now = new Date();
      // Lazy expiry of stale pending rows for this email (frees the slot).
      for (const inv of store.invitations) {
        if (
          inv.organizationId === params.organizationId &&
          inv.invitedEmailNormalized === params.invitedEmailNormalized &&
          inv.status === 'pending' &&
          isExpired(inv, now)
        ) {
          inv.status = 'expired';
          inv.updatedAt = now;
        }
      }
      // Authoritative duplicate-pending guard (the partial unique index).
      const duplicate = store.invitations.some(
        (inv) =>
          inv.organizationId === params.organizationId &&
          inv.invitedEmailNormalized === params.invitedEmailNormalized &&
          inv.status === 'pending',
      );
      if (duplicate) {
        throw duplicatePendingInvitationError();
      }

      const invitation: InvitationRow = {
        id: createId('inv'),
        organizationId: params.organizationId,
        invitedEmail: params.invitedEmail,
        invitedEmailNormalized: params.invitedEmailNormalized,
        roleId: params.roleId,
        tokenHash: params.tokenHash,
        status: 'pending',
        invitedByUserId: params.ctx.actorUserId,
        acceptedByUserId: null,
        revokedByUserId: null,
        expiresAt: params.expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      store.invitations.push(invitation);

      recordInvitationEvent({
        organizationId: params.organizationId,
        eventType: INVITATION_EVENT_TYPES.created,
        metadata: {
          targetType: INVITATION_TARGET_TYPE,
          targetInvitationId: invitation.id,
          invitedEmailNormalized: invitation.invitedEmailNormalized,
          roleId: invitation.roleId,
        },
        ctx: params.ctx,
      });

      return { invitation, role: requireRole(invitation.roleId) };
    },

    async listInvitations(
      params: ListInvitationsParams,
    ): Promise<InvitationView[]> {
      const ordered = store.invitations
        .filter((inv) => inv.organizationId === params.organizationId)
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          return byCreated !== 0 ? byCreated : a.id < b.id ? 1 : -1;
        });

      const afterCursor = params.cursor
        ? ordered.filter((inv) => {
            const created = inv.createdAt.getTime();
            if (created < params.cursor!.createdAtMs) {
              return true;
            }
            return (
              created === params.cursor!.createdAtMs &&
              inv.id < params.cursor!.id
            );
          })
        : ordered;

      return afterCursor
        .slice(0, params.limit + 1)
        .map((invitation) => ({ invitation, role: requireRole(invitation.roleId) }));
    },

    async findContextByTokenHash(
      tokenHash: string,
    ): Promise<InvitationContextView | null> {
      const invitation = store.invitations.find(
        (inv) => inv.tokenHash === tokenHash,
      );
      if (!invitation) {
        return null;
      }
      const organization = store.organizations.find(
        (org) => org.id === invitation.organizationId,
      );
      if (!organization) {
        return null;
      }
      return { invitation, role: requireRole(invitation.roleId), organization };
    },

    // Synchronous validate-then-apply (no await between) -> atomic under Node's
    // single-threaded loop, mirroring the DB transaction. Shares the validate/
    // apply helpers with the in-memory auth repo's registration flow.
    async acceptInvitation(
      params: AcceptInvitationParams,
    ): Promise<AcceptInvitationResult> {
      const invitation = validateInvitationForAcceptanceInStore(store, {
        tokenHash: params.tokenHash,
        acceptingUserId: params.acceptingUserId,
        acceptingUserNormalizedEmail: params.acceptingUserNormalizedEmail,
        maxMembers: params.maxMembers,
      });
      const { membership, organization, role } =
        applyInvitationAcceptanceInStore(store, invitation, {
          acceptingUserId: params.acceptingUserId,
          requestId: params.ctx.requestId,
        });
      return { invitation, membership, organization, role };
    },

    async revokeInvitation(params: RevokeInvitationParams): Promise<void> {
      const now = new Date();
      const invitation = store.invitations.find(
        (inv) =>
          inv.id === params.invitationId &&
          inv.organizationId === params.organizationId,
      );
      if (!invitation) {
        throw invitationInvalidError();
      }
      assertAcceptable(invitation, now);

      invitation.status = 'revoked';
      invitation.revokedAt = now;
      invitation.revokedByUserId = params.ctx.actorUserId;
      invitation.updatedAt = now;

      recordInvitationEvent({
        organizationId: params.organizationId,
        eventType: INVITATION_EVENT_TYPES.revoked,
        metadata: {
          targetType: INVITATION_TARGET_TYPE,
          targetInvitationId: invitation.id,
          invitedEmailNormalized: invitation.invitedEmailNormalized,
          roleId: invitation.roleId,
        },
        ctx: params.ctx,
      });
    },

    async findPendingInvitation(
      organizationId: string,
      invitedEmailNormalized: string,
    ): Promise<InvitationRow | null> {
      const now = new Date();
      return (
        store.invitations.find(
          (inv) =>
            inv.organizationId === organizationId &&
            inv.invitedEmailNormalized === invitedEmailNormalized &&
            inv.status === 'pending' &&
            !isExpired(inv, now),
        ) ?? null
      );
    },

    async hasActiveMemberWithEmail(
      organizationId: string,
      invitedEmailNormalized: string,
    ): Promise<boolean> {
      return store.memberships.some((m) => {
        if (m.organizationId !== organizationId || m.status !== 'active') {
          return false;
        }
        const user = store.users.find((u) => u.id === m.userId);
        return user?.normalizedEmail === invitedEmailNormalized;
      });
    },

    async countPendingInvitations(organizationId: string): Promise<number> {
      const now = new Date();
      return store.invitations.filter(
        (inv) =>
          inv.organizationId === organizationId &&
          inv.status === 'pending' &&
          !isExpired(inv, now),
      ).length;
    },
  };
}
