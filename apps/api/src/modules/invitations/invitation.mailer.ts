import type { AccountEmail } from '../mail/account-mailer';

/**
 * Invitation email rendering (Sprint 9; migrated onto the shared account
 * mailer in Sprint 16).
 *
 * This module is now purely about WHAT an invitation email says. HOW it is
 * delivered — sender identity, transport (Mailpit / production SMTP /
 * in-memory), serialization, timeouts — lives in `../mail`. The invitation
 * service renders a message here and hands it to the injected
 * `AccountMailer.deliver`.
 *
 * Invitation creation remains FAIL-CLOSED on delivery: the service sends the
 * email BEFORE persisting the invitation, so if delivery rejects, nothing is
 * written (no orphan invitation, no `invitation.created` event).
 *
 * TOKEN TRANSPORT POLICY (Policy A): the raw invitation token is delivered
 * ONLY as a link in this email — email is the intended out-of-band channel.
 * It NEVER appears in API responses, API URL paths, application logs, action
 * events, or database rows (only the hash is stored). This module never logs.
 */

/** Inputs for one invitation email. `acceptUrl` carries the raw token (out-of-band). */
export interface InvitationEmailMessage {
  /** The invited recipient address (display form). */
  to: string;
  /** Organization display name, for the email body. */
  organizationName: string;
  /** Display name of the role the invitee will receive on acceptance. */
  roleName: string;
  /** Acceptance link containing the raw token (delivered out-of-band only). */
  acceptUrl: string;
  /** When the invitation stops being acceptable. */
  expiresAt: Date;
}

/**
 * Build the acceptance URL the invitation email links to. The raw token travels
 * as a query parameter to a web onboarding route; the API itself accepts the
 * token in a request BODY (never the URL), so the token never reaches API access
 * logs. `webBaseUrl` is the configured web demo origin.
 */
export function buildInvitationAcceptUrl(
  webBaseUrl: string,
  rawToken: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/invitations/accept?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Render the human-readable invitation email (pure; no IO, no logging). The
 * body includes the recipient, organization, role, the acceptance link, and the
 * expiry — everything the spec requires the invitation email to carry.
 */
export function renderInvitationEmail(
  message: InvitationEmailMessage,
): AccountEmail {
  const subject = `You're invited to join ${message.organizationName} on Orgistry`;
  const text = [
    `You've been invited to join ${message.organizationName} on Orgistry.`,
    '',
    `Role: ${message.roleName}`,
    `Invited address: ${message.to}`,
    '',
    'Accept your invitation:',
    message.acceptUrl,
    '',
    `This invitation expires on ${message.expiresAt.toISOString()}.`,
    '',
    "If you weren't expecting this, you can safely ignore this email.",
  ].join('\n');
  return { to: message.to, subject, text };
}
