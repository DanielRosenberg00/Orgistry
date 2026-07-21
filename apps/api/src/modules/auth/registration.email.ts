import type { AccountEmail } from '../mail/account-mailer';

/**
 * Verification-first registration message rendering (Sprint 18). Pure — no IO,
 * no logging.
 *
 * TOKEN TRANSPORT POLICY (Policy A, same as verification and password reset):
 * the raw completion token is delivered ONLY as a link in the completion
 * email. The link points at the WEB route and carries the token in the URL
 * FRAGMENT (`/auth/complete-registration#token=…`): fragments are never sent
 * in the HTTP request, so the token cannot reach the web server, a reverse
 * proxy, access logs, or `Referer` headers. The frontend captures it from the
 * fragment and submits it to the API in a POST body, so it never appears in
 * any backend URL. This module never logs — the rendered body and URL carry
 * the raw token.
 *
 * The existing-account notice below carries NO token and NO account state —
 * it is guidance only, and is NOT a password-reset email (it never creates a
 * recovery token; it merely links to the public pages).
 */

/** Inputs for one registration-completion email. `completeUrl` carries the raw token. */
export interface RegistrationCompletionEmailMessage {
  /** The address the registration was requested for (the only allowed recipient). */
  to: string;
  /** Web completion link containing the raw token (out-of-band only). */
  completeUrl: string;
  /** When the link stops being completable. */
  expiresAt: Date;
  /**
   * Inviting organization's display name, when the registration carries an
   * invitation. Safe to include: the public invitation-inspect surface already
   * discloses it to any token holder. Never any other invitation detail.
   */
  invitationOrganizationName?: string | null;
}

/**
 * Build the web completion URL the email links to, from the configured public
 * web application URL. Deterministic; matches the frontend route
 * `/auth/complete-registration` exactly. The token rides in the fragment,
 * NEVER a query string (see the transport policy above).
 */
export function buildRegistrationCompletionUrl(
  webBaseUrl: string,
  rawToken: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/auth/complete-registration#token=${encodeURIComponent(rawToken)}`;
}

/**
 * Render the registration-completion email: product identity, clear purpose,
 * the link, expiry context, and an ignore-if-unexpected line. Plain text only;
 * no passwords, hashes, internal IDs, or private organization data.
 */
export function renderRegistrationCompletionEmail(
  message: RegistrationCompletionEmailMessage,
): AccountEmail {
  const intro = message.invitationOrganizationName
    ? `Finish creating your Orgistry account to join ${message.invitationOrganizationName}.`
    : 'Finish creating your Orgistry account.';
  const text = [
    intro,
    '',
    'Confirm your email address and complete your registration:',
    message.completeUrl,
    '',
    `This link expires on ${message.expiresAt.toISOString()} and can be used once. If it has expired, simply register again to receive a new one.`,
    '',
    "If you didn't try to create an Orgistry account, you can safely ignore this email — no account has been created.",
  ].join('\n');
  return {
    to: message.to,
    subject: 'Complete your Orgistry registration',
    text,
  };
}

/** Public sign-in page URL (token-free) for the guidance notice. */
export function buildLoginUrl(webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/auth/login`;
}

/** Public password-recovery request page URL (token-free) for the notice. */
export function buildForgotPasswordUrl(webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/auth/forgot-password`;
}

/** Inputs for the existing-account guidance notice. Carries NO secret material. */
export interface ExistingAccountNoticeMessage {
  /** The already-registered address the attempt was made against. */
  to: string;
  /** Public sign-in page URL (no token, no account state). */
  loginUrl: string;
  /** Public password-recovery request page URL (no token — the page only ASKS). */
  forgotPasswordUrl: string;
}

/**
 * Render the existing-account guidance email sent (rate-limited) when a
 * registration is attempted for an address that already has an account. It
 * deliberately contains no account, session, membership, or organization
 * details, and NO token of any kind — it is not a password-reset email and
 * never creates a recovery token.
 */
export function renderExistingAccountNoticeEmail(
  message: ExistingAccountNoticeMessage,
): AccountEmail {
  const text = [
    'Someone attempted to register an Orgistry account using this email address.',
    '',
    'If this was you: you already have an Orgistry account for this address. You can sign in here:',
    message.loginUrl,
    '',
    'If you have forgotten your password, you can request a reset here:',
    message.forgotPasswordUrl,
    '',
    'If this was not you, no action is required — your account is unchanged and no new account has been created.',
  ].join('\n');
  return {
    to: message.to,
    subject: 'A registration was attempted with your email address',
    text,
  };
}
