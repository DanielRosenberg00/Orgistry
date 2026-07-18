import { z } from 'zod';
import { enforceMailerConfigCompleteness } from './mail-policy';
import { enforceProductionConfigSafety } from './production-policy';

/**
 * Runtime configuration schema for Orgistry.
 *
 * This is the single source of truth for every environment variable the
 * platform reads. `.env.example` must stay aligned with this schema. Validation
 * runs once at process startup (see `loadConfig`) and fails loudly so a
 * misconfigured process never boots into a partially-working state.
 *
 * Scope note: the JWT secret, refresh-cookie attributes, the CSRF header
 * name, and per-bucket auth rate limits are all declared here. Sprint 3 wires
 * them into the secure session lifecycle (refresh rotation, logout, session
 * management, CSRF enforcement, Redis-backed rate limiting). Sprint 15 adds
 * the production safety guard (`production-policy.ts`): under
 * `NODE_ENV=production`, development-default/weak secrets and
 * `COOKIE_SECURE=false` are rejected at load time.
 */

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const portSchema = z.coerce.number().int().min(1).max(65535);

/**
 * Raw environment schema. Keys map 1:1 to environment variable names so the
 * mapping between `.env` and validated config is obvious.
 */
const rawEnvSchema = z.object({
  // Runtime mode. `development` is the local default; `test` is used by the
  // automated suites and the test database reset flow.
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // API HTTP server.
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: portSchema.default(3000),

  // Web demo. Used for the default CORS allow-list entry.
  WEB_DEMO_URL: z.string().url().default('http://localhost:5173'),

  // CORS baseline: comma-separated list of allowed origins.
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // PostgreSQL — the durable local store.
  DATABASE_URL: z
    .string()
    .url()
    .describe('PostgreSQL connection string, e.g. postgres://user:pass@host:5432/db'),

  // Redis — backs the auth + external-API rate limiters and the readiness probe.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Account mailer driver (Sprint 16). Selection is explicit and deterministic:
  //   mailpit — local development sink (MAILPIT_* below); no auth, no TLS.
  //   smtp    — production driver (SMTP_* below): SMTP over implicit TLS;
  //             auth mechanism negotiated by nodemailer; credentials required.
  //   memory  — in-memory fake for automated tests only.
  // Under NODE_ENV=production the guard in `production-policy.ts` rejects
  // everything except `smtp`, so production can never silently fall back to
  // Mailpit or the test fake.
  MAIL_DRIVER: z.enum(['mailpit', 'smtp', 'memory']).default('mailpit'),

  // Sender identity used by every account email (invitations, verification).
  // The defaults are LOCAL-ONLY (`.local` is not routable); production must
  // set a real sender address — the production guard rejects the default and
  // any reserved-domain address.
  MAIL_FROM_EMAIL: z.string().email().default('no-reply@orgistry.local'),
  MAIL_FROM_NAME: z.string().min(1).default('Orgistry'),

  // Upper bound for one SMTP delivery attempt (socket timeout), both drivers.
  MAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Production SMTP endpoint (used only when MAIL_DRIVER=smtp; see
  // `mail-policy.ts` for the driver-conditional completeness rules). Local
  // development and tests never need these. Default port 465 = SMTPS
  // (implicit TLS); the driver offers no STARTTLS upgrade, so the chosen
  // provider endpoint must accept TLS-from-the-first-byte connections.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: portSchema.default(465),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),

  // Mailpit — local email delivery target (used only when MAIL_DRIVER=mailpit).
  // Account emails are delivered over SMTP to the Mailpit container at
  // MAILPIT_HOST:MAILPIT_SMTP_PORT; delivered messages are viewable in the
  // Mailpit web UI at MAILPIT_UI_PORT. Not a production email provider.
  MAILPIT_HOST: z.string().min(1).default('localhost'),
  MAILPIT_SMTP_PORT: portSchema.default(1025),
  MAILPIT_UI_PORT: portSchema.default(8025),

  // Email-verification token lifetime (Sprint 16). Bounds how long a raw
  // verification link remains completable. Default: 24 hours.
  EMAIL_VERIFICATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400),

  // Invitation token lifetime (Sprint 9). Bounds how long a raw invitation token
  // remains acceptable; expiry is enforced at inspect/accept/list time. Default:
  // 7 days.
  INVITATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(604_800),

  // Auth secret. Required so environments are provisioned correctly. The
  // 16-character floor is the development/test baseline; production is held to
  // the stricter policy in `production-policy.ts` (min 32 chars, no known
  // dev defaults, no placeholder-style or degenerate values).
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  // `true` in production-like environments, `false` on localhost over HTTP.
  // Default is the raw env string 'false'; the transform yields the boolean.
  // Drives the refresh cookie's `Secure` attribute. Under
  // `NODE_ENV=production` the guard below requires `true`.
  COOKIE_SECURE: booleanFromEnv.default('false'),

  // Access token lifetime. Short-lived by design; refresh-token rotation
  // (Sprint 3) makes the short TTL ergonomic. Default: 15 minutes.
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  // Session lifetime. A session outlives any single access token and is the
  // anchor the refresh-token family hangs off. Default: 30 days.
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),
  // Refresh-token lifetime. Bounds how long a single refresh credential (and
  // therefore the HttpOnly cookie's Max-Age) is valid; capped by the session.
  // Default: 30 days, matching the session.
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),

  // Refresh cookie attributes. The cookie is HttpOnly + SameSite=Lax always;
  // only the name, path scope, and Secure flag are configurable. The path
  // scopes the cookie to the auth surface that consumes it.
  AUTH_REFRESH_COOKIE_NAME: z.string().min(1).default('orgistry_rt'),
  AUTH_REFRESH_COOKIE_PATH: z.string().min(1).default('/v1/auth'),

  // Custom header required on cookie-backed session mutations (refresh/logout).
  // A request-forging site cannot set a custom header cross-origin without a
  // CORS preflight that the strict allow-list denies.
  AUTH_CSRF_HEADER_NAME: z.string().min(1).default('x-orgistry-csrf'),

  // Generic rate-limit namespace (declared in Sprint 1; not used for auth
  // buckets, which have their own typed values below).
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Auth rate-limit buckets (Sprint 3, Redis-backed, fixed-window). One shared
  // window length; per-bucket maximums tuned to each surface's abuse profile.
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_LOGIN_PER_IP_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_PER_EMAIL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_REGISTER_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_REFRESH_PER_SESSION_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_REFRESH_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(120),

  // Email-verification rate-limit buckets (Sprint 16). Same fixed window as
  // the other auth buckets (RATE_LIMIT_AUTH_WINDOW_SECONDS). Request/resend is
  // authenticated (per user + per IP); completion is public (per IP) and takes
  // the token in the body, so the token value itself never enters a limiter key.
  RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_EMAIL_VERIFICATION_COMPLETE_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),

  // External API rate-limit buckets (Sprint 8, Redis-backed, fixed-window). These
  // are SEPARATE from the auth buckets: external traffic is API-key authenticated,
  // not browser-session authenticated, and is limited per key and per organization.
  RATE_LIMIT_EXTERNAL_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_EXTERNAL_PER_KEY_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
  RATE_LIMIT_EXTERNAL_PER_ORG_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(600),

  // API key `last_used_at` write throttle (Sprint 8). Successful external auth
  // updates `last_used_at` at most once per this window per key, so a busy key
  // does not generate a write on every request. Default: 60 seconds.
  API_KEY_LAST_USED_THROTTLE_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(60),
});

/**
 * The full environment schema: raw field validation, the driver-conditional
 * mailer completeness rules, and the production safety guard. Both guards are
 * part of the schema itself (not a separate validation path) so every
 * `loadConfig` caller — including API boot — gets them unconditionally.
 */
export const envSchema = rawEnvSchema
  .superRefine(enforceMailerConfigCompleteness)
  .superRefine(enforceProductionConfigSafety);

export type Env = z.infer<typeof envSchema>;
