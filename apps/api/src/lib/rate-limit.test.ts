import type { Clock } from '@orgistry/shared';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryRateLimiter,
  createNoopRateLimiter,
  createRedisRateLimiter,
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
  it('allows up to the limit, then denies within the window', async () => {
    const limiter = createInMemoryRateLimiter(fixedClock(0));
    expect(await limiter.consume('k', 2, 60)).toBe(true);
    expect(await limiter.consume('k', 2, 60)).toBe(true);
    expect(await limiter.consume('k', 2, 60)).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const clock = fixedClock(0);
    const limiter = createInMemoryRateLimiter(clock);
    expect(await limiter.consume('k', 1, 60)).toBe(true);
    expect(await limiter.consume('k', 1, 60)).toBe(false);
    clock.advance(60_000);
    expect(await limiter.consume('k', 1, 60)).toBe(true);
  });

  it('tracks distinct keys independently', async () => {
    const limiter = createInMemoryRateLimiter(fixedClock(0));
    expect(await limiter.consume('a', 1, 60)).toBe(true);
    expect(await limiter.consume('b', 1, 60)).toBe(true);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const limiter = createRedisRateLimiter(redis as any);

    expect(await limiter.consume('k', 2, 60)).toBe(true);
    expect(await limiter.consume('k', 2, 60)).toBe(true);
    expect(await limiter.consume('k', 2, 60)).toBe(false);
    expect(calls).toEqual(['incr', 'expire', 'incr', 'incr']);
  });

  it('fails open when Redis throws (never breaks auth)', async () => {
    const redis = {
      async incr(): Promise<number> {
        throw new Error('redis down');
      },
      async expire() {
        return 1;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const limiter = createRedisRateLimiter(redis as any);
    expect(await limiter.consume('k', 1, 60)).toBe(true);
  });
});

describe('createNoopRateLimiter', () => {
  it('never limits', async () => {
    const limiter = createNoopRateLimiter();
    for (let i = 0; i < 100; i += 1) {
      expect(await limiter.consume('k', 1, 60)).toBe(true);
    }
  });
});
