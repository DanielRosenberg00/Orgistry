import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  type AuthTestContext,
  buildAuthTestApp,
} from './testing/build-auth-test-app';

/**
 * End-to-end secure session lifecycle through `app.inject`, backed by the
 * in-memory repository: refresh issuance, the HttpOnly refresh cookie, refresh
 * rotation + reuse detection, logout, CSRF enforcement, and session
 * listing/revocation. DB-backed persistence is covered in the integration
 * suite.
 */

const CREDENTIALS = {
  email: 'Session.User@Example.com',
  password: 'a-strong-password-123',
  displayName: 'Session User',
};

let ctx: AuthTestContext;
let cookieName: string;
let csrfHeader: string;

beforeEach(async () => {
  ctx = await buildAuthTestApp();
  cookieName = ctx.config.auth.refreshCookie.name;
  csrfHeader = ctx.config.auth.csrfHeaderName;
});

afterEach(async () => {
  await ctx.app.close();
});

/* ----------------------------- cookie helpers ---------------------------- */

function setCookieHeader(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw[0] : (raw ?? '');
}

function cookieValue(response: LightMyRequestResponse): string {
  const header = setCookieHeader(response);
  const match = new RegExp(`${cookieName}=([^;]*)`).exec(header);
  return match ? decodeURIComponent(match[1]) : '';
}

function cookieWasCleared(response: LightMyRequestResponse): boolean {
  return /Max-Age=0/.test(setCookieHeader(response));
}

function cookieHeaderFor(token: string): string {
  return `${cookieName}=${encodeURIComponent(token)}`;
}

/* ------------------------------- requests -------------------------------- */

function register(email = CREDENTIALS.email) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { ...CREDENTIALS, email },
  });
}

function login(email = CREDENTIALS.email) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: CREDENTIALS.password },
  });
}

function refresh(token: string, withCsrf = true) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: {
      cookie: cookieHeaderFor(token),
      ...(withCsrf ? { [csrfHeader]: '1' } : {}),
    },
  });
}

function logout(token: string | null, withCsrf = true) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: {
      ...(token ? { cookie: cookieHeaderFor(token) } : {}),
      ...(withCsrf ? { [csrfHeader]: '1' } : {}),
    },
  });
}

/* ----------------------------- 5.1 / 5.2 --------------------------------- */

describe('refresh issuance + cookie', () => {
  it('register sets an HttpOnly, SameSite=Lax, path-scoped refresh cookie', async () => {
    const response = await register();
    const cookie = setCookieHeader(response);

    expect(response.statusCode).toBe(201);
    expect(cookie).toContain(`${cookieName}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/v1/auth');
    expect(cookie).not.toContain('Secure'); // local/test mode
  });

  it('login sets a refresh cookie', async () => {
    await register();
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(setCookieHeader(response)).toContain(`${cookieName}=`);
  });

  it('stores the refresh token hash-only and never returns it in JSON', async () => {
    const response = await register();
    const raw = cookieValue(response);

    expect(raw.length).toBeGreaterThan(20);
    // The raw token never appears in the JSON body.
    expect(JSON.stringify(response.json())).not.toContain(raw);
    // Persistence holds a SHA-256 hash, not the raw token.
    const stored = ctx.repo.refreshTokens[0];
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toBe(raw);
    expect(ctx.repo.refreshTokens.some((t) => t.tokenHash === raw)).toBe(false);
  });
});

/* -------------------------------- 5.3 ------------------------------------ */

describe('refresh rotation', () => {
  it('requires the CSRF header', async () => {
    const raw = cookieValue(await register());
    const response = await refresh(raw, false);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_REQUIRED');
  });

  it('fails (and clears the cookie) when no cookie is present', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { [csrfHeader]: '1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_REFRESH_TOKEN');
    expect(cookieWasCleared(response)).toBe(true);
  });

  it('fails for an unknown token', async () => {
    await register();
    const response = await refresh('not-a-real-token');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('fails for an expired token', async () => {
    const raw = cookieValue(await register());
    ctx.repo.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);
    const response = await refresh(raw);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rotates a valid token: new access token + new cookie, old token consumed', async () => {
    const raw = cookieValue(await register());
    const original = ctx.repo.refreshTokens[0];

    const response = await refresh(raw);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.tokens.accessToken).toBeTypeOf('string');
    expect(body.data.tokens.tokenType).toBe('Bearer');

    // A new cookie was issued and differs from the presented token.
    const rotated = cookieValue(response);
    expect(rotated.length).toBeGreaterThan(20);
    expect(rotated).not.toBe(raw);
    // The raw rotated token never appears in JSON.
    expect(JSON.stringify(body)).not.toContain(rotated);

    // The presented token is marked used + linked to its replacement.
    expect(original.usedAt).not.toBeNull();
    expect(original.replacementTokenId).not.toBeNull();
    // Exactly one successor was minted in the same family.
    expect(ctx.repo.refreshTokens).toHaveLength(2);
    expect(ctx.repo.refreshTokens[1].familyId).toBe(original.familyId);
  });

  it('writes a refresh_token_rotated security event on success', async () => {
    const raw = cookieValue(await register());
    await refresh(raw);
    const event = ctx.repo.securityEvents.find(
      (e) => e.eventType === 'auth.refresh_token_rotated',
    );
    expect(event).toBeDefined();
    expect(event?.sessionId).toBe(ctx.repo.sessions[0].id);
    expect(event?.userId).toBe(ctx.repo.users[0].id);
  });

  it('does not let concurrent refreshes mint two valid successors', async () => {
    const raw = cookieValue(await register());

    const [a, b] = await Promise.all([refresh(raw), refresh(raw)]);
    const codes = [a.statusCode, b.statusCode].sort();

    // Exactly one succeeds; the loser is treated as reuse.
    expect(codes).toEqual([200, 401]);
    // Only one successor token was created (original + one successor).
    expect(ctx.repo.refreshTokens).toHaveLength(2);
  });
});

/* -------------------------------- 5.4 ------------------------------------ */

describe('refresh token reuse detection', () => {
  it('revokes the family + session, clears the cookie, and issues no access token', async () => {
    const raw = cookieValue(await register());
    const familyId = ctx.repo.refreshTokens[0].familyId;
    const sessionId = ctx.repo.sessions[0].id;

    // First rotation consumes the original token.
    await refresh(raw);
    // Presenting the now-used original token again => reuse.
    const reuse = await refresh(raw);

    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('TOKEN_REUSE_DETECTED');
    expect(reuse.json()).not.toHaveProperty('data');
    expect(cookieWasCleared(reuse)).toBe(true);

    // The session is revoked and every token in the family is revoked.
    expect(
      ctx.repo.sessions.find((s) => s.id === sessionId)?.revokedAt,
    ).not.toBeNull();
    const familyTokens = ctx.repo.refreshTokens.filter(
      (t) => t.familyId === familyId,
    );
    expect(familyTokens.length).toBeGreaterThanOrEqual(2);
    expect(familyTokens.every((t) => t.revokedAt !== null)).toBe(true);

    // A reuse event was written.
    expect(
      ctx.repo.securityEvents.some(
        (e) => e.eventType === 'auth.refresh_token_reuse_detected',
      ),
    ).toBe(true);
  });
});

/* -------------------------------- 5.5 ------------------------------------ */

describe('logout', () => {
  it('revokes server-side state, clears the cookie, and writes an event', async () => {
    const raw = cookieValue(await register());
    const sessionId = ctx.repo.sessions[0].id;

    const response = await logout(raw);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.success).toBe(true);
    expect(cookieWasCleared(response)).toBe(true);

    expect(
      ctx.repo.sessions.find((s) => s.id === sessionId)?.revokedAt,
    ).not.toBeNull();
    expect(
      ctx.repo.refreshTokens
        .filter((t) => t.sessionId === sessionId)
        .every((t) => t.revokedAt !== null),
    ).toBe(true);
    expect(
      ctx.repo.securityEvents.some(
        (e) => e.eventType === 'auth.logout_succeeded',
      ),
    ).toBe(true);
  });

  it('requires the CSRF header', async () => {
    const raw = cookieValue(await register());
    const response = await logout(raw, false);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_REQUIRED');
  });

  it('is safe to call repeatedly', async () => {
    const raw = cookieValue(await register());
    await logout(raw);
    const second = await logout(null); // cookie already cleared client-side
    expect(second.statusCode).toBe(200);
    expect(second.json().data.success).toBe(true);
  });

  it('makes a subsequent refresh fail', async () => {
    const raw = cookieValue(await register());
    await logout(raw);
    const response = await refresh(raw);
    expect(response.statusCode).toBe(401);
    expect(cookieWasCleared(response)).toBe(true);
  });
});

/* -------------------------------- 5.6 ------------------------------------ */

describe('session list', () => {
  function accessToken(response: LightMyRequestResponse): string {
    return response.json().data.tokens.accessToken;
  }

  it('requires a Bearer token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('is scoped to the authenticated user and marks the current session', async () => {
    const first = await register();
    const second = await login(); // second session for the same user
    await register('other.person@example.com'); // a different user

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${accessToken(second)}` },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // Only this user's two sessions, not the other user's.
    expect(body.data.items).toHaveLength(2);
    const currentCount = body.data.items.filter(
      (s: { current: boolean }) => s.current,
    ).length;
    expect(currentCount).toBe(1);
    void first;
  });

  it('does not expose token hashes or family internals', async () => {
    const response = await register();
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${accessToken(response)}` },
    });
    const raw = JSON.stringify(list.json());
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain('familyId');
    expect(raw).not.toContain('passwordHash');

    const item = list.json().data.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'createdAt',
        'current',
        'expiresAt',
        'id',
        'ipAddress',
        'updatedAt',
        'userAgent',
      ].sort(),
    );
  });
});

/* -------------------------------- 5.7 ------------------------------------ */

describe('session revocation', () => {
  function accessToken(response: LightMyRequestResponse): string {
    return response.json().data.tokens.accessToken;
  }

  it('requires a Bearer token', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/auth/sessions/sess_whatever',
    });
    expect(response.statusCode).toBe(401);
  });

  it('lets a user revoke their own session and revokes its refresh tokens', async () => {
    const reg = await register();
    const sessionId = ctx.repo.sessions[0].id;

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${accessToken(reg)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.success).toBe(true);
    expect(
      ctx.repo.sessions.find((s) => s.id === sessionId)?.revokedAt,
    ).not.toBeNull();
    expect(
      ctx.repo.refreshTokens
        .filter((t) => t.sessionId === sessionId)
        .every((t) => t.revokedAt !== null),
    ).toBe(true);
    // Revoking the current session clears the refresh cookie.
    expect(cookieWasCleared(response)).toBe(true);
    expect(
      ctx.repo.securityEvents.some(
        (e) => e.eventType === 'auth.session_revoked',
      ),
    ).toBe(true);
  });

  it("cannot revoke another user's session", async () => {
    await register(); // user A -> sessions[0]
    const other = await register('other.person@example.com'); // user B

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${ctx.repo.sessions[0].id}`,
      headers: { authorization: `Bearer ${accessToken(other)}` },
    });

    // 404 (not 403) so other users' session ids cannot be probed.
    expect(response.statusCode).toBe(404);
    expect(ctx.repo.sessions[0].revokedAt).toBeNull();
  });

  it('makes refresh fail after the session is revoked', async () => {
    const reg = await register();
    const raw = cookieValue(reg);
    const sessionId = ctx.repo.sessions[0].id;

    await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${accessToken(reg)}` },
    });

    const response = await refresh(raw);
    expect(response.statusCode).toBe(401);
  });

  it('is idempotent for an already-revoked (non-current) session', async () => {
    await register(); // session 0
    const second = await login(); // session 1 — its token stays valid
    const targetId = ctx.repo.sessions[0].id; // revoke the OTHER session twice
    const token = accessToken(second);

    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
  });
});
