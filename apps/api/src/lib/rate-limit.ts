import type { Redis } from 'ioredis';
import { type Clock, systemClock } from '@orgistry/shared';

/**
 * Fixed-window rate limiting.
 *
 * The limiter answers one question: "is this key still under its limit for the
 * current window?" It is INTENTIONALLY decoupled from authentication
 * correctness — a limiter that cannot reach its backing store FAILS OPEN
 * (allows the request). A Redis outage may therefore disable rate limiting, but
 * it can never reject a valid credential or accept an invalid one; PostgreSQL
 * and the token tables remain the sole source of auth truth.
 *
 * This fail-open behavior is scoped to AUTH HANDLERS only. It is separate from
 * runtime readiness: Redis remains a required dependency of the `/ready` probe
 * (see `server.ts`), so a Redis outage still surfaces as unhealthy there.
 * "Fails open in handlers" does not mean "Redis is optional for readiness."
 */
export interface RateLimiter {
  /**
   * Record one hit against `key` and report whether it is still allowed.
   * `limit` is the maximum hits permitted within `windowSeconds`.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean>;
}

/**
 * Redis-backed fixed-window limiter — the official v1 store.
 *
 * `INCR` returns the post-increment count; the first hit in a window also sets
 * the key's TTL so the window expires on its own. Any Redis error is swallowed
 * and the request is allowed (fail-open, see the interface contract).
 */
export function createRedisRateLimiter(redis: Redis): RateLimiter {
  return {
    async consume(key, limit, windowSeconds) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, windowSeconds);
        }
        return count <= limit;
      } catch {
        // Fail open: rate limiting must never break auth on a Redis outage.
        return true;
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
        return 1 <= limit;
      }
      existing.count += 1;
      return existing.count <= limit;
    },
  };
}

/**
 * A limiter that never limits. Used as the default when no limiter is wired in
 * (e.g. unit tests not exercising rate limiting) so behavior is unchanged.
 */
export function createNoopRateLimiter(): RateLimiter {
  return { consume: async () => true };
}
