import type {
  InvitationRow,
  MembershipRow,
  OrganizationRow,
  RoleRow,
} from '@orgistry/db';

/**
 * Internal invitation-module types.
 *
 * `InvitationRow`/`MembershipRow`/`OrganizationRow`/`RoleRow` are persistence
 * shapes used INSIDE the module only; they are never returned from a route — the
 * service maps them to the public `@orgistry/contracts` DTOs first, and the token
 * hash never crosses any boundary.
 */

/**
 * Per-request action context attached to an invitation action event. Carries the
 * server-derived actor identity plus non-secret request metadata. The acting
 * MEMBERSHIP is null on acceptance (the accepting user is joining and has no
 * prior membership in the organization). Secrets are never placed here; metadata
 * is sanitized before persistence regardless.
 */
export interface InvitationActionContext {
  /** The acting user (the inviter, the revoker, or the accepting user). */
  actorUserId: string;
  /** The actor's active membership in the organization, or null on acceptance. */
  actorMembershipId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** An invitation paired with its invited role (for the create/list DTOs). */
export interface InvitationView {
  invitation: InvitationRow;
  role: RoleRow;
}

/**
 * An invitation paired with its role AND organization (for token inspection,
 * which needs the organization display name).
 */
export interface InvitationContextView {
  invitation: InvitationRow;
  role: RoleRow;
  organization: OrganizationRow;
}

/** The rows produced by a successful acceptance. */
export interface AcceptInvitationResult {
  invitation: InvitationRow;
  membership: MembershipRow;
  organization: OrganizationRow;
  role: RoleRow;
}

/** Inputs for creating a pending invitation (token already generated/hashed). */
export interface CreateInvitationParams {
  organizationId: string;
  invitedEmail: string;
  invitedEmailNormalized: string;
  /** Seeded id of the fixed invited role. */
  roleId: string;
  /** SHA-256 hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  expiresAt: Date;
  ctx: InvitationActionContext;
}

/** Cursor-pagination inputs for listing an organization's invitations. */
export interface ListInvitationsParams {
  organizationId: string;
  limit: number;
  /** Exclusive lower bound from a prior page's cursor (createdAt, id). */
  cursor: { createdAtMs: number; id: string } | null;
}

/** Inputs for accepting an invitation (resolved by token hash). */
export interface AcceptInvitationParams {
  /** SHA-256 hash of the presented raw token. */
  tokenHash: string;
  /** The account accepting the invitation. */
  acceptingUserId: string;
  /** The accepting account's normalized email (for the email-match invariant). */
  acceptingUserNormalizedEmail: string;
  /** The plan's `max_members` ceiling, resolved before the transaction. */
  maxMembers: number;
  ctx: InvitationActionContext;
}

/** Inputs for revoking a pending invitation (scoped by org + id). */
export interface RevokeInvitationParams {
  organizationId: string;
  invitationId: string;
  ctx: InvitationActionContext;
}

/**
 * Tenant-aware persistence boundary for invitation workflows.
 *
 * Management methods (`createInvitation`, `listInvitations`, `revokeInvitation`,
 * `findPendingInvitation`, `hasActiveMemberWithEmail`, `countPendingInvitations`)
 * are organization-scoped: an invitation is never addressed by id alone.
 * `findContextByTokenHash` and `acceptInvitation` are the token-resolution
 * methods, where the organization is DERIVED from the resolved row, never taken
 * from the request. The repository owns invitation SQL and the action-event
 * writes that commit with each mutation; it does NOT own permission, quota, or
 * mail policy and does NOT shape HTTP responses. Invitations are never
 * hard-deleted.
 */
export interface InvitationRepository {
  /** Create a pending invitation under `organizationId` and record `invitation.created`. */
  createInvitation(params: CreateInvitationParams): Promise<InvitationView>;

  /**
   * List an organization's invitations (every lifecycle state), newest first,
   * one page at a time. Returns up to `limit + 1` rows so the caller can detect
   * a further page without a second query.
   */
  listInvitations(params: ListInvitationsParams): Promise<InvitationView[]>;

  /**
   * Resolve an invitation by its token hash, with role + organization context
   * for safe inspection. Returns null when the hash matches nothing.
   */
  findContextByTokenHash(
    tokenHash: string,
  ): Promise<InvitationContextView | null>;

  /**
   * Accept an invitation transactionally: lock the invitation by token hash,
   * re-validate it is pending/not-expired/not-revoked/not-accepted, enforce the
   * email-match and active-member quota invariants, create the active membership
   * with the invited role, mark the invitation accepted, and record both
   * `invitation.accepted` and `membership.created_from_invitation` — all in one
   * transaction so membership creation and acceptance can never diverge.
   *
   * Throws the appropriate stable invitation error (`INVITATION_INVALID`,
   * `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_ALREADY_ACCEPTED`,
   * `INVITATION_EMAIL_MISMATCH`), `QUOTA_EXCEEDED`, or `CONFLICT` (already an
   * active member) WITHOUT mutating any state.
   */
  acceptInvitation(
    params: AcceptInvitationParams,
  ): Promise<AcceptInvitationResult>;

  /**
   * Revoke a pending, non-expired invitation (scoped by org + id): set
   * `revoked_at` + `revoked_by_user_id`, mark it revoked, and record
   * `invitation.revoked`. Throws `INVITATION_INVALID` when unknown/cross-tenant,
   * `INVITATION_EXPIRED` when past expiry, `INVITATION_REVOKED` when already
   * revoked, and `INVITATION_ALREADY_ACCEPTED` when accepted. Never hard-deletes.
   */
  revokeInvitation(params: RevokeInvitationParams): Promise<void>;

  /**
   * The single PENDING invitation for (organization, normalized email), or null.
   * The friendly pre-check behind the duplicate-pending guard.
   */
  findPendingInvitation(
    organizationId: string,
    invitedEmailNormalized: string,
  ): Promise<InvitationRow | null>;

  /**
   * True when an ACTIVE member of the organization already has this normalized
   * email. Used to reject inviting an existing active member.
   */
  hasActiveMemberWithEmail(
    organizationId: string,
    invitedEmailNormalized: string,
  ): Promise<boolean>;

  /** Count the organization's PENDING invitations — the reservation-quota basis. */
  countPendingInvitations(organizationId: string): Promise<number>;
}
