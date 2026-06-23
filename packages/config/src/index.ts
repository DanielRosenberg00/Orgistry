import { envSchema, type Env } from './schema';

export { envSchema } from './schema';
export type { Env } from './schema';

/**
 * Structured, validated runtime configuration. This is the shape application
 * code consumes — environment variables are grouped into intent-revealing
 * sections rather than passed around as a flat bag of strings.
 */
export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly api: {
    readonly host: string;
    readonly port: number;
  };
  readonly web: {
    readonly url: string;
  };
  readonly cors: {
    readonly origins: readonly string[];
  };
  readonly database: {
    readonly url: string;
  };
  readonly redis: {
    readonly url: string;
  };
  readonly mailpit: {
    readonly host: string;
    readonly smtpPort: number;
    readonly uiPort: number;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly cookieSecret: string;
    readonly cookieSecure: boolean;
    readonly accessTokenTtlSeconds: number;
    readonly sessionTtlSeconds: number;
  };
  readonly rateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
  };
}

function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function toConfig(env: Env): Config {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    logLevel: env.LOG_LEVEL,
    api: {
      host: env.API_HOST,
      port: env.API_PORT,
    },
    web: {
      url: env.WEB_DEMO_URL,
    },
    cors: {
      origins: parseOrigins(env.CORS_ORIGINS),
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    mailpit: {
      host: env.MAILPIT_HOST,
      smtpPort: env.MAILPIT_SMTP_PORT,
      uiPort: env.MAILPIT_UI_PORT,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      cookieSecret: env.COOKIE_SECRET,
      cookieSecure: env.COOKIE_SECURE,
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: env.AUTH_SESSION_TTL_SECONDS,
    },
    rateLimit: {
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      max: env.RATE_LIMIT_MAX,
    },
  };
}

/**
 * Raised when configuration validation fails. The message lists every invalid
 * or missing variable so the fix is obvious without re-running.
 */
export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate a raw environment source and return structured config.
 *
 * Pure with respect to its input — pass an explicit record in tests. Throws
 * `ConfigValidationError` (never a raw ZodError) on invalid input.
 */
export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }
  return toConfig(result.data);
}

let cached: Config | undefined;

/**
 * Lazily load and cache config from `process.env`. Use this at process startup.
 * Tests should prefer `loadConfig` with an explicit source to stay isolated.
 */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
