import type { Redis } from 'ioredis';
import { type Clock, systemClock } from '@orgistry/shared';
import { rateLimitStoreUnavailableError } from './errors';

/**
 * Fixed-window rate limiting (store contract reworked in Sprint 19,
 * ORG-PR-009).
 *
 * The limiter answers one question — "is this key still under its limit for
 * the current window?" — and now reports store trouble EXPLICITLY instead of
 * silently allowing the request:
 *
 *   'allowed'     — under the limit; proceed.
 *   'limited'     — over the limit; the caller rejects with RATE_LIMITED.
 *   'unavailable' — the backing store could not answer. The caller decides
 *                   via the configured failure mode (`config.rateLimit
 *                   .failureMode`): development/test fail OPEN for local
 *                   usability; production fails CLOSED for sensitive buckets
 *                   (503 SERVICE_UNAVAILABLE via
 *                   {@link enforceStoreAvailability}).
 *
 * Store availability is separate from runtime readiness: Redis remains a
 * required dependency of the `/ready` probe (see `server.ts`), so a Redis
 * outage still takes a production instance out of rotation there. Fail-closed
 * handler behavior is the belt to readiness' suspenders, not a replacement
 * for monitoring (which remains out of scope — see the findings register).
 */

export type RateLimitDecision = 'allowed' | 'limited' | 'unavailable';

/** What sensitive limiters do when the store cannot answer. */
export type RateLimitFailureMode = 'open' | 'closed';

export interface RateLimiter {
  /**
   * Record one hit against `key` and report the decision. `limit` is the
   * maximum hits permitted within `windowSeconds`. Never throws — store
   * failures surface as `'unavailable'`.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision>;
}

/**
 * Apply the configured failure mode to a limiter decision, collapsing
 * `'unavailable'` into either an allow (fail open) or a thrown 503 (fail
 * closed). Returns `true` when the request may proceed and `false` when the
 * limit was exceeded — callers keep ownership of their RATE_LIMITED error and
 * any security-event write.
 *
 * The thrown 503 is the standard envelope with a generic message: no Redis
 * host, command, exception text, or key material ever reaches the client.
 */
export function enforceStoreAvailability(
  decision: RateLimitDecision,
  failureMode: RateLimitFailureMode,
): boolean {
  if (decision === 'unavailable') {
    if (failureMode === 'closed') {
      throw rateLimitStoreUnavailableError();
    }
    return true;
  }
  return decision === 'allowed';
}

/**
 * Redis-backed fixed-window limiter — the official v1 store.
 *
 * `INCR` returns the post-increment count; the first hit in a window also sets
 * the key's TTL so the window expires on its own. A Redis error yields ONE
 * `'unavailable'` decision (no in-call retries — ioredis is configured with
 * `maxRetriesPerRequest: 1`, so a dead store cannot trigger a retry storm) and
 * is reported through `onStoreError` for sanitized server-side logging.
 */
export function createRedisRateLimiter(
  redis: Redis,
  options: {
    /** Invoked once per failed consume for safe structured logging. */
    onStoreError?: (error: unknown) => void;
  } = {},
): RateLimiter {
  return {
    async consume(key, limit, windowSeconds) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, windowSeconds);
        }
        return count <= limit ? 'allowed' : 'limited';
      } catch (error) {
        options.onStoreError?.(error);
        return 'unavailable';
      }
    },
  };
}

/**
 * In-memory fixed-window limiter for tests and limiter-free contexts. Not for
 * multi-process production use — counts are per-process.
 */
export function createInMemoryRateLimiter(
  clock: Clock = systemClock,
): RateLimiter {
  const windows = new Map<string, { count: number; resetAtMs: number }>();
  return {
    async consume(key, limit, windowSeconds) {
      const now = clock.epochMillis();
      const existing = windows.get(key);
      if (!existing || existing.resetAtMs <= now) {
        windows.set(key, { count: 1, resetAtMs: now + windowSeconds * 1000 });
        return 1 <= limit ? 'allowed' : 'limited';
      }
      existing.count += 1;
      return existing.count <= limit ? 'allowed' : 'limited';
    },
  };
}

/**
 * A limiter that never limits. Used as the default when no limiter is wired in
 * (e.g. unit tests not exercising rate limiting) so behavior is unchanged.
 */
export function createNoopRateLimiter(): RateLimiter {
  return { consume: async () => 'allowed' };
}

/**
 * A limiter whose store is permanently unreachable. Test-only: exercises the
 * fail-open/fail-closed policy without a real Redis outage.
 */
export function createUnavailableRateLimiter(): RateLimiter {
  return { consume: async () => 'unavailable' };
}
