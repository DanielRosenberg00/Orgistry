import type { FastifyInstance } from 'fastify';

/**
 * API security-header policy (Sprint 19, ORG-PR-011).
 *
 * One `onSend` hook applies a consistent header set to EVERY response —
 * success, error envelope, 404, and CORS preflight alike — so no route can
 * opt out by accident. This is a small internal plugin (not a dependency
 * add): the policy is a fixed header map plus two conditionals, and keeping
 * it in-repo keeps the dependency surface unchanged.
 *
 * Scope honesty: this is an API-response policy. It deliberately does NOT
 * ship a Content-Security-Policy — the SPA is served by its own host and a
 * CSP that actually protects it must be authored and validated against that
 * frontend, not bolted onto JSON responses (a broad CSP here would claim
 * protection it cannot deliver and could break the demo).
 */
export interface SecurityHeadersOptions {
  /**
   * Allow Strict-Transport-Security AT ALL. Enabled only under
   * NODE_ENV=production; the header is then emitted per request only when
   * Fastify's proxy-aware `request.protocol` resolves to `https` (i.e. a real
   * TLS request, or `X-Forwarded-Proto: https` from a TRUSTED proxy hop —
   * never from a forged header on an untrusted connection). Local plain-HTTP
   * development therefore never caches an HSTS policy for localhost.
   */
  enableHsts: boolean;
  /** HSTS max-age in seconds (config: HSTS_MAX_AGE_SECONDS). */
  hstsMaxAgeSeconds: number;
}

/**
 * Path prefixes whose responses carry credentials or account-lifecycle tokens
 * and must never be cached by an intermediary or browser: the auth surface
 * (tokens, cookies, credential mutations) and the invitation token flows.
 */
const NO_STORE_PATH_PREFIXES = ['/v1/auth', '/v1/invitations'] as const;

function isSensitiveAuthPath(url: string): boolean {
  return NO_STORE_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void {
  const hstsValue = `max-age=${options.hstsMaxAgeSeconds}; includeSubDomains`;

  app.addHook('onSend', async (request, reply) => {
    // Baseline for every API response. The API serves JSON, never documents,
    // so framing is denied outright and MIME sniffing is disabled.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    // `same-origin` CORP blocks cross-origin no-cors embedding of responses;
    // the SPA's credentialed fetches use CORS mode and are governed by the
    // explicit CORS allow-list, so this does not affect legitimate clients.
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');

    // `request.protocol` is proxy-aware: it reports `https` only for a real
    // TLS socket or a trusted forwarded hop under the configured TRUST_PROXY.
    // A direct client's forged X-Forwarded-Proto never reaches here.
    if (options.enableHsts && request.protocol === 'https') {
      reply.header('strict-transport-security', hstsValue);
    }

    // Credential/token-bearing surfaces must never be cached. A handler that
    // set its own Cache-Control keeps it (none currently do).
    if (isSensitiveAuthPath(request.url) && !reply.getHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
  });
}
