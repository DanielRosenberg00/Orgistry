import type { AccountEmail } from '../mail/account-mailer';

/**
 * Email-verification message rendering (Sprint 16). Pure — no IO, no logging.
 *
 * TOKEN TRANSPORT POLICY (Policy A, same as invitations): the raw verification
 * token is delivered ONLY as a link in this email. The link points at the WEB
 * route and carries the token in the URL FRAGMENT (`/auth/verify-email#token=…`):
 * fragments are never sent in the HTTP request, so the token cannot reach the
 * web server, a reverse proxy, access logs, or `Referer` headers. The frontend
 * captures it from the fragment and submits it to the API in a POST body, so
 * it never appears in any backend URL. This module never logs — the rendered
 * body and URL carry the raw token.
 */

/** Inputs for one verification email. `verifyUrl` carries the raw token. */
export interface EmailVerificationEmailMessage {
  /** The account's stored email address (the only allowed recipient). */
  to: string;
  /** Web verification link containing the raw token (out-of-band only). */
  verifyUrl: string;
  /** When the link stops being completable. */
  expiresAt: Date;
}

/**
 * Build the web verification URL the email links to, from the configured
 * public web application URL. Deterministic; matches the frontend route
 * `/auth/verify-email` exactly. The token rides in the fragment, NEVER a
 * query string (see the transport policy above).
 */
export function buildEmailVerificationUrl(
  webBaseUrl: string,
  rawToken: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/auth/verify-email#token=${encodeURIComponent(rawToken)}`;
}

/**
 * Render the verification email: product identity, clear purpose, the link,
 * expiry context, and an ignore-if-unexpected line. Plain text only; no
 * internal IDs, hashes, or provider details.
 */
export function renderEmailVerificationEmail(
  message: EmailVerificationEmailMessage,
): AccountEmail {
  const text = [
    'Confirm that this email address belongs to your Orgistry account.',
    '',
    'Verify your email address:',
    message.verifyUrl,
    '',
    `This link expires on ${message.expiresAt.toISOString()}. If it has expired, sign in and request a new verification email.`,
    '',
    "If you didn't create an Orgistry account, you can safely ignore this email.",
  ].join('\n');
  return {
    to: message.to,
    subject: 'Verify your email address for Orgistry',
    text,
  };
}
