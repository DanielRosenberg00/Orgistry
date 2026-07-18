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
 *   including behind a TLS-terminating reverse proxy).
 */
export function enforceProductionConfigSafety(
  env: { NODE_ENV: string; JWT_SECRET: string; COOKIE_SECURE: boolean },
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
}
