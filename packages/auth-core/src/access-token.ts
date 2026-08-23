import { SignJWT, jwtVerify } from 'jose';

/**
 * JWT access tokens (HS256).
 *
 * The claim shape is deliberately minimal and STABLE — later sprints and a
 * future web client depend on it:
 *
 *   { sub: userId, sessionId, type: 'access', iat, exp }
 *
 * `sub` carries user identity, `sessionId` ties the token to a persisted
 * session (so a future logout/refresh can invalidate it), and `type`
 * discriminates access tokens from other token kinds. `iat`/`exp` are standard
 * numeric-date claims managed through the signing library.
 */

const ACCESS_TOKEN_TYPE = 'access';
const SIGNING_ALGORITHM = 'HS256';

/** Verified, typed access-token claims. */
export interface AccessTokenClaims {
  sub: string;
  sessionId: string;
  type: typeof ACCESS_TOKEN_TYPE;
  iat: number;
  exp: number;
}

export interface SignAccessTokenParams {
  userId: string;
  sessionId: string;
  /** Symmetric signing secret (from runtime config). */
  secret: string;
  /** Lifetime in seconds. May be negative in tests to forge an expired token. */
  ttlSeconds: number;
  /** Issue time override (seconds since epoch); defaults to the current time. */
  issuedAtSeconds?: number;
}

/** Raised for any token that fails verification (invalid, malformed, expired). */
export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessTokenError';
  }
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign a short-lived access token and return the compact JWT string. */
export async function signAccessToken(
  params: SignAccessTokenParams,
): Promise<string> {
  const issuedAt =
    params.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + params.ttlSeconds;

  return new SignJWT({ sessionId: params.sessionId, type: ACCESS_TOKEN_TYPE })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM })
    .setSubject(params.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(encodeSecret(params.secret));
}

/**
 * Verify an access token and return its typed claims.
 *
 * Throws `AccessTokenError` on a bad signature, malformed token, expiry, or a
 * non-access token type. Callers map that to a generic 401 — verification
 * failures never reveal which check failed to the client.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, encodeSecret(secret), {
      algorithms: [SIGNING_ALGORITHM],
    }));
  } catch (error) {
    throw new AccessTokenError(
      error instanceof Error ? error.message : 'Token verification failed',
    );
  }

  if (payload.type !== ACCESS_TOKEN_TYPE) {
    throw new AccessTokenError('Unexpected token type');
  }
  if (typeof payload.sub !== 'string' || typeof payload.sessionId !== 'string') {
    throw new AccessTokenError('Token is missing required claims');
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new AccessTokenError('Token is missing required timestamps');
  }

  return {
    sub: payload.sub,
    sessionId: payload.sessionId,
    type: ACCESS_TOKEN_TYPE,
    iat: payload.iat,
    exp: payload.exp,
  };
}

/**
 * The signing keys in play during a secret rotation (Sprint 24, ORG-PR-006).
 * Only `current` ever signs; `previous` only ever verifies.
 */
export interface AccessTokenVerificationSecrets {
  /** The secret every newly issued token is signed with. */
  current: string;
  /**
   * The secret being retired. When present, tokens signed with it are still
   * accepted, so rotating `JWT_SECRET` does not invalidate access tokens
   * already in flight. Omit it to complete (or skip) the cutover — every token
   * signed with the old key then fails immediately.
   */
  previous?: string;
}

/**
 * Verify an access token against the current key, then — only if a previous
 * key is configured — against that one.
 *
 * Identical to {@link verifyAccessToken} in every other respect: same claim
 * checks, same expiry handling (an expired token fails under BOTH keys), same
 * generic `AccessTokenError`. When no key accepts the token, the error raised
 * is the CURRENT key's, so diagnostics describe the key tokens are supposed to
 * be signed with rather than the one being retired.
 */
export async function verifyAccessTokenWithRotation(
  token: string,
  secrets: AccessTokenVerificationSecrets,
): Promise<AccessTokenClaims> {
  try {
    return await verifyAccessToken(token, secrets.current);
  } catch (currentKeyError) {
    if (
      secrets.previous === undefined ||
      !(currentKeyError instanceof AccessTokenError)
    ) {
      throw currentKeyError;
    }
    try {
      return await verifyAccessToken(token, secrets.previous);
    } catch {
      throw currentKeyError;
    }
  }
}
