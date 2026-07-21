import type { Redis } from 'ioredis';
import { createRedisRateLimiter, type RateLimiter } from './lib/rate-limit';

/**
 * The production composition's rate-limiter seam (Sprint 19 refinement).
 *
 * `server.ts` builds exactly ONE limiter through this factory and hands the
 * SAME instance to every consumer: the services' sensitive buckets AND
 * `buildApp`'s `globalRateLimiter`. Extracting the construction here makes
 * the production wiring unit-testable without opening listeners or real
 * clients: the returned limiter is provably the Redis-backed implementation
 * (it drives the provided client's INCR/EXPIRE and reports store failures as
 * `'unavailable'`), and store errors reach the logger only after `bindLogger`
 * — the app logger does not exist yet when the limiter is constructed.
 */
export interface ServerRateLimiter {
  /** The Redis-backed limiter shared by the global bucket and every service. */
  limiter: RateLimiter;
  /**
   * Bind the (sanitized) warn sink once the app exists. Store failures
   * before binding are silently tolerated — the process is still composing
   * and readiness will surface the outage.
   */
  bindLogger(log: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  }): void;
}

export function createServerRateLimiter(redis: Redis): ServerRateLimiter {
  const sink: {
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  } = {};

  const limiter = createRedisRateLimiter(redis, {
    onStoreError: (error) => {
      // Sanitized: component tag + error object for server logs; never key
      // material or Redis commands.
      sink.warn?.(
        { component: 'rate-limit-store', err: error },
        'Rate-limit store unavailable',
      );
    },
  });

  return {
    limiter,
    bindLogger(log) {
      sink.warn = (obj, msg) => log.warn(obj, msg);
    },
  };
}
