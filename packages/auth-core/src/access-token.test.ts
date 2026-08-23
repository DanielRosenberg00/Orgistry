import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  AccessTokenError,
  signAccessToken,
  verifyAccessToken,
  verifyAccessTokenWithRotation,
} from './access-token';

const SECRET = 'unit-test-jwt-secret-value-1234';

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips a token and returns the stable claim shape', async () => {
    const token = await signAccessToken({
      userId: 'user_abc',
      sessionId: 'sess_xyz',
      secret: SECRET,
      ttlSeconds: 900,
    });

    const claims = await verifyAccessToken(token, SECRET);
    expect(claims.sub).toBe('user_abc');
    expect(claims.sessionId).toBe('sess_xyz');
    expect(claims.type).toBe('access');
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken({
      userId: 'user_abc',
      sessionId: 'sess_xyz',
      secret: SECRET,
      ttlSeconds: 900,
    });

    await expect(
      verifyAccessToken(token, 'a-different-secret-value-1234'),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('rejects a malformed token', async () => {
    await expect(
      verifyAccessToken('not.a.jwt', SECRET),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('rejects an expired token', async () => {
    const expired = await signAccessToken({
      userId: 'user_abc',
      sessionId: 'sess_xyz',
      secret: SECRET,
      ttlSeconds: -10,
    });

    await expect(
      verifyAccessToken(expired, SECRET),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('rejects a correctly-signed token with the wrong type discriminator', async () => {
    // A token signed with the right secret but a non-access `type` (e.g. a
    // future refresh token) must not be accepted as an access token.
    const wrongType = await new SignJWT({ sessionId: 'sess_xyz', type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_abc')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));

    await expect(
      verifyAccessToken(wrongType, SECRET),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });
});

describe('verifyAccessTokenWithRotation', () => {
  // The three keys of a rotation: the one now signing, the one being retired,
  // and one that was retired in an earlier rotation and must no longer work.
  const CURRENT_SECRET = 'unit-test-jwt-secret-CURRENT-1234';
  const PREVIOUS_SECRET = 'unit-test-jwt-secret-PREVIOUS-1234';
  const ABANDONED_SECRET = 'unit-test-jwt-secret-ABANDONED-1234';

  function signWith(secret: string, ttlSeconds = 900): Promise<string> {
    return signAccessToken({
      userId: 'user_abc',
      sessionId: 'sess_xyz',
      secret,
      ttlSeconds,
    });
  }

  it('accepts a current-key token when no previous key is configured', async () => {
    const token = await signWith(CURRENT_SECRET);

    const claims = await verifyAccessTokenWithRotation(token, {
      current: CURRENT_SECRET,
    });
    expect(claims.sub).toBe('user_abc');
  });

  it('rejects a previous-key token when no previous key is configured', async () => {
    const token = await signWith(PREVIOUS_SECRET);

    await expect(
      verifyAccessTokenWithRotation(token, { current: CURRENT_SECRET }),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('accepts current-key tokens during a rotation window', async () => {
    const token = await signWith(CURRENT_SECRET);

    const claims = await verifyAccessTokenWithRotation(token, {
      current: CURRENT_SECRET,
      previous: PREVIOUS_SECRET,
    });
    expect(claims.sessionId).toBe('sess_xyz');
  });

  it('accepts previous-key tokens during a rotation window', async () => {
    // A token issued before the rotation: still in its 15-minute lifetime.
    const token = await signWith(PREVIOUS_SECRET);

    const claims = await verifyAccessTokenWithRotation(token, {
      current: CURRENT_SECRET,
      previous: PREVIOUS_SECRET,
    });
    expect(claims.sub).toBe('user_abc');
  });

  it('rejects a token signed with an unrelated older key', async () => {
    const token = await signWith(ABANDONED_SECRET);

    await expect(
      verifyAccessTokenWithRotation(token, {
        current: CURRENT_SECRET,
        previous: PREVIOUS_SECRET,
      }),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('rejects previous-key tokens once the previous key is removed (cutover)', async () => {
    const token = await signWith(PREVIOUS_SECRET);

    // Same token, same instant — the ONLY change is dropping the previous key.
    await expect(
      verifyAccessTokenWithRotation(token, {
        current: CURRENT_SECRET,
        previous: PREVIOUS_SECRET,
      }),
    ).resolves.toMatchObject({ sub: 'user_abc' });
    await expect(
      verifyAccessTokenWithRotation(token, { current: CURRENT_SECRET }),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('still enforces expiry under both keys', async () => {
    for (const secret of [CURRENT_SECRET, PREVIOUS_SECRET]) {
      const expired = await signWith(secret, -10);
      await expect(
        verifyAccessTokenWithRotation(expired, {
          current: CURRENT_SECRET,
          previous: PREVIOUS_SECRET,
        }),
      ).rejects.toBeInstanceOf(AccessTokenError);
    }
  });

  it('still enforces the type discriminator under the previous key', async () => {
    const wrongType = await new SignJWT({ sessionId: 'sess_xyz', type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_abc')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(PREVIOUS_SECRET));

    await expect(
      verifyAccessTokenWithRotation(wrongType, {
        current: CURRENT_SECRET,
        previous: PREVIOUS_SECRET,
      }),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('never leaks a secret value through the raised error', async () => {
    const token = await signWith(ABANDONED_SECRET);

    await expect(
      verifyAccessTokenWithRotation(token, {
        current: CURRENT_SECRET,
        previous: PREVIOUS_SECRET,
      }),
    ).rejects.toSatisfy(
      (error: Error) =>
        !error.message.includes(CURRENT_SECRET) &&
        !error.message.includes(PREVIOUS_SECRET),
    );
  });
});
