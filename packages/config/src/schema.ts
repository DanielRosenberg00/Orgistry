import { isIP } from 'node:net';
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
 * Typed proxy-trust value passed verbatim to Fastify's `trustProxy` option:
 * `false` (no proxy — forwarded headers ignored), a positive hop count, or an
 * explicit list of trusted proxy IPs/CIDRs.
 */
export type TrustProxySetting = false | number | readonly string[];

/**
 * Upper bound for the TRUST_PROXY hop count. Real reverse-proxy chains are a
 * handful of hops (CDN → LB → proxy is three); 16 is far beyond any sane
 * topology while still rejecting nonsense like an unbounded or overflowing
 * count — every hop above the real chain length is a spoofing opportunity.
 * The recommended normal deployment value is 1.
 */
export const TRUST_PROXY_MAX_HOPS = 16;

/**
 * True when `entry` is a real IP address or a well-formed CIDR block:
 * `node:net`'s `isIP` validates the address part (octet ranges, IPv6 group
 * syntax — no shape heuristics), and the optional prefix must be an
 * unpadded decimal within 0–32 (IPv4) or 0–128 (IPv6).
 */
function isIpOrCidr(entry: string): boolean {
  const slashIndex = entry.indexOf('/');
  const address = slashIndex === -1 ? entry : entry.slice(0, slashIndex);
  const family = isIP(address); // 0 = not an IP, 4, or 6
  if (family === 0) {
    return false;
  }
  if (slashIndex === -1) {
    return true;
  }
  const prefix = entry.slice(slashIndex + 1);
  if (!/^(0|[1-9]\d{0,2})$/.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parse the TRUST_PROXY environment string into its typed form, or `undefined`
 * when the value is not acceptable. `'true'` is rejected deliberately —
 * unbounded trust would let any direct client spoof its resolved IP.
 */
export function parseTrustProxy(raw: string): TrustProxySetting | undefined {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'true') {
    return undefined;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  if (/^\d+$/.test(value)) {
    // Plain decimal digits only (scientific notation, decimals, and signs
    // fall through to the IP/CIDR branch and fail there). The count must be
    // a Number-safe integer within 1..TRUST_PROXY_MAX_HOPS — an overlong or
    // overflowing digit string is a misconfiguration, not a hop count.
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > TRUST_PROXY_MAX_HOPS) {
      return undefined;
    }
    return hops;
  }
  // Empty entries (leading/trailing/double commas) are REJECTED, not skipped:
  // a malformed list must fail loudly at boot, never silently trust less (or
  // more) than the operator wrote.
  const entries = value.split(',').map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    !entries.every((entry) => entry.length > 0 && isIpOrCidr(entry))
  ) {
    return undefined;
  }
  return entries;
}

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

  // Reverse-proxy trust (Sprint 19). Controls Fastify's `trustProxy` at
  // construction time — the ONLY place forwarded headers may be honored.
  //   'false'          — default. Direct exposure: `X-Forwarded-*` from the
  //                      socket peer is IGNORED; `request.ip` is the socket IP.
  //   a positive int   — trust exactly that many proxy hops (e.g. '1' for one
  //                      TLS-terminating reverse proxy directly in front).
  //   comma-separated  — explicit trusted proxy IPs/CIDRs (e.g.
  //                      '10.0.0.0/8,172.16.0.0/12') once the deployment
  //                      defines a stable proxy address range.
  // `'true'` (trust everything) is deliberately NOT accepted: it would let any
  // direct client spoof its IP — and therefore every IP-keyed rate limit and
  // security event — with a forged header.
  TRUST_PROXY: z
    .string()
    .default('false')
    .superRefine((value, ctx) => {
      if (parseTrustProxy(value) === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `TRUST_PROXY must be "false", a hop count between 1 and ${TRUST_PROXY_MAX_HOPS} (e.g. "1" for one reverse proxy), or a comma-separated list of valid proxy IPs/CIDRs (IPv4 prefix 0-32, IPv6 prefix 0-128; no hostnames, no empty entries); "true" (trust every peer) is not accepted`,
        });
      }
    }),

  // HSTS lifetime (Sprint 19). Strict-Transport-Security is emitted only when
  // BOTH NODE_ENV=production AND Fastify's proxy-aware request protocol
  // resolves to https (a real TLS socket, or X-Forwarded-Proto from a TRUSTED
  // hop), so local plain-HTTP development is never poisoned with a cached
  // HSTS policy and a forged header cannot mint one. Default: 180 days.
  HSTS_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(15_552_000),

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

  // Password-reset token lifetime (Sprint 17). Deliberately SHORT — the link
  // authorizes replacing the account password, so it is far shorter-lived than
  // the 24h verification link. Default: 1 hour.
  PASSWORD_RESET_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600),

  // Registration-completion token lifetime (Sprint 18). Bounds how long the
  // emailed complete-registration link (and the staged pending registration
  // behind it) remains usable. Default: 24 hours, matching the verification
  // link — the token creates a fresh account rather than granting access to an
  // existing one, so the longer verification-style window is appropriate.
  REGISTRATION_COMPLETION_TTL_SECONDS: z.coerce
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

  // Global API rate limit (Sprint 19; the variables date from Sprint 1). One
  // fixed-window bucket per trusted client IP applied to every route before
  // route-specific processing, as a baseline abuse boundary — it never replaces
  // the stricter per-endpoint buckets below. `/health`, `/ready`, and CORS
  // preflight (OPTIONS) are exempt (operators poll the probes; preflights are
  // browser-controlled). The global bucket FAILS OPEN on a Redis outage by
  // design regardless of RATE_LIMIT_FAILURE_MODE: readiness already takes the
  // instance out of rotation, and failing the entire API closed would turn a
  // Redis blip into a total outage while every sensitive endpoint keeps its
  // own fail-closed bucket.
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // Rate-limit failure mode (Sprint 19, ORG-PR-009). Governs what SENSITIVE
  // route-specific limiters do when the Redis limiter store is unreachable:
  //   open   — allow the request (development/test usability).
  //   closed — reject with 503 SERVICE_UNAVAILABLE (production posture: an
  //            outage must not silently disable credential/token abuse
  //            controls).
  // Defaults per environment: production → closed, development/test → open.
  // The production guard additionally REJECTS an explicit 'open' in
  // production.
  RATE_LIMIT_FAILURE_MODE: z.enum(['open', 'closed']).optional(),

  // Invitation abuse-control buckets (Sprint 19, ORG-PR-012). The public
  // inspect endpoint is limited per trusted IP AND per token-derived internal
  // digest (never the raw token); accept and create are authenticated and
  // limited per user (+ per organization for create, which sends real email).
  // Shares the auth fixed window.
  RATE_LIMIT_INVITATION_INSPECT_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  RATE_LIMIT_INVITATION_INSPECT_PER_TOKEN_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_INVITATION_ACCEPT_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_INVITATION_CREATE_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  RATE_LIMIT_INVITATION_CREATE_PER_ORG_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // Authenticated-mutation buckets (Sprint 19, ORG-PR-032). Targeted limits on
  // the mutations that are genuinely spammable — they provision durable rows,
  // write audit events, or (invitations) send real email on every call. Keyed
  // by authenticated user id and/or organization id (trusted identities), one
  // shared fixed window. Reads and low-cost idempotent mutations are
  // deliberately unlimited — see the abuse-control matrix in the docs.
  RATE_LIMIT_MUTATION_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_ORG_CREATE_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  // Member-administration mutations (role change + removal) and project
  // update/delete each write a durable audit event per call, so they share
  // per-acting-user buckets. Ceilings are generous — legitimate admin work
  // never approaches them; a scripted audit-write loop does.
  RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // Audit-log READ buckets (Sprint 22, ORG-PR-055). The audit list is the one
  // read whose cost is not bounded by its page size: the `targetId` filter
  // matches against JSONB metadata keys that carry no index, so a filter that
  // selects nothing scans the organization's whole slice of `security_events`
  // — a table with no retention policy yet (ORG-PR-015). Permission +
  // entitlement gates bound WHO may ask, not HOW OFTEN, so this surface gets
  // its own per-actor and per-organization ceilings. Generous for humans and
  // dashboards; a scripted scan loop hits them immediately.
  RATE_LIMIT_AUDIT_READ_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_AUDIT_READ_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RATE_LIMIT_AUDIT_READ_PER_ORG_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(240),

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
  // Registration buckets (Sprint 17, extended in Sprint 18 for the
  // verification-first flow). The request endpoint is public and limited per
  // IP AND per normalized-email digest BEFORE any account lookup; completion
  // is public and limited per IP and per token-derived internal key. No raw
  // email or token material ever enters a limiter key.
  RATE_LIMIT_REGISTER_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_REGISTER_PER_EMAIL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  RATE_LIMIT_REGISTRATION_COMPLETE_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_REGISTRATION_COMPLETE_PER_TOKEN_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  // Existing-account guidance email throttle (Sprint 18): bounds how often a
  // registration attempt against an already-registered address may generate a
  // sign-in/recovery guidance email to that mailbox. INTERNAL — exceeding it
  // silently skips the email (never an error), so it cannot alter the public
  // registration contract.
  RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
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

  // Credential-mutation buckets (Sprint 17): authenticated per-user limits on
  // password change and email change. Low ceilings — a legitimate user rotates
  // credentials rarely; a runaway client or scripted abuse should hit the wall
  // quickly. Same fixed window as the other auth buckets.
  RATE_LIMIT_CHANGE_PASSWORD_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_CHANGE_EMAIL_PER_USER_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(3),

  // Password-recovery buckets (Sprint 17). The public request endpoint is
  // limited per IP AND per normalized-email digest (the email limit bounds
  // mailbox flooding for one victim across an attacker's IP pool). Completion
  // is limited per IP and per token-derived internal key (brute-force retries
  // against one specific token). No raw email or token material ever enters a
  // limiter key.
  RATE_LIMIT_PASSWORD_RECOVERY_REQUEST_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_PASSWORD_RECOVERY_REQUEST_PER_EMAIL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  RATE_LIMIT_PASSWORD_RECOVERY_COMPLETE_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_PASSWORD_RECOVERY_COMPLETE_PER_TOKEN_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),

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

  // External failed-auth durable-event bound (Sprint 19, ORG-PR-013). At most
  // this many DURABLE `security_events` rows are written per source IP per
  // external window for FAILED API-key authentication (missing/malformed/
  // unknown/revoked/expired/inactive-org — the 401 family). Beyond the bound
  // (or when the limiter store is unreachable) the failure is still visible
  // through sanitized structured logs, but no further rows are written, so an
  // invalid-credential storm cannot grow the table one row per request. The
  // 401 response contract itself is unchanged.
  RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),

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
