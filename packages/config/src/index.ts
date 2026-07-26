import {
  envSchema,
  parseTrustProxy,
  type Env,
  type TrustProxySetting,
} from './schema';

export { envSchema, parseTrustProxy, TRUST_PROXY_MAX_HOPS } from './schema';
export type { Env, TrustProxySetting } from './schema';

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
    /**
     * Proxy trust passed verbatim to Fastify at construction time (Sprint 19):
     * `false` = direct exposure (forwarded headers ignored), a positive
     * integer = trusted proxy hop count, or an explicit IP/CIDR allow-list.
     */
    readonly trustProxy: TrustProxySetting;
  };
  /** Edge security-header knobs (Sprint 19). */
  readonly security: {
    /**
     * `max-age` for Strict-Transport-Security. The header is emitted only
     * under NODE_ENV=production AND for requests whose proxy-aware protocol
     * resolves to https; it never affects local HTTP use.
     */
    readonly hstsMaxAgeSeconds: number;
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
  /**
   * Account-mailer selection and sender identity (Sprint 16). Exactly one
   * driver is active; `smtp` is populated only when the smtp driver is
   * selected (the schema requires its credentials in that case).
   */
  readonly mail: {
    readonly driver: 'mailpit' | 'smtp' | 'memory';
    readonly fromEmail: string;
    readonly fromName: string;
    /** Socket timeout for one delivery attempt, in milliseconds. */
    readonly timeoutMs: number;
    /** Authenticated implicit-TLS SMTP endpoint; only set for the smtp driver. */
    readonly smtp?: {
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly password: string;
    };
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
  /** Email-verification behavior knobs (Sprint 16). */
  readonly emailVerification: {
    /** Raw verification token lifetime in seconds. */
    readonly ttlSeconds: number;
  };
  /** Password-recovery behavior knobs (Sprint 17). */
  readonly passwordRecovery: {
    /** Raw reset token lifetime in seconds. Short-lived by design. */
    readonly ttlSeconds: number;
  };
  /** Verification-first registration behavior knobs (Sprint 18). */
  readonly registration: {
    /** Raw completion-token (and pending-registration) lifetime in seconds. */
    readonly completionTtlSeconds: number;
  };
  readonly auth: {
    readonly jwtSecret: string;
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
    /**
     * Global per-trusted-IP API rate limit (Sprint 19): `windowSeconds` and
     * `max` bound every route as a baseline before route-specific buckets.
     * Health/readiness and CORS preflight are exempt; the global bucket fails
     * open on a limiter-store outage by design (readiness gates rotation).
     */
    readonly windowSeconds: number;
    readonly max: number;
    /**
     * What SENSITIVE route-specific limiters do when the Redis limiter store
     * is unreachable (Sprint 19, ORG-PR-009): `open` allows the request
     * (development/test), `closed` rejects with 503 (production default;
     * production refuses `open`).
     */
    readonly failureMode: 'open' | 'closed';
    /** Per-bucket auth rate limits sharing one fixed window. */
    readonly auth: {
      readonly windowSeconds: number;
      readonly loginPerIpMax: number;
      readonly loginPerEmailMax: number;
      readonly refreshPerSessionMax: number;
      readonly refreshPerIpMax: number;
      readonly changePasswordPerUserMax: number;
      readonly changeEmailPerUserMax: number;
    };
    /**
     * Verification-first registration buckets (Sprint 18; the request buckets
     * date from Sprint 17). Shares the auth fixed window. Request is public
     * (per IP + per email digest, BEFORE any account lookup); completion is
     * public (per IP + per token-derived internal key). The notice bucket is
     * INTERNAL: exceeding it silently skips the existing-account guidance
     * email and never surfaces as an error.
     */
    readonly registration: {
      readonly windowSeconds: number;
      readonly requestPerIpMax: number;
      readonly requestPerEmailMax: number;
      readonly completePerIpMax: number;
      readonly completePerTokenMax: number;
      readonly existingAccountNoticePerEmailMax: number;
    };
    /**
     * Email-verification buckets (Sprint 16). Shares the auth fixed window:
     * verification is an auth surface and one window length keeps the policy
     * legible.
     */
    readonly emailVerification: {
      readonly windowSeconds: number;
      readonly requestPerUserMax: number;
      readonly requestPerIpMax: number;
      readonly completePerIpMax: number;
    };
    /**
     * Password-recovery buckets (Sprint 17). Shares the auth fixed window.
     * Request is public (per IP + per email digest); completion is public
     * (per IP + per token-derived internal key).
     */
    readonly passwordRecovery: {
      readonly windowSeconds: number;
      readonly requestPerIpMax: number;
      readonly requestPerEmailMax: number;
      readonly completePerIpMax: number;
      readonly completePerTokenMax: number;
    };
    /**
     * Invitation abuse-control buckets (Sprint 19, ORG-PR-012). Public
     * inspect is limited per trusted IP + per token-derived digest (never the
     * raw token); accept/create are authenticated per-user (+ per-org for
     * create). Shares the auth fixed window.
     */
    readonly invitations: {
      readonly windowSeconds: number;
      readonly inspectPerIpMax: number;
      readonly inspectPerTokenMax: number;
      readonly acceptPerUserMax: number;
      readonly createPerUserMax: number;
      readonly createPerOrgMax: number;
    };
    /**
     * Targeted authenticated-mutation buckets (Sprint 19, ORG-PR-032) for the
     * spammable provisioning mutations. Keyed by authenticated user and/or
     * organization id; one shared fixed window.
     */
    readonly mutations: {
      readonly windowSeconds: number;
      readonly orgCreatePerUserMax: number;
      readonly projectCreatePerUserMax: number;
      readonly projectMutationPerUserMax: number;
      readonly apiKeyCreatePerUserMax: number;
      readonly planChangePerOrgMax: number;
      readonly memberMutationPerUserMax: number;
    };
    /**
     * Audit-log READ buckets (Sprint 22, ORG-PR-055). The only read surface
     * with its own ceilings: its `targetId` filter scans un-indexed JSONB
     * metadata over an unbounded table, so page size does not bound its cost.
     * Keyed by acting user and by organization — the per-org bucket bounds a
     * set of member accounts coordinating against one tenant's event history.
     */
    readonly auditRead: {
      readonly windowSeconds: number;
      readonly perUserMax: number;
      readonly perOrgMax: number;
    };
    /** External API rate limits (per key, per organization). */
    readonly external: {
      readonly windowSeconds: number;
      readonly perKeyMax: number;
      readonly perOrgMax: number;
      /**
       * Durable failed-auth `security_events` write allowance per source IP
       * per window (Sprint 19, ORG-PR-013). Beyond it, failures are
       * log-visible only.
       */
      readonly authFailEventsPerIpMax: number;
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
      // The schema's superRefine already rejected unparseable values, so the
      // fallback to `false` can only ever be dead code defensively kept.
      trustProxy: parseTrustProxy(env.TRUST_PROXY) ?? false,
    },
    security: {
      hstsMaxAgeSeconds: env.HSTS_MAX_AGE_SECONDS,
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
    mail: {
      driver: env.MAIL_DRIVER,
      fromEmail: env.MAIL_FROM_EMAIL,
      fromName: env.MAIL_FROM_NAME,
      timeoutMs: env.MAIL_TIMEOUT_MS,
      // The completeness guard (mail-policy.ts) guarantees these fields exist
      // whenever the smtp driver is selected; other drivers get no smtp block
      // at all, so nothing can accidentally read half-configured credentials.
      smtp:
        env.MAIL_DRIVER === 'smtp'
          ? {
              host: env.SMTP_HOST as string,
              port: env.SMTP_PORT,
              username: env.SMTP_USERNAME as string,
              password: env.SMTP_PASSWORD as string,
            }
          : undefined,
    },
    mailpit: {
      host: env.MAILPIT_HOST,
      smtpPort: env.MAILPIT_SMTP_PORT,
      uiPort: env.MAILPIT_UI_PORT,
    },
    invitations: {
      ttlSeconds: env.INVITATION_TTL_SECONDS,
    },
    emailVerification: {
      ttlSeconds: env.EMAIL_VERIFICATION_TTL_SECONDS,
    },
    passwordRecovery: {
      ttlSeconds: env.PASSWORD_RESET_TTL_SECONDS,
    },
    registration: {
      completionTtlSeconds: env.REGISTRATION_COMPLETION_TTL_SECONDS,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
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
      // Environment-derived default: production fails closed, everything else
      // fails open. An explicit env value wins (the production guard refuses
      // an explicit 'open' under NODE_ENV=production).
      failureMode:
        env.RATE_LIMIT_FAILURE_MODE ??
        (env.NODE_ENV === 'production' ? 'closed' : 'open'),
      auth: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        loginPerIpMax: env.RATE_LIMIT_LOGIN_PER_IP_MAX,
        loginPerEmailMax: env.RATE_LIMIT_LOGIN_PER_EMAIL_MAX,
        refreshPerSessionMax: env.RATE_LIMIT_REFRESH_PER_SESSION_MAX,
        refreshPerIpMax: env.RATE_LIMIT_REFRESH_PER_IP_MAX,
        changePasswordPerUserMax: env.RATE_LIMIT_CHANGE_PASSWORD_PER_USER_MAX,
        changeEmailPerUserMax: env.RATE_LIMIT_CHANGE_EMAIL_PER_USER_MAX,
      },
      registration: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        requestPerIpMax: env.RATE_LIMIT_REGISTER_PER_IP_MAX,
        requestPerEmailMax: env.RATE_LIMIT_REGISTER_PER_EMAIL_MAX,
        completePerIpMax: env.RATE_LIMIT_REGISTRATION_COMPLETE_PER_IP_MAX,
        completePerTokenMax: env.RATE_LIMIT_REGISTRATION_COMPLETE_PER_TOKEN_MAX,
        existingAccountNoticePerEmailMax:
          env.RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX,
      },
      emailVerification: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        requestPerUserMax: env.RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_USER_MAX,
        requestPerIpMax: env.RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_IP_MAX,
        completePerIpMax: env.RATE_LIMIT_EMAIL_VERIFICATION_COMPLETE_PER_IP_MAX,
      },
      passwordRecovery: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        requestPerIpMax: env.RATE_LIMIT_PASSWORD_RECOVERY_REQUEST_PER_IP_MAX,
        requestPerEmailMax:
          env.RATE_LIMIT_PASSWORD_RECOVERY_REQUEST_PER_EMAIL_MAX,
        completePerIpMax: env.RATE_LIMIT_PASSWORD_RECOVERY_COMPLETE_PER_IP_MAX,
        completePerTokenMax:
          env.RATE_LIMIT_PASSWORD_RECOVERY_COMPLETE_PER_TOKEN_MAX,
      },
      invitations: {
        windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
        inspectPerIpMax: env.RATE_LIMIT_INVITATION_INSPECT_PER_IP_MAX,
        inspectPerTokenMax: env.RATE_LIMIT_INVITATION_INSPECT_PER_TOKEN_MAX,
        acceptPerUserMax: env.RATE_LIMIT_INVITATION_ACCEPT_PER_USER_MAX,
        createPerUserMax: env.RATE_LIMIT_INVITATION_CREATE_PER_USER_MAX,
        createPerOrgMax: env.RATE_LIMIT_INVITATION_CREATE_PER_ORG_MAX,
      },
      mutations: {
        windowSeconds: env.RATE_LIMIT_MUTATION_WINDOW_SECONDS,
        orgCreatePerUserMax: env.RATE_LIMIT_ORG_CREATE_PER_USER_MAX,
        projectCreatePerUserMax: env.RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX,
        projectMutationPerUserMax: env.RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX,
        apiKeyCreatePerUserMax: env.RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX,
        planChangePerOrgMax: env.RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX,
        memberMutationPerUserMax: env.RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX,
      },
      auditRead: {
        windowSeconds: env.RATE_LIMIT_AUDIT_READ_WINDOW_SECONDS,
        perUserMax: env.RATE_LIMIT_AUDIT_READ_PER_USER_MAX,
        perOrgMax: env.RATE_LIMIT_AUDIT_READ_PER_ORG_MAX,
      },
      external: {
        windowSeconds: env.RATE_LIMIT_EXTERNAL_WINDOW_SECONDS,
        perKeyMax: env.RATE_LIMIT_EXTERNAL_PER_KEY_MAX,
        perOrgMax: env.RATE_LIMIT_EXTERNAL_PER_ORG_MAX,
        authFailEventsPerIpMax:
          env.RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX,
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
