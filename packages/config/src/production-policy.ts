import { z } from 'zod';

/**
 * Production configuration safety policy (Sprint 15, ORG-PR-003).
 *
 * When `NODE_ENV=production`, configuration loading must refuse values that are
 * safe for local development but dangerous in production: the shipped
 * development-default secrets, placeholder-style secrets, trivially weak
 * secrets, and a refresh cookie without the `Secure` attribute. The policy is
 * deliberately simple and deterministic — exact known-value rejection, a length
 * floor, and obvious-placeholder detection. It is NOT an entropy estimator:
 * probabilistic strength scoring gives false confidence and unreproducible
 * failures, while this policy is trivially auditable and its failures are
 * exactly reproducible.
 *
 * This module is the only place production secret rules live. `envSchema`
 * applies it via `superRefine`, so every consumer of `loadConfig`/`getConfig`
 * (including API boot) gets the guard with no opt-out. See
 * docs/production-config-guard.md for the full contract.
 */

/**
 * Minimum production secret length in UTF-8 characters. Operators should
 * generate at least 32 random bytes, hex-encoded (`openssl rand -hex 32`
 * yields 64 hex characters), which always clears this floor.
 */
const PRODUCTION_SECRET_MIN_LENGTH = 32;

/**
 * Every secret value this repository ships or documents as local-only. These
 * are rejected EXACTLY (not just by length/marker heuristics) so a copied
 * `.env.example`, test fixture, or CI value can never boot a production
 * process. Keep this list in sync with `.env.example`,
 * `apps/api/src/testing/build-test-app.ts`, and `.github/workflows/ci.yml`.
 */
const KNOWN_DEVELOPMENT_SECRETS: readonly string[] = [
  // `.env.example` local defaults.
  'dev-only-jwt-secret-change-me',
  'dev-only-cookie-secret-change-me',
  // Unit/injection-test fixtures.
  'test-jwt-secret-value-1234',
  'test-cookie-secret-value-1234',
  // CI workflow values.
  'ci-jwt-secret-value-1234',
  'ci-cookie-secret-value-1234',
];

/**
 * Substrings that mark a value as an obvious placeholder rather than a
 * generated secret. Matched case-insensitively anywhere in the value.
 */
const PLACEHOLDER_MARKERS: readonly string[] = [
  'change-me',
  'changeme',
  'dev-only',
  'replace-me',
  'placeholder',
  'example-secret',
  'default-secret',
];

/**
 * Sender addresses this repository ships as local-only defaults, rejected
 * exactly in production (Sprint 16).
 */
const KNOWN_DEVELOPMENT_SENDERS: readonly string[] = [
  'no-reply@orgistry.local',
  'invitations@orgistry.local',
];

/**
 * Reserved / non-routable domain suffixes (RFC 2606, RFC 6761, mDNS). A
 * production sender address on one of these can never deliver mail.
 */
const RESERVED_SENDER_DOMAIN_SUFFIXES: readonly string[] = [
  '.local',
  '.localhost',
  '.test',
  '.invalid',
  '.example',
  '@example.com',
  '@example.org',
  '@example.net',
];

function containsPlaceholderMarker(secret: string): string | undefined {
  const lowered = secret.toLowerCase();
  return PLACEHOLDER_MARKERS.find((marker) => lowered.includes(marker));
}

/** A value consisting of one character repeated (e.g. "aaaa…") is never a secret. */
function isObviouslyDegenerateSecret(secret: string): boolean {
  return secret.length > 0 && new Set(secret).size === 1;
}

/**
 * Collect every production-policy violation for one secret field. Messages
 * name the field and say how to fix it, but never echo the secret value.
 */
function collectProductionSecretIssues(
  fieldName: string,
  secret: string,
): string[] {
  const generateHint =
    'generate at least 32 random bytes, e.g. `openssl rand -hex 32`, and set it in the deployment environment';
  const issues: string[] = [];

  if (KNOWN_DEVELOPMENT_SECRETS.includes(secret)) {
    issues.push(
      `${fieldName} is a known development-only default and must not be used in production; ${generateHint}`,
    );
  }
  const marker = containsPlaceholderMarker(secret);
  if (marker !== undefined) {
    issues.push(
      `${fieldName} contains the placeholder marker "${marker}" and must not be used in production; ${generateHint}`,
    );
  }
  if (isObviouslyDegenerateSecret(secret)) {
    issues.push(
      `${fieldName} is a single repeated character and must not be used in production; ${generateHint}`,
    );
  }
  if (secret.length < PRODUCTION_SECRET_MIN_LENGTH) {
    issues.push(
      `${fieldName} must be at least ${PRODUCTION_SECRET_MIN_LENGTH} characters in production; ${generateHint}`,
    );
  }
  return issues;
}

/**
 * Like {@link collectProductionSecretIssues} but WITHOUT the 32-character
 * length floor. Used for provider-issued credentials (`SMTP_PASSWORD`) whose
 * length the operator does not control — we still refuse every value this
 * repository documents as local-only, obvious placeholders, and degenerate
 * strings, but a legitimate provider credential must never be rejected for
 * being shorter than our own generated-secret floor.
 */
function collectProviderCredentialIssues(
  fieldName: string,
  secret: string,
): string[] {
  const fixHint =
    'set the real credential issued by the email provider in the deployment environment';
  const issues: string[] = [];

  if (KNOWN_DEVELOPMENT_SECRETS.includes(secret)) {
    issues.push(
      `${fieldName} is a known development-only default and must not be used in production; ${fixHint}`,
    );
  }
  const marker = containsPlaceholderMarker(secret);
  if (marker !== undefined) {
    issues.push(
      `${fieldName} contains the placeholder marker "${marker}" and must not be used in production; ${fixHint}`,
    );
  }
  if (isObviouslyDegenerateSecret(secret)) {
    issues.push(
      `${fieldName} is a single repeated character and must not be used in production; ${fixHint}`,
    );
  }
  return issues;
}

/** Reject sender addresses that can never deliver mail from production. */
function collectProductionSenderIssues(senderEmail: string): string[] {
  const lowered = senderEmail.toLowerCase();
  const fixHint =
    'set MAIL_FROM_EMAIL to a deliverable address on a domain the deployment controls';

  if (KNOWN_DEVELOPMENT_SENDERS.includes(lowered)) {
    return [
      `MAIL_FROM_EMAIL is the repository's local-only default sender and must not be used in production; ${fixHint}`,
    ];
  }
  const suffix = RESERVED_SENDER_DOMAIN_SUFFIXES.find((candidate) =>
    lowered.endsWith(candidate),
  );
  if (suffix !== undefined) {
    return [
      `MAIL_FROM_EMAIL uses the reserved, non-routable domain suffix "${suffix}" and must not be used in production; ${fixHint}`,
    ];
  }
  return [];
}

/**
 * The public web URL is embedded in every emailed verification/invitation
 * link, so a localhost or plain-HTTP value in production produces links that
 * are broken or downgrade the token to an insecure transport.
 */
function collectProductionWebUrlIssues(webUrl: string): string[] {
  const issues: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch {
    // Unparseable values are already rejected by the base `.url()` schema.
    return issues;
  }

  if (parsed.protocol !== 'https:') {
    issues.push(
      'WEB_DEMO_URL must use https in production; emailed verification and invitation links embed this origin',
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    issues.push(
      'WEB_DEMO_URL must not point at localhost in production; emailed verification and invitation links embed this origin',
    );
  }
  return issues;
}

/** Single issue-creation path: every production violation is a custom Zod issue on its field. */
function addProductionIssue(
  ctx: z.RefinementCtx,
  field: string,
  message: string,
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
}

/**
 * `superRefine` guard applied to the parsed environment. A no-op outside
 * `NODE_ENV=production`; in production it rejects (fails closed — no warning,
 * no coercion):
 *
 * - `JWT_SECRET` values that are known development defaults, placeholder-like,
 *   degenerate, or shorter than {@link PRODUCTION_SECRET_MIN_LENGTH};
 * - `COOKIE_SECURE=false` (the refresh cookie must only travel over HTTPS,
 *   including behind a TLS-terminating reverse proxy);
 * - `MAIL_DRIVER` values other than `smtp` (production must never silently
 *   deliver account email to the local Mailpit sink or the in-memory fake);
 * - `SMTP_PASSWORD` values that are known development defaults,
 *   placeholder-like, or degenerate (no length floor — provider-issued
 *   credential lengths are not ours to dictate);
 * - `MAIL_FROM_EMAIL` values that are the shipped local-only default or on a
 *   reserved, non-routable domain;
 * - `WEB_DEMO_URL` values that are plain-HTTP or localhost (emailed links
 *   embed this origin).
 */
export function enforceProductionConfigSafety(
  env: {
    NODE_ENV: string;
    JWT_SECRET: string;
    COOKIE_SECURE: boolean;
    MAIL_DRIVER: 'mailpit' | 'smtp' | 'memory';
    MAIL_FROM_EMAIL: string;
    SMTP_PASSWORD?: string;
    WEB_DEMO_URL: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  for (const message of collectProductionSecretIssues(
    'JWT_SECRET',
    env.JWT_SECRET,
  )) {
    addProductionIssue(ctx, 'JWT_SECRET', message);
  }

  if (!env.COOKIE_SECURE) {
    addProductionIssue(
      ctx,
      'COOKIE_SECURE',
      'COOKIE_SECURE must be "true" when NODE_ENV=production so the refresh cookie is only sent over HTTPS; this is required even behind a TLS-terminating reverse proxy',
    );
  }

  if (env.MAIL_DRIVER !== 'smtp') {
    addProductionIssue(
      ctx,
      'MAIL_DRIVER',
      `MAIL_DRIVER must be "smtp" when NODE_ENV=production; the "${env.MAIL_DRIVER}" driver is a local development/test sink and would silently swallow account email`,
    );
  }

  // The completeness rule in `mail-policy.ts` already requires SMTP_PASSWORD
  // whenever MAIL_DRIVER=smtp; here we additionally refuse obvious non-secrets.
  if (env.SMTP_PASSWORD !== undefined) {
    for (const message of collectProviderCredentialIssues(
      'SMTP_PASSWORD',
      env.SMTP_PASSWORD,
    )) {
      addProductionIssue(ctx, 'SMTP_PASSWORD', message);
    }
  }

  for (const message of collectProductionSenderIssues(env.MAIL_FROM_EMAIL)) {
    addProductionIssue(ctx, 'MAIL_FROM_EMAIL', message);
  }

  for (const message of collectProductionWebUrlIssues(env.WEB_DEMO_URL)) {
    addProductionIssue(ctx, 'WEB_DEMO_URL', message);
  }
}
