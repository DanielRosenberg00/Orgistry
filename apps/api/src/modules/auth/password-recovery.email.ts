import type { AccountEmail } from '../mail/account-mailer';

/**
 * Password-recovery message rendering (Sprint 17). Pure — no IO, no logging.
 *
 * TOKEN TRANSPORT POLICY (Policy A, same as invitations and verification): the
 * raw reset token is delivered ONLY as a link in this email. The link points at
 * the WEB route and carries the token in the URL FRAGMENT
 * (`/auth/reset-password#token=…`): fragments are never sent in the HTTP
 * request, so the token cannot reach the web server, a reverse proxy, access
 * logs, or `Referer` headers. The frontend captures it from the fragment and
 * submits it to the API in a POST body, so it never appears in any backend URL.
 * This module never logs — the rendered body and URL carry the raw token.
 */

/** Inputs for one password-recovery email. `resetUrl` carries the raw token. */
export interface PasswordResetEmailMessage {
  /** The account's stored email address (the only allowed recipient). */
  to: string;
  /** Web reset link containing the raw token (out-of-band only). */
  resetUrl: string;
  /** When the link stops being completable. */
  expiresAt: Date;
}

/**
 * Build the web reset URL the email links to, from the configured public web
 * application URL. Deterministic; matches the frontend route
 * `/auth/reset-password` exactly. The token rides in the fragment, NEVER a
 * query string (see the transport policy above).
 */
export function buildPasswordResetUrl(
  webBaseUrl: string,
  rawToken: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/auth/reset-password#token=${encodeURIComponent(rawToken)}`;
}

/**
 * Render the password-recovery email: product identity, clear purpose, the
 * link, expiry context, and an ignore-if-unexpected line. Plain text only; no
 * passwords, hashes, internal IDs, session IDs, or provider details.
 */
export function renderPasswordResetEmail(
  message: PasswordResetEmailMessage,
): AccountEmail {
  const text = [
    'A password reset was requested for your Orgistry account.',
    '',
    'Choose a new password:',
    message.resetUrl,
    '',
    `This link expires on ${message.expiresAt.toISOString()} and can be used once. If it has expired, request a new one from the sign-in page.`,
    '',
    "If you didn't request a password reset, you can safely ignore this email — your password has not changed.",
  ].join('\n');
  return {
    to: message.to,
    subject: 'Reset your Orgistry password',
    text,
  };
}
