/**
 * Account mailer — the single transactional/account-email boundary (Sprint 16).
 *
 * One narrow seam delivers every account email Orgistry sends today
 * (organization invitations, email verification) and is the intended home for
 * future account messages (password recovery, security notifications). Feature
 * modules stay in charge of WHAT is sent: they render a plain-text
 * `AccountEmail` (see `invitation.mailer.ts` in invitations and
 * `email-verification.email.ts` in auth) and hand it to `deliver`. The mailer
 * owns HOW it is sent: sender identity, transport, and timeouts.
 *
 * Implementations (selected explicitly via `MAIL_DRIVER`, see
 * `account-mailer-factory.ts` — production can never silently fall back to a
 * dev sink):
 *  - `createMailpitAccountMailer`  — local development, plaintext SMTP to the
 *    Mailpit container;
 *  - `createSmtpAccountMailer`    — production driver: authenticated SMTP
 *    over implicit TLS (SMTPS);
 *  - `createInMemoryAccountMailer` (testing/) — captures messages so tests can
 *    inspect delivery without opening sockets.
 * Both socket drivers use nodemailer as the SMTP protocol implementation; the
 * factories in this module own only configuration validation and the
 * header-safety guard below.
 *
 * HEADER SAFETY: every value that becomes an email header (sender name and
 * address, recipient, subject — including feature-supplied content such as an
 * organization name embedded in a subject) is validated here, centrally,
 * before it reaches any transport. CR/LF/NUL are rejected outright, so no
 * caller input can smuggle an additional header or recipient. Non-ASCII text
 * in headers is allowed: nodemailer RFC 2047-encodes it.
 *
 * TOKEN TRANSPORT POLICY (Policy A, unchanged from Sprint 9): raw invitation
 * and verification tokens are delivered ONLY as links inside these emails —
 * email is the intended out-of-band channel. They never appear in API
 * responses, backend URL paths, logs, security events, or database rows (only
 * hashes are stored). This module and every driver therefore NEVER log message
 * content.
 *
 * Delivery failure behavior is caller-owned: `deliver` rejects on any
 * transport failure and callers decide whether that is fail-closed (invitation
 * create, explicit verification resend) or best-effort (post-registration
 * verification email).
 */

/** A rendered account email: recipient + content. Plain text only — Orgistry
 *  deliberately has no HTML template layer (see docs/invitations.md). */
export interface AccountEmail {
  /** Recipient address (single recipient; account email is always 1:1). */
  to: string;
  subject: string;
  /** Plain-text body. May legitimately contain a raw token link. */
  text: string;
}

/** Configured sender identity, applied uniformly by every driver. */
export interface SenderIdentity {
  email: string;
  /** Display name shown by mail clients, e.g. `Orgistry <no-reply@…>`. */
  name: string;
}

export interface AccountMailer {
  /**
   * Deliver one account email. MUST reject (throw) when the message cannot be
   * sent so callers can choose fail-closed or best-effort handling.
   */
  deliver(email: AccountEmail): Promise<void>;
}

/** Thrown when a would-be header value could forge additional headers. */
export class UnsafeHeaderValueError extends Error {
  constructor(field: string) {
    // Deliberately does not echo the offending value: it may be attacker
    // input destined for logs.
    super(
      `Account email ${field} contains a control character (CR/LF/NUL) and was rejected to prevent header injection`,
    );
    this.name = 'UnsafeHeaderValueError';
  }
}

/** CR, LF, and NUL can terminate/forge SMTP and MIME header lines. */
const HEADER_FORGING_CHARACTERS = ['\r', '\n', '\u0000'] as const;

function assertSafeHeaderValue(value: string, field: string): void {
  if (HEADER_FORGING_CHARACTERS.some((char) => value.includes(char))) {
    throw new UnsafeHeaderValueError(field);
  }
}

/**
 * Validate the configured sender identity. Called once, at driver
 * construction, so a mailer with a forgeable sender can never be built.
 */
export function assertSafeSenderIdentity(sender: SenderIdentity): void {
  assertSafeHeaderValue(sender.email, 'sender email');
  assertSafeHeaderValue(sender.name, 'sender display name');
}

/**
 * Validate the header-bound fields of one rendered email. Called by every
 * socket driver on every delivery — the single enforcement point for header
 * injection, regardless of which feature rendered the message. The body is
 * free-form (it is not a header).
 */
export function assertSafeAccountEmail(email: AccountEmail): void {
  assertSafeHeaderValue(email.to, 'recipient');
  assertSafeHeaderValue(email.subject, 'subject');
}
