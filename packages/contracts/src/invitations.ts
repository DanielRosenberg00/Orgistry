import { z } from 'zod';
import { roleKeySchema } from './access';
import { roleSummarySchema, organizationSchema, membershipSummarySchema } from './organizations';

/**
 * Invitation API contracts (Sprint 9) — the organization invitation lifecycle.
 *
 * An invitation is a single-use, expiring grant that lets a specific email join
 * one organization with one fixed role. These DTOs are the stable boundary
 * between the API and any client. Hard rules carried over from the
 * project/member/api-key contracts:
 *  - no response field ever carries the raw invitation token or its hash. The
 *    raw token is delivered ONLY out-of-band (the invitation email); no API
 *    response — create, list, inspect, revoke, or accept — returns it;
 *  - no response field carries a persistence-only column (token hash, the
 *    accepted/revoked actor ids are not exposed; only lifecycle timestamps are);
 *  - authorization is by permission key (`invitations.read` / `.create` /
 *    `.revoke`), enforced server-side — no permission field appears here;
 *  - the organization id is the authority boundary and comes from the route,
 *    never a request body, so no create body carries it;
 *  - the invited role is one of the FIXED v1 system roles — custom roles are
 *    rejected at this boundary.
 */

/** Upper bound on the invited-email length (matches the auth email bound). */
export const MAX_INVITED_EMAIL_LENGTH = 320;

/**
 * Invitation lifecycle status, as PRESENTED to clients.
 *
 *  - `pending`  — outstanding and acceptable (not past `expiresAt`);
 *  - `accepted` — redeemed exactly once (terminal);
 *  - `revoked`  — cancelled by an administrator (terminal);
 *  - `expired`  — DERIVED: a pending invitation past its `expiresAt`. There is
 *    no background job — expiry is computed at inspect/accept/list time, so a
 *    still-`pending` row whose deadline has passed is presented as `expired`
 *    consistently everywhere.
 */
export const invitationStatusSchema = z.enum([
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

/** Email validation shared by the create request (format only; normalization is server-side). */
const invitedEmailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(MAX_INVITED_EMAIL_LENGTH)
  .email('A valid email address is required');

/**
 * Public representation of an invitation — the shape returned by create and
 * list. It NEVER contains the raw token or the token hash. `role` is the
 * identity-only role summary (never permissions); `status` is the derived
 * lifecycle status above; `invitedByUserId` is the inviter's opaque id (the
 * invitations surface intentionally exposes the id, not a full profile, to stay
 * lean and avoid extra joins).
 */
export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  invitedEmail: z.string(),
  role: roleSummarySchema,
  status: invitationStatusSchema,
  invitedByUserId: z.string(),
  /** When the invitation stops being acceptable (ISO-8601). */
  expiresAt: z.string(),
  createdAt: z.string(),
  /** When it was accepted, or null while not accepted (ISO-8601). */
  acceptedAt: z.string().nullable(),
  /** When it was revoked, or null while not revoked (ISO-8601). */
  revokedAt: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/**
 * Safe, public onboarding context for a token-inspection lookup. This is the
 * ONLY invitation shape exposed WITHOUT authentication (it backs new-user
 * registration), so it is deliberately minimal: enough to render an onboarding
 * screen, nothing more. It exposes NO organization internals beyond the display
 * name, NO inviter identity, NO ids, and never the token or its hash.
 */
export const publicInvitationSchema = z.object({
  /** Organization display name, so the invitee knows what they are joining. */
  organizationName: z.string(),
  /** The address the invitation was issued to (the invitee already knows it). */
  invitedEmail: z.string(),
  /** The role the invitee will receive on acceptance (identity only). */
  role: z.object({ key: z.string(), name: z.string() }),
  expiresAt: z.string(),
  /** Always true here: inspection returns context ONLY for acceptable invitations. */
  acceptable: z.boolean(),
});
export type PublicInvitation = z.infer<typeof publicInvitationSchema>;

/**
 * POST …/invitations request body. Only the invited email and target role are
 * accepted — the organization comes from the route path and the inviter is the
 * authenticated actor. The role must be one of the fixed system role keys; any
 * other value (including a custom role) is a VALIDATION_ERROR at this boundary.
 */
export const invitationCreateRequestSchema = z.object({
  email: invitedEmailSchema,
  role: roleKeySchema,
});
export type InvitationCreateRequest = z.infer<
  typeof invitationCreateRequestSchema
>;

/** POST …/invitations response body (the created invitation; never the token). */
export const invitationCreateResponseSchema = z.object({
  invitation: invitationSchema,
});
export type InvitationCreateResponse = z.infer<
  typeof invitationCreateResponseSchema
>;

/** GET …/invitations response body — cursor-paginated invitations. */
export const invitationListResponseSchema = z.object({
  items: z.array(invitationSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type InvitationListResponse = z.infer<
  typeof invitationListResponseSchema
>;

/** GET …/invitations query params — the platform cursor pagination baseline. */
export { cursorPageParamsSchema as invitationListQuerySchema } from './pagination';
export type { CursorPageParams as InvitationListQuery } from './pagination';

/**
 * Route parameters for the single-invitation surface
 * (`…/invitations/:invitationId`). Presence/shape only — the id's authority is
 * resolved server-side and an unknown/cross-tenant id surfaces a uniform
 * `INVITATION_INVALID`, matching the project/member/api-key route convention.
 */
export const invitationRouteParamsSchema = z.object({
  organizationId: z.string().min(1),
  invitationId: z.string().min(1),
});
export type InvitationRouteParams = z.infer<
  typeof invitationRouteParamsSchema
>;

/**
 * DELETE …/invitations/:invitationId response body. Revocation returns a minimal
 * acknowledgement (the now-revoked invitation id) rather than the row; the
 * invitation is no longer outstanding.
 */
export const invitationRevokeResponseSchema = z.object({
  id: z.string(),
  revoked: z.literal(true),
});
export type InvitationRevokeResponse = z.infer<
  typeof invitationRevokeResponseSchema
>;

/**
 * Token-bearing request body for the unauthenticated inspect and authenticated
 * accept surfaces. The raw token travels in the BODY, never the URL path, so it
 * is never written to access logs, proxies, or `Referer` headers — upholding the
 * "raw tokens are never logged" invariant (the platform keeps every secret out
 * of URLs: refresh tokens use a cookie, API keys use the Authorization header).
 */
export const invitationTokenRequestSchema = z.object({
  token: z.string().min(1, 'An invitation token is required'),
});
export type InvitationTokenRequest = z.infer<
  typeof invitationTokenRequestSchema
>;

/** POST /v1/invitations/inspect response body — the safe public context. */
export const invitationInspectResponseSchema = z.object({
  invitation: publicInvitationSchema,
});
export type InvitationInspectResponse = z.infer<
  typeof invitationInspectResponseSchema
>;

/**
 * POST /v1/invitations/accept response body. Acceptance creates an organization
 * MEMBERSHIP — it does NOT, by itself, create a user session — so it returns the
 * organization plus the caller's new membership context (the same pairing the
 * organization endpoints use), letting the client switch into the organization
 * in one round-trip.
 */
export const invitationAcceptResponseSchema = z.object({
  organization: organizationSchema,
  membership: membershipSummarySchema,
});
export type InvitationAcceptResponse = z.infer<
  typeof invitationAcceptResponseSchema
>;
