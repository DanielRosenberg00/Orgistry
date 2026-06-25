import type { InvitationRow } from '@orgistry/db';
import type { InvitationStatus } from '@orgistry/contracts';
import {
  invitationAlreadyAcceptedError,
  invitationExpiredError,
  invitationRevokedError,
} from './invitation.errors';

/**
 * Invitation lifecycle helpers — the SINGLE place expiry and acceptability are
 * decided, so inspect, accept, revoke, list, and the create/list DTO mapping can
 * never disagree on what "expired" or "acceptable" means.
 *
 * Expiry is DERIVED, never persisted: there is no background expiration job, so a
 * still-`pending` row past its `expires_at` is treated as `expired` everywhere.
 * Keeping that rule in one pure function is what makes "expired pending
 * invitations are represented consistently" true by construction.
 */

/** True when a still-pending invitation has passed its expiry. */
export function isExpired(invitation: InvitationRow, now: Date): boolean {
  return invitation.expiresAt.getTime() <= now.getTime();
}

/**
 * Derive the PRESENTED status of an invitation. Terminal persisted states
 * (`accepted`, `revoked`) are returned as-is; a `pending` row is presented as
 * `expired` once past its deadline, otherwise `pending`.
 */
export function deriveInvitationStatus(
  invitation: InvitationRow,
  now: Date,
): InvitationStatus {
  if (invitation.status === 'accepted') {
    return 'accepted';
  }
  if (invitation.status === 'revoked') {
    return 'revoked';
  }
  // Persisted 'pending' (or any non-terminal state): expiry is derived.
  return isExpired(invitation, now) ? 'expired' : 'pending';
}

/** True only for a pending invitation that has not expired. */
export function isAcceptable(invitation: InvitationRow, now: Date): boolean {
  return invitation.status === 'pending' && !isExpired(invitation, now);
}

/**
 * Throw the precise lifecycle error unless the invitation is acceptable
 * (pending and not expired). Checks terminal states first, then derived expiry.
 * A token holder learns exactly why acceptance failed; callers without a valid
 * token never reach here (the lookup returns `INVITATION_INVALID` first).
 */
export function assertAcceptable(invitation: InvitationRow, now: Date): void {
  if (invitation.status === 'accepted') {
    throw invitationAlreadyAcceptedError();
  }
  if (invitation.status === 'revoked') {
    throw invitationRevokedError();
  }
  if (isExpired(invitation, now)) {
    throw invitationExpiredError();
  }
}
