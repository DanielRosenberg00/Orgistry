import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  AccessTokenError,
  signAccessToken,
  verifyAccessToken,
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
