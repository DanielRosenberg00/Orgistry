import { describe, expect, it } from 'vitest';
import type { Clock } from '@orgistry/shared';
import { AppError } from '../../lib/errors';
import {
  createInMemoryRateLimiter,
  createUnavailableRateLimiter,
  type RateLimiter,
} from '../../lib/rate-limit';
import { createInMemoryOrgStore } from '../organization/testing/in-memory-org-store';
import { createApiKeyAuthenticator } from './api-key.authenticator';
import { createInMemoryApiKeyRepository } from './testing/in-memory-api-key-repo';
import type { ApiKeyRequestContext } from './api-key.types';

/**
 * Failed-auth write/log bounding at the authenticator seam (Sprint 19
 * refinement, ORG-PR-013).
 *
 * Proves the two amplification bounds directly:
 *  - durable `security_events` writes stay within the allowance even when the
 *    request carries NO resolved client IP (the coarse internal `unknown`
 *    bucket — a missing IP must never mean "write every event");
 *  - the suppression WARNING itself is bounded to one line per window per
 *    process, so a storm cannot trade database amplification for log
 *    amplification — including during a limiter-store outage.
 * The uniform 401 contract holds in every case.
 */

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

const NEVER_REACHED = {
  organizations: {
    findOrganizationById: async () => {
      throw new Error('invalid credentials must never reach the org lookup');
    },
  },
  entitlements: {
    resolveApiKeyEntitlements: async () => {
      throw new Error('invalid credentials must never reach entitlements');
    },
  },
};

function setup(options: {
  rateLimiter: RateLimiter;
  allowance?: number;
  clock?: Clock;
}) {
  const store = createInMemoryOrgStore();
  const authenticator = createApiKeyAuthenticator({
    apiKeys: createInMemoryApiKeyRepository(store),
    organizations: NEVER_REACHED.organizations,
    entitlements: NEVER_REACHED.entitlements,
    rateLimiter: options.rateLimiter,
    rateLimits: {
      windowSeconds: 60,
      perKeyMax: Number.MAX_SAFE_INTEGER,
      perOrgMax: Number.MAX_SAFE_INTEGER,
      authFailEventsPerIpMax: options.allowance ?? 2,
    },
    lastUsedThrottleSeconds: 60,
    clock: options.clock,
  });
  return { store, authenticator };
}

async function expectUnauthorized(
  authenticate: () => Promise<unknown>,
): Promise<void> {
  let thrown: unknown;
  try {
    await authenticate();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).statusCode).toBe(401);
}

describe('failed-auth durable-write bounding with a missing client IP', () => {
  it('bounds the burst through the coarse unknown bucket instead of writing every row', async () => {
    const { store, authenticator } = setup({
      rateLimiter: createInMemoryRateLimiter(),
      allowance: 2,
    });
    const ctx: ApiKeyRequestContext = {
      requestId: 'req_null_ip_burst',
      ipAddress: null,
      userAgent: null,
    };

    for (let i = 0; i < 10; i += 1) {
      await expectUnauthorized(() =>
        authenticator.authenticate('garbage-credential', ctx, 'projects:read'),
      );
    }

    // Exactly the allowance, never one row per request.
    expect(store.securityEvents).toHaveLength(2);
    const serialized = JSON.stringify(store.securityEvents);
    expect(serialized).not.toContain('garbage-credential');
  });
});

describe('suppression-log bounding', () => {
  it('logs the FIRST suppression once — with the clock starting at exactly epoch 0 — then one more after the window rolls', async () => {
    // Epoch 0 is the regression case: a numeric-zero "last logged" sentinel
    // would treat the first suppression as already logged and stay silent.
    const clock = fixedClock(0);
    const logged: Array<Record<string, unknown>> = [];
    const { store, authenticator } = setup({
      rateLimiter: createInMemoryRateLimiter(clock),
      allowance: 1,
      clock,
    });
    const ctx: ApiKeyRequestContext = {
      requestId: 'req_log_bound',
      ipAddress: '198.51.100.9',
      userAgent: null,
      log: (data) => {
        logged.push(data);
      },
    };

    for (let i = 0; i < 20; i += 1) {
      await expectUnauthorized(() =>
        authenticator.authenticate('bad-credential-value', ctx, 'projects:read'),
      );
    }
    // One durable row (the allowance), ONE warn for the other 19 requests.
    expect(store.securityEvents).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      component: 'api_key_auth',
      eventWriteSuppressed: true,
      reason: 'allowance_exceeded',
    });
    expect(JSON.stringify(logged)).not.toContain('bad-credential-value');

    // Next window: the in-memory bucket resets (one more durable write) and
    // the log gate re-opens (at most one more line).
    clock.advance(61_000);
    for (let i = 0; i < 10; i += 1) {
      await expectUnauthorized(() =>
        authenticator.authenticate('bad-credential-value', ctx, 'projects:read'),
      );
    }
    expect(store.securityEvents).toHaveLength(2);
    expect(logged).toHaveLength(2);
  });

  it('stays bounded during a limiter-store outage: no durable writes, one log line per window', async () => {
    const clock = fixedClock(2_000_000);
    const logged: Array<Record<string, unknown>> = [];
    const { store, authenticator } = setup({
      rateLimiter: createUnavailableRateLimiter(),
      clock,
    });
    const ctx: ApiKeyRequestContext = {
      requestId: 'req_outage_bound',
      ipAddress: '198.51.100.10',
      userAgent: null,
      log: (data) => {
        logged.push(data);
      },
    };

    for (let i = 0; i < 15; i += 1) {
      // Invalid credentials remain 401 during the outage — the failed-auth
      // path never converts a store failure into acceptance OR into a 503.
      await expectUnauthorized(() =>
        authenticator.authenticate('bad-credential-value', ctx, 'projects:read'),
      );
    }

    expect(store.securityEvents).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ reason: 'store_unavailable' });
  });
});
