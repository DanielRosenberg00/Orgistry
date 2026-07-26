import type { FastifyInstance } from 'fastify';
import { rateLimitedError } from '../lib/errors';
import type { RateLimiter } from '../lib/rate-limit';

/**
 * Global API rate limit (Sprint 19, ORG-PR-012) — the baseline edge abuse
 * boundary. One fixed-window bucket per TRUSTED client IP (`request.ip`, which
 * honors the configured proxy trust and nothing else) evaluated in `onRequest`,
 * before body parsing, authentication, and route-specific work. It complements
 * — never replaces — the stricter per-endpoint buckets.
 *
 * Exemptions, by design:
 *  - `/health` and `/ready`: operators and orchestrators poll these; limiting
 *    them turns an abuse control into a self-inflicted outage signal.
 *  - `OPTIONS` (CORS preflight): the browser controls preflight cadence, and a
 *    limited preflight would surface as an opaque CORS failure rather than the
 *    standard envelope.
 *
 * Failure mode: the GLOBAL bucket fails OPEN on a limiter-store outage
 * regardless of `RATE_LIMIT_FAILURE_MODE`. Rationale: readiness already
 * reports the instance not-ready (taking it out of rotation in production),
 * every sensitive endpoint keeps its own fail-closed bucket, and failing the
 * whole API closed would convert a Redis blip into a total outage. The outage
 * is logged (sanitized — no store details, no key material) so it is
 * observable server-side.
 */
export interface GlobalRateLimitOptions {
  limiter: RateLimiter;
  maxPerIp: number;
  windowSeconds: number;
}

const EXEMPT_PATHS = new Set(['/health', '/ready']);

export function registerGlobalRateLimit(
  app: FastifyInstance,
  options: GlobalRateLimitOptions,
): void {
  const { limiter, maxPerIp, windowSeconds } = options;

  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') {
      return;
    }
    // Compare the path only (readiness probes may carry query strings).
    // `split` always yields at least one element; the fallback is for the
    // type system only.
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (EXEMPT_PATHS.has(path)) {
      return;
    }

    const decision = await limiter.consume(
      `rl:global:ip:${request.ip}`,
      maxPerIp,
      windowSeconds,
    );
    if (decision === 'limited') {
      // The internal distinction (global vs route bucket) stays in the log;
      // the client sees only the standard RATE_LIMITED envelope.
      request.log.info({ bucket: 'global_per_ip' }, 'Global rate limit exceeded');
      throw rateLimitedError();
    }
    if (decision === 'unavailable') {
      request.log.warn(
        { bucket: 'global_per_ip', failureMode: 'open' },
        'Rate-limit store unavailable; global limiter failing open',
      );
    }
  });
}
