import { z } from 'zod';

/**
 * Runtime configuration schema for Orgistry.
 *
 * This is the single source of truth for every environment variable the
 * platform reads. `.env.example` must stay aligned with this schema. Validation
 * runs once at process startup (see `loadConfig`) and fails loudly so a
 * misconfigured process never boots into a partially-working state.
 *
 * Scope note (Sprint 1): JWT/cookie secrets and the rate-limit namespace are
 * declared here so configuration is stable for later sprints, but no auth or
 * rate-limiting behavior is implemented yet.
 */

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const portSchema = z.coerce.number().int().min(1).max(65535);

/**
 * Raw environment schema. Keys map 1:1 to environment variable names so the
 * mapping between `.env` and validated config is obvious.
 */
export const envSchema = z.object({
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

  // Redis — available for future rate limiting and used by the readiness probe.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Mailpit — available for future local email flows. Not used at runtime yet.
  MAILPIT_HOST: z.string().min(1).default('localhost'),
  MAILPIT_SMTP_PORT: portSchema.default(1025),
  MAILPIT_UI_PORT: portSchema.default(8025),

  // Auth secrets (future sprints). Required so environments are provisioned
  // correctly now; no token issuance happens in Sprint 1.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  COOKIE_SECRET: z
    .string()
    .min(16, 'COOKIE_SECRET must be at least 16 characters'),
  // `true` in production-like environments, `false` on localhost over HTTP.
  // Default is the raw env string 'false'; the transform yields the boolean.
  COOKIE_SECURE: booleanFromEnv.default('false'),

  // Access token lifetime. Short-lived by design (Sprint 2 issues access
  // tokens; refresh-token rotation that makes short TTLs ergonomic arrives in
  // a later sprint). Default: 15 minutes.
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  // Session lifetime. A session outlives any single access token and is the
  // anchor the future refresh-token family hangs off. Default: 30 days.
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),

  // Rate-limit namespace (enforcement is implemented in a later sprint).
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

export type Env = z.infer<typeof envSchema>;
