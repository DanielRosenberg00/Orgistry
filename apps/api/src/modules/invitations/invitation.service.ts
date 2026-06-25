import { normalizeEmail } from '@orgistry/auth-core';
import {
  ROLE_IDS,
  ROLE_SEED,
  type MembershipRow,
  type OrganizationRow,
  type RoleRow,
} from '@orgistry/db';
import {
  ERROR_CODES,
  PERMISSION_KEYS,
  type Invitation,
  type InvitationAcceptResponse,
  type InvitationCreateResponse,
  type InvitationListResponse,
  type InvitationRevokeResponse,
  type InvitationInspectResponse,
  type MembershipSummary,
  type Organization,
  type PublicInvitation,
  type RoleKey,
} from '@orgistry/contracts';
import {
  type Clock,
  decodeCursor,
  encodeCursor,
  systemClock,
} from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import {
  type OrganizationActor,
  requireMembership,
  requirePermission,
} from '../organization/access-control';
import type { AccessControlRepository } from '../organization/organization.types';
import type { EntitlementService } from '../entitlements/entitlement.service';
import {
  alreadyActiveMemberError,
  duplicatePendingInvitationError,
  invitationEmailMismatchError,
  invitationInvalidError,
} from './invitation.errors';
import { assertAcceptable, deriveInvitationStatus } from './invitation.lifecycle';
import {
  buildInvitationAcceptUrl,
  type InvitationMailer,
} from './invitation.mailer';
import {
  generateInvitationToken,
  hashInvitationToken,
} from './invitation.token';
import type {
  InvitationActionContext,
  InvitationRepository,
  InvitationView,
} from './invitation.types';

/**
 * Invitation workflows (create / list / revoke / inspect / accept) plus the
 * registration-onboarding guard — the organization invitation lifecycle.
 *
 * The organization-scoped MANAGEMENT methods (create/list/revoke) compose the
 * standard pipeline, with the Sprint 9 reservation policy made explicit on
 * create:
 *
 *   requireMembership                  (active member of this org? -> actor)
 *     -> requirePermission(invitations.*) (does the actor hold the key?)
 *       -> reservation/duplicate guards    (create only)
 *         -> fail-closed email send          (create only; BEFORE persistence)
 *           -> tenant-scoped invitation write (always scoped by the route org id)
 *             -> map row to public DTO        (NEVER the token or its hash)
 *
 * The TOKEN-resolution methods (inspect/accept) are NOT organization-scoped by a
 * route id: the organization is derived from the resolved invitation row. Inspect
 * is unauthenticated (it backs new-user onboarding) and returns only safe public
 * context; accept is Bearer-authenticated and creates the membership inside one
 * transaction (see the repository). Acceptance creates a MEMBERSHIP — it never
 * creates a user session.
 *
 * Authorization is ALWAYS by permission key, never role name. The raw token is
 * generated here, sent out-of-band by the mailer, and never returned by any API.
 */

/** The create-permission decision (documented; see the README/docs). */
const CREATE_PERMISSION = PERMISSION_KEYS.invitationsCreate;

/** Display name lookup for the fixed roles, sourced from the seeded baseline. */
const ROLE_NAME_BY_KEY: Record<RoleKey, string> = ROLE_SEED.reduce(
  (acc, role) => {
    acc[role.key] = role.name;
    return acc;
  },
  {} as Record<RoleKey, string>,
);

/** Per-request security metadata threaded from the route into action events. */
export interface InvitationRequestContext {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateInvitationInput {
  userId: string;
  organizationId: string;
  email: string;
  role: RoleKey;
  ctx: InvitationRequestContext;
}

export interface ListInvitationsInput {
  userId: string;
  organizationId: string;
  requestId: string | null;
  limit: number;
  cursor: string | null;
}

export interface RevokeInvitationInput {
  userId: string;
  organizationId: string;
  invitationId: string;
  ctx: InvitationRequestContext;
}

export interface InspectInvitationInput {
  rawToken: string;
}

export interface AcceptInvitationInput {
  userId: string;
  /** The authenticated user's email (display form); normalized for matching. */
  userEmail: string;
  rawToken: string;
  ctx: InvitationRequestContext;
}

/**
 * The narrow port the auth module uses for registration-with-invitation. The
 * invitation service implements it; defining the shape here (and a matching one
 * in the auth module) keeps auth free of any invitation import.
 */
export interface RegistrationInvitationGuard {
  /**
   * Pre-resolve a raw token for registration: validate (lifecycle, email match,
   * quota) so an obviously-bad token fails BEFORE the account is provisioned, and
   * return the token hash + the organization's `max_members` ceiling the
   * registration transaction needs to accept the invitation ATOMICALLY. Throws
   * the precise invitation error (or `QUOTA_EXCEEDED`) without mutating anything.
   */
  prepareForRegistration(
    rawToken: string,
    normalizedEmail: string,
  ): Promise<{ tokenHash: string; maxMembers: number }>;
}

export interface InvitationService extends RegistrationInvitationGuard {
  createInvitation(
    input: CreateInvitationInput,
  ): Promise<InvitationCreateResponse>;
  listInvitations(input: ListInvitationsInput): Promise<InvitationListResponse>;
  revokeInvitation(
    input: RevokeInvitationInput,
  ): Promise<InvitationRevokeResponse>;
  inspectInvitation(
    input: InspectInvitationInput,
  ): Promise<InvitationInspectResponse>;
  acceptInvitation(
    input: AcceptInvitationInput,
  ): Promise<InvitationAcceptResponse>;
}

export interface InvitationServiceOptions {
  /** Resolves active membership + effective permissions (the org repo satisfies this). */
  accessControl: AccessControlRepository;
  /** Tenant-aware invitation persistence. */
  invitations: InvitationRepository;
  /** Organization-level entitlement/quota service (the member quota boundary). */
  entitlements: EntitlementService;
  /** Local invitation email transport (fail-closed on create). */
  mailer: InvitationMailer;
  /** Raw invitation token lifetime in seconds (config-driven; default 7 days). */
  ttlSeconds: number;
  /** Web origin used to build the acceptance link in the invitation email. */
  webBaseUrl: string;
  clock?: Clock;
}

/** Internal invitation-list cursor shape. Opaque to clients. */
interface InvitationCursor {
  c: number; // createdAt epoch millis
  i: string; // invitation id (tiebreak)
}

/** Map an organization row to the public Organization DTO. */
function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a membership + role to the caller's membership summary. */
function toMembershipSummary(
  membership: MembershipRow,
  role: RoleRow,
): MembershipSummary {
  return {
    id: membership.id,
    status: membership.status,
    role: { id: role.id, key: role.key, name: role.name },
    joinedAt: membership.joinedAt.toISOString(),
    createdAt: membership.createdAt.toISOString(),
  };
}

/** Map an invitation view to the public Invitation DTO (status is DERIVED). */
function toInvitation(view: InvitationView, now: Date): Invitation {
  const { invitation, role } = view;
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    invitedEmail: invitation.invitedEmail,
    role: { id: role.id, key: role.key, name: role.name },
    status: deriveInvitationStatus(invitation, now),
    invitedByUserId: invitation.invitedByUserId,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    acceptedAt: invitation.acceptedAt
      ? invitation.acceptedAt.toISOString()
      : null,
    revokedAt: invitation.revokedAt
      ? invitation.revokedAt.toISOString()
      : null,
  };
}

/** Decode an invitation-list cursor, rejecting a malformed value with BAD_REQUEST. */
function decodeInvitationCursor(
  cursor: string | null,
): { createdAtMs: number; id: string } | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeCursor<InvitationCursor>(cursor);
  if (
    !decoded ||
    typeof decoded.c !== 'number' ||
    typeof decoded.i !== 'string'
  ) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 400, 'Invalid cursor.');
  }
  return { createdAtMs: decoded.c, id: decoded.i };
}

export function createInvitationService(
  options: InvitationServiceOptions,
): InvitationService {
  const {
    accessControl,
    invitations,
    entitlements,
    mailer,
    ttlSeconds,
    webBaseUrl,
    clock = systemClock,
  } = options;

  async function actorFor(input: {
    userId: string;
    organizationId: string;
    requestId: string | null;
  }): Promise<OrganizationActor> {
    return requireMembership(accessControl, {
      userId: input.userId,
      organizationId: input.organizationId,
      requestId: input.requestId,
    });
  }

  function actionContext(
    actor: OrganizationActor,
    ctx: InvitationRequestContext,
  ): InvitationActionContext {
    return {
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    };
  }

  return {
    async createInvitation(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, CREATE_PERMISSION);

      const invitedEmailNormalized = normalizeEmail(input.email);
      const roleId = ROLE_IDS[input.role];

      // Reject inviting someone who is ALREADY an active member.
      if (
        await invitations.hasActiveMemberWithEmail(
          actor.organizationId,
          invitedEmailNormalized,
        )
      ) {
        throw alreadyActiveMemberError();
      }

      // Deterministic duplicate-pending handling: an outstanding (non-expired)
      // pending invitation for this email is rejected (the partial unique index
      // is the authoritative guard for the create-time race).
      if (
        await invitations.findPendingInvitation(
          actor.organizationId,
          invitedEmailNormalized,
        )
      ) {
        throw duplicatePendingInvitationError();
      }

      // v1 reservation policy: active members + pending invitations must stay
      // under max_members. Throws QUOTA_EXCEEDED before any write.
      const pendingCount = await invitations.countPendingInvitations(
        actor.organizationId,
      );
      await entitlements.requireMemberReservationQuota(
        actor.organizationId,
        pendingCount,
      );

      // Generate the token: the raw value is emailed once; only its hash is stored.
      const rawToken = generateInvitationToken();
      const tokenHash = hashInvitationToken(rawToken);
      const expiresAt = new Date(clock.epochMillis() + ttlSeconds * 1000);

      const organization = await accessControl.findOrganizationById(
        actor.organizationId,
      );
      if (!organization) {
        // Unreachable: requireMembership already resolved an active org.
        throw invitationInvalidError();
      }

      // FAIL-CLOSED: send the email BEFORE persisting. If delivery throws,
      // nothing is written — no orphan invitation and no invitation.created event.
      await mailer.sendInvitationEmail({
        to: input.email,
        organizationName: organization.name,
        roleName: ROLE_NAME_BY_KEY[input.role],
        acceptUrl: buildInvitationAcceptUrl(webBaseUrl, rawToken),
        expiresAt,
      });

      const view = await invitations.createInvitation({
        organizationId: actor.organizationId,
        invitedEmail: input.email,
        invitedEmailNormalized,
        roleId,
        tokenHash,
        expiresAt,
        ctx: actionContext(actor, input.ctx),
      });

      return { invitation: toInvitation(view, clock.now()) };
    },

    async listInvitations(input) {
      const actor = await actorFor(input);
      requirePermission(actor, PERMISSION_KEYS.invitationsRead);

      const rows = await invitations.listInvitations({
        organizationId: actor.organizationId,
        limit: input.limit,
        cursor: decodeInvitationCursor(input.cursor),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              c: last.invitation.createdAt.getTime(),
              i: last.invitation.id,
            } satisfies InvitationCursor)
          : null;

      const now = clock.now();
      return {
        items: page.map((view) => toInvitation(view, now)),
        nextCursor,
        hasMore,
      };
    },

    async revokeInvitation(input) {
      const actor = await actorFor({
        userId: input.userId,
        organizationId: input.organizationId,
        requestId: input.ctx.requestId,
      });
      requirePermission(actor, PERMISSION_KEYS.invitationsRevoke);

      await invitations.revokeInvitation({
        organizationId: actor.organizationId,
        invitationId: input.invitationId,
        ctx: actionContext(actor, input.ctx),
      });

      return { id: input.invitationId, revoked: true };
    },

    async inspectInvitation(input): Promise<InvitationInspectResponse> {
      const context = await invitations.findContextByTokenHash(
        hashInvitationToken(input.rawToken),
      );
      if (!context) {
        throw invitationInvalidError();
      }
      // Reject revoked / accepted / expired; only an acceptable invitation
      // yields safe public context.
      assertAcceptable(context.invitation, clock.now());

      const invitation: PublicInvitation = {
        organizationName: context.organization.name,
        invitedEmail: context.invitation.invitedEmail,
        role: { key: context.role.key, name: context.role.name },
        expiresAt: context.invitation.expiresAt.toISOString(),
        acceptable: true,
      };
      return { invitation };
    },

    async acceptInvitation(input) {
      const normalized = normalizeEmail(input.userEmail);
      const tokenHash = hashInvitationToken(input.rawToken);

      const context = await invitations.findContextByTokenHash(tokenHash);
      if (!context) {
        throw invitationInvalidError();
      }
      // Early, clean errors before resolving the plan limit; the acceptance
      // transaction re-validates everything authoritatively under a row lock.
      assertAcceptable(context.invitation, clock.now());
      if (context.invitation.invitedEmailNormalized !== normalized) {
        throw invitationEmailMismatchError();
      }

      const maxMembers = await entitlements.getMaxMembers(
        context.invitation.organizationId,
      );
      const result = await invitations.acceptInvitation({
        tokenHash,
        acceptingUserId: input.userId,
        acceptingUserNormalizedEmail: normalized,
        maxMembers,
        ctx: {
          actorUserId: input.userId,
          actorMembershipId: null,
          requestId: input.ctx.requestId,
          ipAddress: input.ctx.ipAddress,
          userAgent: input.ctx.userAgent,
        },
      });

      return {
        organization: toOrganization(result.organization),
        membership: toMembershipSummary(result.membership, result.role),
      };
    },

    async prepareForRegistration(rawToken, normalizedEmail) {
      const tokenHash = hashInvitationToken(rawToken);
      const context = await invitations.findContextByTokenHash(tokenHash);
      if (!context) {
        throw invitationInvalidError();
      }
      // Early, clean failures before account provisioning. The registration
      // transaction re-validates everything authoritatively under a row lock.
      assertAcceptable(context.invitation, clock.now());
      if (context.invitation.invitedEmailNormalized !== normalizedEmail) {
        throw invitationEmailMismatchError();
      }
      await entitlements.requireMemberAdditionQuota(
        context.invitation.organizationId,
      );
      const maxMembers = await entitlements.getMaxMembers(
        context.invitation.organizationId,
      );
      return { tokenHash, maxMembers };
    },
  };
}
