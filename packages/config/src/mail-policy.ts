import { z } from 'zod';

/**
 * Driver-conditional mailer configuration rules (Sprint 16).
 *
 * The account mailer is selected explicitly via `MAIL_DRIVER`; each driver has
 * its own required inputs, so validation is conditional on the selection:
 *
 *  - `mailpit` needs only the `MAILPIT_*` fields (all defaulted) — local
 *    development must never require production-provider credentials;
 *  - `smtp` needs a full authenticated endpoint (`SMTP_HOST`, `SMTP_USERNAME`,
 *    `SMTP_PASSWORD`); the adapter always uses implicit TLS, so there is no
 *    insecure-transport toggle to validate;
 *  - `memory` needs nothing — it is an in-memory fake for automated tests.
 *
 * These rules apply in EVERY runtime mode: selecting the smtp driver without
 * credentials is a configuration error in development too, not just in
 * production. Production-only rejections (no mailpit/memory driver, no
 * placeholder credentials, no local-only sender) live in
 * `production-policy.ts`.
 */

interface MailerEnvFields {
  MAIL_DRIVER: 'mailpit' | 'smtp' | 'memory';
  SMTP_HOST?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
}

/** The SMTP fields that must be present when the smtp driver is selected. */
const REQUIRED_SMTP_FIELDS = [
  'SMTP_HOST',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
] as const;

export function enforceMailerConfigCompleteness(
  env: MailerEnvFields,
  ctx: z.RefinementCtx,
): void {
  if (env.MAIL_DRIVER !== 'smtp') {
    return;
  }

  for (const field of REQUIRED_SMTP_FIELDS) {
    if (env[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when MAIL_DRIVER=smtp; the smtp driver always authenticates against a real provider endpoint`,
      });
    }
  }
}
