import { describe, expect, it } from 'vitest';
import { createServerRateLimiter } from './server-rate-limiter';

/**
 * Production composition evidence (Sprint 19 refinement): the limiter the
 * server composition builds — the one instance `server.ts` hands BOTH to
 * `buildApp` as `globalRateLimiter` and to every service bucket — is the
 * Redis-backed implementation, not a noop or a double. Proven by driving the
 * factory with a stub client and observing the Redis command protocol
 * (INCR + first-hit EXPIRE) and the `'unavailable'` store-failure decision.
 * The final hand-off line in `server.ts` itself is covered by the buildApp
 * production non-null invariant plus review (see the Sprint 19 artifact).
 */
describe('createServerRateLimiter', () => {
  function stubRedis() {
    const commands: string[] = [];
    let count = 0;
    return {
      commands,
      client: {
        async incr() {
          count += 1;
          commands.push('incr');
          return count;
        },
        async expire() {
          commands.push('expire');
          return 1;
        },
      },
    };
  }

  it('produces a limiter that drives the provided Redis client', async () => {
    const { commands, client } = stubRedis();
    const { limiter } = createServerRateLimiter(client as never);

    expect(await limiter.consume('rl:global:ip:198.51.100.7', 2, 60)).toBe('allowed');
    expect(await limiter.consume('rl:global:ip:198.51.100.7', 2, 60)).toBe('allowed');
    expect(await limiter.consume('rl:global:ip:198.51.100.7', 2, 60)).toBe('limited');
    // Redis-backed fixed-window protocol: INCR each hit, EXPIRE on the first.
    expect(commands).toEqual(['incr', 'expire', 'incr', 'incr']);
  });

  it('reports store failures as unavailable, logging only after the app logger is bound', async () => {
    const failing = {
      async incr(): Promise<number> {
        throw new Error('stream broken');
      },
      async expire() {
        return 1;
      },
    };
    const logged: Array<Record<string, unknown>> = [];
    const server = createServerRateLimiter(failing as never);

    // Before binding (the composition window before buildApp): tolerated,
    // decision still explicit.
    expect(await server.limiter.consume('k', 1, 60)).toBe('unavailable');
    expect(logged).toHaveLength(0);

    server.bindLogger({ warn: (obj) => logged.push(obj) });
    expect(await server.limiter.consume('k', 1, 60)).toBe('unavailable');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ component: 'rate-limit-store' });
  });
});
