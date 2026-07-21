import type { Clock } from '@orgistry/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import {
  createInMemoryRateLimiter,
  createNoopRateLimiter,
  createRedisRateLimiter,
  createUnavailableRateLimiter,
  enforceStoreAvailability,
} from './rate-limit';

/** A clock whose time advances only when the test moves it. */
function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    epochMillis: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe('createInMemoryRateLimiter', () => {
  it('allows up to the limit, then limits within the window', async () => {
    const limiter = createInMemoryRateLimiter(fixedClock(0));
    expect(await limiter.consume('k', 2, 60)).toBe('allowed');
    expect(await limiter.consume('k', 2, 60)).toBe('allowed');
    expect(await limiter.consume('k', 2, 60)).toBe('limited');
  });

  it('resets after the window elapses', async () => {
    const clock = fixedClock(0);
    const limiter = createInMemoryRateLimiter(clock);
    expect(await limiter.consume('k', 1, 60)).toBe('allowed');
    expect(await limiter.consume('k', 1, 60)).toBe('limited');
    clock.advance(60_000);
    expect(await limiter.consume('k', 1, 60)).toBe('allowed');
  });

  it('tracks distinct keys independently', async () => {
    const limiter = createInMemoryRateLimiter(fixedClock(0));
    expect(await limiter.consume('a', 1, 60)).toBe('allowed');
    expect(await limiter.consume('b', 1, 60)).toBe('allowed');
  });
});

describe('createRedisRateLimiter', () => {
  it('sets a TTL only on the first hit of a window', async () => {
    const calls: string[] = [];
    let count = 0;
    const redis = {
      async incr() {
        count += 1;
        calls.push('incr');
        return count;
      },
      async expire() {
        calls.push('expire');
        return 1;
      },
    };
    const limiter = createRedisRateLimiter(redis as any);

    expect(await limiter.consume('k', 2, 60)).toBe('allowed');
    expect(await limiter.consume('k', 2, 60)).toBe('allowed');
    expect(await limiter.consume('k', 2, 60)).toBe('limited');
    expect(calls).toEqual(['incr', 'expire', 'incr', 'incr']);
  });

  it('reports an unreachable store as unavailable and notifies the observer', async () => {
    const observed: unknown[] = [];
    const redis = {
      async incr(): Promise<number> {
        throw new Error('redis down');
      },
      async expire() {
        return 1;
      },
    };
    const limiter = createRedisRateLimiter(redis as any, {
      onStoreError: (error) => observed.push(error),
    });
    expect(await limiter.consume('k', 1, 60)).toBe('unavailable');
    expect(observed).toHaveLength(1);
  });
});

describe('createNoopRateLimiter', () => {
  it('never limits', async () => {
    const limiter = createNoopRateLimiter();
    for (let i = 0; i < 100; i += 1) {
      expect(await limiter.consume('k', 1, 60)).toBe('allowed');
    }
  });
});

describe('enforceStoreAvailability', () => {
  it('passes through allowed and limited decisions unchanged', () => {
    expect(enforceStoreAvailability('allowed', 'open')).toBe(true);
    expect(enforceStoreAvailability('allowed', 'closed')).toBe(true);
    expect(enforceStoreAvailability('limited', 'open')).toBe(false);
    expect(enforceStoreAvailability('limited', 'closed')).toBe(false);
  });

  it('fails open on an unavailable store when the mode is open', () => {
    expect(enforceStoreAvailability('unavailable', 'open')).toBe(true);
  });

  it('fails closed with a generic 503 when the mode is closed', () => {
    let thrown: unknown;
    try {
      enforceStoreAvailability('unavailable', 'closed');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.statusCode).toBe(503);
    expect(appError.code).toBe('SERVICE_UNAVAILABLE');
    // No store internals in the public message.
    expect(appError.message.toLowerCase()).not.toContain('redis');
  });

  it('is exercised end to end by the unavailable test limiter', async () => {
    const limiter = createUnavailableRateLimiter();
    expect(await limiter.consume('k', 1, 60)).toBe('unavailable');
  });
});
