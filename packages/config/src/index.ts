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
  /** Invitation behavior knobs (Sprint 9). */
  readonly invitations: {
    /** Raw invitation token lifetime in seconds. */
    readonly ttlSeconds: number;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly cookieSecret: string;
    readonly cookieSecure: boolean;
    readonly accessTokenTtlSeconds: number;
    readonly sessionTtlSeconds: number;
    readonly refreshTokenTtlSeconds: number;
    /** Custom header required on cookie-backed session mutations. */
    readonly csrfHeaderName: string;
    /**
     * Centralized refresh-cookie attributes. Set and clear logic both read
     * from here so cookie attributes can never drift between the two paths.
     */
    readonly refreshCookie: {
      readonly name: string;
      readonly path: string;
      readonly sameSite: 'lax';
      readonly httpOnly: true;
      readonly secure: boolean;
      readonly maxAgeSeconds: number;
    };
  };
  readonly rateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
    /** Per-bucket auth rate limits sharing one fixed window. */
    readonly auth: {
      readonly windowSeconds: number;
      readonly loginPerIpMax: number;
      readonly loginPerEmailMax: number;
      readonly registerPerIpMax: number;
      readonly refreshPerSessionMax: number;
      readonly refreshPerIpMax: number;
    };
    /** External API rate limits (per key, per organization). */
    readonly external: {
      readonly windowSeconds: number;
      readonly perKeyMax: number;
      readonly perOrgMax: number;
    };
  };
  /** API key behavior knobs (Sprint 8). */
  readonly apiKeys: {
    /** Minimum seconds between `last_used_at` writes for a single key. */
    readonly lastUsedThrottleSeconds: number;
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
    invitations: {
      ttlSeconds: env.INVITATION_TTL_SECONDS,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      cookieSecret: env.COOKIE_SECRET,
      cookieSecure: env.COOKIE_SECURE,
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: env.AUTH_SESSION_TTL_SECONDS,
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      csrfHeaderName: env.AUTH_CSRF_HEADER_NAME.toLowerCase(),
      refreshCookie: {
        name: env.AUTH_REFRESH_COOKIE_NAME,
        path: env.AUTH_REFRESH_COOKIE_PATH,
        sameSite: 'lax',
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        maxAgeSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      },
    },
    rateLimit: {
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      max: env.RATE_LIMIT_MAX,
      auth: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        loginPerIpMax: env.RATE_LIMIT_LOGIN_PER_IP_MAX,
        loginPerEmailMax: env.RATE_LIMIT_LOGIN_PER_EMAIL_MAX,
        registerPerIpMax: env.RATE_LIMIT_REGISTER_PER_IP_MAX,
        refreshPerSessionMax: env.RATE_LIMIT_REFRESH_PER_SESSION_MAX,
        refreshPerIpMax: env.RATE_LIMIT_REFRESH_PER_IP_MAX,
      },
      external: {
        windowSeconds: env.RATE_LIMIT_EXTERNAL_WINDOW_SECONDS,
        perKeyMax: env.RATE_LIMIT_EXTERNAL_PER_KEY_MAX,
        perOrgMax: env.RATE_LIMIT_EXTERNAL_PER_ORG_MAX,
      },
    },
    apiKeys: {
      lastUsedThrottleSeconds: env.API_KEY_LAST_USED_THROTTLE_SECONDS,
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
