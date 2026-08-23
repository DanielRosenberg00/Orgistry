import { signAccessToken, verifyAccessToken } from '@orgistry/auth-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  type AuthTestContext,
} from './testing/build-auth-test-app';
import { registerTestUser } from './testing/register-test-user';

/**
 * Access-token secret rotation, exercised through the real HTTP boundary
 * (Sprint 24, ORG-PR-006).
 *
 * The operator sequence being modelled (docs/rotation-runbook.md — "Rotate the
 * access-token signing secret"): the freshly generated secret becomes
 * `JWT_SECRET`, the outgoing one becomes `JWT_PREVIOUS_SECRET`, and the
 * process restarts. During that window BOTH keys must authenticate; once the
 * previous key is removed, only the current one may. Every secret below is a
 * public test fixture.
 */

const ACCOUNT = {
  email: 'rotation.user@example.com',
  password: 'a-strong-password-123',
  displayName: 'Rotation User',
};

/** The key retired by the rotation under test. */
const RETIRING_SECRET = 'test-suite-jwt-secret-RETIRING-not-real';
/** A key retired in an EARLIER rotation — it must never be accepted again. */
const ABANDONED_SECRET = 'test-suite-jwt-secret-ABANDONED-not-real';

let ctx: AuthTestContext;

afterEach(async () => {
  await ctx.app.close();
});

function getMe(token: string) {
  return ctx.app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Create a real account, then re-sign an equivalent access token for its live
 * session with `secret` — the shape of a token issued before a rotation.
 */
async function tokenSignedWith(
  secret: string,
  ttlSeconds = 900,
): Promise<{ currentKeyToken: string; reSignedToken: string }> {
  const session = await registerTestUser(ctx.app, ctx.mailer, ACCOUNT);
  const claims = await verifyAccessToken(
    session.accessToken,
    ctx.config.auth.jwtSecret,
  );
  const reSignedToken = await signAccessToken({
    userId: claims.sub,
    sessionId: claims.sessionId,
    secret,
    ttlSeconds,
  });
  return { currentKeyToken: session.accessToken, reSignedToken };
}

describe('JWT secret rotation window', () => {
  it('accepts tokens from both keys while the previous key is configured', async () => {
    // `previousJwtSecret` is what `JWT_PREVIOUS_SECRET` becomes at boot.
    ctx = await buildAuthTestApp({ previousJwtSecret: RETIRING_SECRET });
    const { currentKeyToken, reSignedToken } =
      await tokenSignedWith(RETIRING_SECRET);

    // Newly issued tokens are signed with the CURRENT secret only…
    const currentKeyResponse = await getMe(currentKeyToken);
    expect(currentKeyResponse.statusCode).toBe(200);
    expect(currentKeyResponse.json().data.user.email).toBe(ACCOUNT.email);

    // …and a token minted before the rotation still authenticates.
    const previousKeyResponse = await getMe(reSignedToken);
    expect(previousKeyResponse.statusCode).toBe(200);
    expect(previousKeyResponse.json().data.user.email).toBe(ACCOUNT.email);
  });

  it('rejects a token signed with an unrelated older key', async () => {
    ctx = await buildAuthTestApp({ previousJwtSecret: RETIRING_SECRET });
    const { reSignedToken } = await tokenSignedWith(ABANDONED_SECRET);

    const response = await getMe(reSignedToken);

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects previous-key tokens once the rotation is completed', async () => {
    // The state after the operator removes `JWT_PREVIOUS_SECRET` and restarts.
    ctx = await buildAuthTestApp();
    const { currentKeyToken, reSignedToken } =
      await tokenSignedWith(RETIRING_SECRET);

    expect((await getMe(reSignedToken)).statusCode).toBe(401);
    // The current key keeps working: cutover invalidates only old tokens.
    expect((await getMe(currentKeyToken)).statusCode).toBe(200);
  });

  it('still rejects an expired previous-key token', async () => {
    ctx = await buildAuthTestApp({ previousJwtSecret: RETIRING_SECRET });
    const { reSignedToken } = await tokenSignedWith(RETIRING_SECRET, -10);

    // The rotation window widens WHICH key may sign, never HOW LONG a token
    // lives: expiry is unchanged for both keys.
    expect((await getMe(reSignedToken)).statusCode).toBe(401);
  });

  it('never echoes either signing secret in a rejection envelope', async () => {
    ctx = await buildAuthTestApp({ previousJwtSecret: RETIRING_SECRET });

    const response = await getMe('not.a.jwt');
    const raw = JSON.stringify(response.json());

    expect(response.statusCode).toBe(401);
    expect(raw).not.toContain(RETIRING_SECRET);
    expect(raw).not.toContain(ctx.config.auth.jwtSecret);
  });
});
