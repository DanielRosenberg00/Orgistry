import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerTestUser } from '../auth/testing/register-test-user';
import {
  createInMemoryRateLimiter,
  createUnavailableRateLimiter,
  type RateLimiter,
} from '../../lib/rate-limit';
import { hashInvitationToken } from './invitation.token';
import {
  buildInvitationsTestApp,
  type InvitationsTestContext,
} from './testing/build-invitations-test-app';
import type { InvitationRateLimits } from './invitation.service';

/**
 * Invitation abuse controls (Sprint 19, ORG-PR-012).
 *
 * Public inspect is throttled per trusted IP AND per token-derived digest;
 * accept per authenticated user; create per user + per organization. The raw
 * invitation token never enters a limiter key, a log line, or security-event
 * metadata. Thresholds are injected per test — production values are never
 * lowered to make tests pass.
 */

const GENEROUS = Number.MAX_SAFE_INTEGER;

function limitsWith(overrides: Partial<InvitationRateLimits>): InvitationRateLimits {
  return {
    windowSeconds: 60,
    inspectPerIpMax: GENEROUS,
    inspectPerTokenMax: GENEROUS,
    acceptPerUserMax: GENEROUS,
    createPerUserMax: GENEROUS,
    createPerOrgMax: GENEROUS,
    ...overrides,
  };
}

let ctx: InvitationsTestContext | undefined;
let app: FastifyInstance;
let emailSeq = 0;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(options: {
  rateLimiter?: RateLimiter;
  rateLimits?: InvitationRateLimits;
  rateLimitFailureMode?: 'open' | 'closed';
} = {}): Promise<void> {
  ctx = await buildInvitationsTestApp(options);
  app = ctx.app;
}

async function registerUser(): Promise<{ token: string; userId: string; email: string }> {
  emailSeq += 1;
  const email = `throttle.user.${emailSeq}@example.com`;
  const { accessToken, userId } = await registerTestUser(app, ctx!.mailer, {
    email,
    password: 'a-strong-password-123',
    displayName: 'Throttle User',
  });
  return { token: accessToken, userId, email };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createTeamOrg(token: string, name = 'Acme'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: authHeader(token),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.organization.id;
}

/** Create an invitation and recover the raw token from the captured email. */
async function inviteOk(
  token: string,
  organizationId: string,
  email: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/invitations`,
    headers: authHeader(token),
    payload: { email, role: 'member' },
  });
  expect(response.statusCode).toBe(201);
  const rawToken = ctx!.mailer.lastLinkToken();
  expect(rawToken).toBeTruthy();
  return rawToken as string;
}

function inspect(token: string, remoteAddress = '203.0.113.5') {
  return app.inject({
    method: 'POST',
    url: '/v1/invitations/inspect',
    payload: { token },
    remoteAddress,
  });
}

describe('POST /v1/invitations/inspect — throttling', () => {
  it('permits normal inspection under the thresholds and preserves the safe response', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ inspectPerIpMax: 10, inspectPerTokenMax: 5 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    const response = await inspect(rawToken);
    expect(response.statusCode).toBe(200);
    const { invitation } = response.json().data;
    expect(invitation.acceptable).toBe(true);
    expect(invitation.invitedEmail).toBe('invitee@example.com');
    // The response never carries the token or its hash.
    expect(response.body).not.toContain(rawToken);
    expect(response.body).not.toContain(hashInvitationToken(rawToken));
  });

  it('limits repeated inspection from one IP with the standard envelope', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ inspectPerIpMax: 2 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    expect((await inspect(rawToken)).statusCode).toBe(200);
    expect((await inspect(rawToken)).statusCode).toBe(200);
    const third = await inspect(rawToken);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    expect(typeof third.json().error.requestId).toBe('string');
  });

  it('limits repeated inspection of ONE token across distinct source IPs', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ inspectPerTokenMax: 2 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    expect((await inspect(rawToken, '203.0.113.1')).statusCode).toBe(200);
    expect((await inspect(rawToken, '203.0.113.2')).statusCode).toBe(200);
    const third = await inspect(rawToken, '203.0.113.3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });

  it('never puts the raw token (or its storage hash) into a limiter key', async () => {
    const keys: string[] = [];
    const recording: RateLimiter = {
      consume: async (key) => {
        keys.push(key);
        return 'allowed';
      },
    };
    await setup({ rateLimiter: recording, rateLimits: limitsWith({}) });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    await inspect(rawToken);

    const inspectKeys = keys.filter((k) => k.startsWith('rl:invitation:inspect:'));
    expect(inspectKeys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(rawToken);
      expect(key).not.toContain(hashInvitationToken(rawToken));
    }
  });

  it('writes no raw token into security-event metadata during throttled inspection', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ inspectPerIpMax: 1 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    await inspect(rawToken);
    await inspect(rawToken); // 429

    const serializedEvents = JSON.stringify(ctx!.orgStore.securityEvents ?? []);
    expect(serializedEvents).not.toContain(rawToken);
    expect(serializedEvents).not.toContain(hashInvitationToken(rawToken));
  });

  it('fails CLOSED on a limiter-store outage in production-like mode', async () => {
    // The store dies for the INSPECT buckets only, so test setup (create) can
    // still provision the invitation under the same fail-closed policy.
    const inspectStoreDown: RateLimiter = {
      consume: async (key) =>
        key.startsWith('rl:invitation:inspect:') ? 'unavailable' : 'allowed',
    };
    await setup({
      rateLimiter: inspectStoreDown,
      rateLimits: limitsWith({}),
      rateLimitFailureMode: 'closed',
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    const response = await inspect(rawToken);
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    // No store internals leak.
    expect(response.body.toLowerCase()).not.toContain('redis');
  });

  it('fails OPEN on a limiter-store outage in the documented dev/test mode', async () => {
    await setup({
      rateLimiter: createUnavailableRateLimiter(),
      rateLimits: limitsWith({}),
      rateLimitFailureMode: 'open',
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const rawToken = await inviteOk(owner.token, orgId, 'invitee@example.com');

    expect((await inspect(rawToken)).statusCode).toBe(200);
  });

  it('keeps the legitimate inspect → accept flow intact under normal, non-abusive use', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({
        inspectPerIpMax: 10,
        inspectPerTokenMax: 5,
        acceptPerUserMax: 5,
      }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const invitee = await registerUser();
    const rawToken = await inviteOk(owner.token, orgId, invitee.email);

    expect((await inspect(rawToken)).statusCode).toBe(200);

    const accept = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(invitee.token),
      payload: { token: rawToken },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().data.organization.id).toBe(orgId);
  });
});

describe('invitation accept/create — throttling', () => {
  it('limits repeated accept attempts per authenticated user', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ acceptPerUserMax: 2 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);
    const attacker = await registerUser();
    await inviteOk(owner.token, orgId, 'someone-else@example.com');

    // Two guesses consume the bucket (each fails email-match or invalid)…
    for (let i = 0; i < 2; i += 1) {
      const guess = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: authHeader(attacker.token),
        payload: { token: `guessed-token-${i}` },
      });
      expect(guess.statusCode).toBe(404);
    }
    // …the third is throttled before any token lookup.
    const third = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: authHeader(attacker.token),
      payload: { token: 'guessed-token-3' },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });

  it('limits invitation creation per user AFTER the permission check', async () => {
    await setup({
      rateLimiter: createInMemoryRateLimiter(),
      rateLimits: limitsWith({ createPerUserMax: 2 }),
    });
    const owner = await registerUser();
    const orgId = await createTeamOrg(owner.token);

    expect(
      (await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/invitations`,
        headers: authHeader(owner.token),
        payload: { email: 'a@example.com', role: 'member' },
      })).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/invitations`,
        headers: authHeader(owner.token),
        payload: { email: 'b@example.com', role: 'member' },
      })).statusCode,
    ).toBe(201);

    const third = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(owner.token),
      payload: { email: 'c@example.com', role: 'member' },
    });
    expect(third.statusCode).toBe(429);

    // Permission-first preserved: a non-member NEVER sees the limiter — the
    // cross-tenant 404 wins even with an exhausted bucket.
    const outsider = await registerUser();
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: authHeader(outsider.token),
      payload: { email: 'd@example.com', role: 'member' },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
