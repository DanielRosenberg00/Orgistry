/**
 * Runtime public configuration for the web demo (Sprint 26 refinement).
 *
 * WHY THIS EXISTS
 * `VITE_*` values are compiled into the browser bundle at BUILD time. That made
 * the web image environment-specific: promoting one validated web digest from a
 * staging-like environment to production would have required a rebuild, which
 * contradicts the deployment model's central invariant (build once, publish
 * once, promote the same immutable digest — docs/deployment.md).
 *
 * So the browser reads its environment-specific values at RUNTIME instead. The
 * deployed nginx serves a tiny `/public-config.js` that assigns a plain object
 * to `window.__ORGISTRY_PUBLIC_CONFIG__`; that file is rendered from container
 * environment variables when the container starts (apps/web-demo/nginx.conf.template),
 * so the same image serves any environment.
 *
 * PUBLIC MEANS PUBLIC
 * Everything here is delivered to every browser that loads the page. It is
 * configuration, never a credential. `assertNoSecretFields` enforces that
 * actively: a deployment that puts a credential-shaped key into the runtime
 * config fails loudly at page load instead of quietly publishing it.
 *
 * Precedence, highest first:
 *   1. the runtime object       — how a deployed container is configured;
 *   2. `import.meta.env.VITE_*` — how a developer overrides `pnpm dev:web`;
 *   3. the built-in defaults    — a zero-configuration local stack.
 */

/** The global the runtime configuration script assigns to. */
export const PUBLIC_CONFIG_GLOBAL = '__ORGISTRY_PUBLIC_CONFIG__';

/** Every value the browser is allowed to receive at runtime. */
export interface PublicConfig {
  /** Base URL of the Orgistry API, without a trailing slash. */
  apiBaseUrl: string;
  /** Custom header name required on cookie-backed auth mutations. */
  csrfHeaderName: string;
  /** Mailpit web UI, used only by local development guidance in the UI. */
  mailpitUrl: string;
}

/** Defaults matching `.env.example`, so a local stack needs no configuration. */
export const PUBLIC_CONFIG_DEFAULTS: PublicConfig = {
  apiBaseUrl: 'http://localhost:3000',
  csrfHeaderName: 'x-orgistry-csrf',
  mailpitUrl: 'http://localhost:8025',
};

/**
 * Key fragments that mark a field as credential-shaped. Deliberately broad:
 * this list guards a channel whose entire content is public, so a false
 * positive costs a rename while a false negative publishes a secret.
 */
const SECRET_LIKE_KEY_PATTERN =
  /secret|password|passwd|credential|token|private|signing|api[-_]?key/i;

/**
 * Refuse a runtime configuration object that carries a credential-shaped key.
 *
 * Unknown keys are otherwise ignored, so this check runs over EVERY key
 * present rather than only the recognised ones — a stray `jwtSecret` must be
 * loud, not silently dropped.
 */
export function assertNoSecretFields(raw: Record<string, unknown>): void {
  const offending = Object.keys(raw).filter((key) => SECRET_LIKE_KEY_PATTERN.test(key));
  if (offending.length > 0) {
    throw new Error(
      `Runtime public configuration contains credential-shaped field(s): ${offending.join(', ')}. ` +
        'This object is served to every browser; it must never carry a secret.',
    );
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** A usable configuration value is a non-blank string. */
function usable(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pick(
  runtime: Record<string, unknown>,
  buildTime: Record<string, string | undefined>,
  key: keyof PublicConfig,
  buildTimeKey: string,
): string {
  if (usable(runtime[key])) {
    return runtime[key].trim();
  }
  const fromBuild = buildTime[buildTimeKey];
  return usable(fromBuild) ? fromBuild.trim() : PUBLIC_CONFIG_DEFAULTS[key];
}

/**
 * Resolve the effective configuration from the runtime object and the
 * build-time environment. Pure, so both precedence and the secret guard are
 * directly testable without a browser.
 */
export function resolvePublicConfig(
  runtime: Record<string, unknown> | undefined | null,
  buildTime: Record<string, string | undefined> = {},
): PublicConfig {
  const source = runtime ?? {};
  assertNoSecretFields(source);
  return {
    apiBaseUrl: stripTrailingSlash(pick(source, buildTime, 'apiBaseUrl', 'VITE_API_BASE_URL')),
    csrfHeaderName: pick(source, buildTime, 'csrfHeaderName', 'VITE_CSRF_HEADER_NAME'),
    mailpitUrl: stripTrailingSlash(pick(source, buildTime, 'mailpitUrl', 'VITE_MAILPIT_URL')),
  };
}

/** Read the configuration the current page was served with. */
export function readPublicConfig(): PublicConfig {
  const runtime = (globalThis as Record<string, unknown>)[PUBLIC_CONFIG_GLOBAL];
  return resolvePublicConfig(
    typeof runtime === 'object' && runtime !== null ? (runtime as Record<string, unknown>) : null,
    import.meta.env as unknown as Record<string, string | undefined>,
  );
}
