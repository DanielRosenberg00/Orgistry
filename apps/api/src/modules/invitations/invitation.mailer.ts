/**
 * Invitation mailer — the email delivery seam for Sprint 9.
 *
 * Invitation creation is FAIL-CLOSED on delivery: the service sends the email
 * BEFORE persisting the invitation, so if delivery rejects, nothing is written
 * (no orphan invitation, no `invitation.created` event). The mailer is therefore
 * a narrow, swappable boundary:
 *
 *  - `InvitationMailer` is the interface the service depends on;
 *  - `createMailpitInvitationMailer` (see `invitation.mailpit-mailer.ts`) is the
 *    DEFAULT RUNTIME transport — it delivers over SMTP to the local Mailpit
 *    container (`MAILPIT_*` config), where the message is visible in the Mailpit
 *    web UI;
 *  - tests inject a capturing in-memory mailer (see the testing helpers).
 *
 * TOKEN TRANSPORT POLICY (Policy A): the raw invitation token is delivered ONLY
 * as a link in this email — email is the intended out-of-band channel. It is
 * legitimately present in the email body/link and travels over SMTP to Mailpit.
 * It NEVER appears in API responses, API URL paths, application logs, action
 * events, or database rows (only the hash is stored). This module never logs.
 */

/** A composed invitation email. `acceptUrl` carries the raw token (out-of-band). */
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

export interface InvitationMailer {
  /**
   * Deliver an invitation email. MUST reject (throw) when the message cannot be
   * sent, so the fail-closed create flow can abort before persisting.
   */
  sendInvitationEmail(message: InvitationEmailMessage): Promise<void>;
}

/** A fully composed email ready to serialize/send. */
export interface ComposedInvitationEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
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
 * Compose the human-readable invitation email (pure; no IO, no logging). The
 * body includes the recipient, organization, role, the acceptance link, and the
 * expiry — everything the spec requires the invitation email to carry.
 */
export function composeInvitationEmail(
  message: InvitationEmailMessage,
  from: string,
): ComposedInvitationEmail {
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
  return { from, to: message.to, subject, text };
}

/**
 * Serialize a composed email to an RFC 822 message for SMTP `DATA`. Headers and
 * body are CRLF-joined; body lines beginning with '.' are dot-stuffed so the
 * single-dot terminator can never be forged by content.
 */
export function serializeInvitationEmail(
  email: ComposedInvitationEmail,
  now: Date,
): string {
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Date: ${now.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  const body = email.text
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line));
  return [...headers, '', ...body].join('\r\n');
}
