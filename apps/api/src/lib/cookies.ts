import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Centralized refresh-cookie handling.
 *
 * One module owns the `Set-Cookie` serialization so the SET and CLEAR paths
 * cannot drift: clearing reuses the exact same attributes as setting (only the
 * value and Max-Age change). The raw refresh token is the only thing ever
 * placed in this cookie, and the cookie is `HttpOnly` so it is unreadable to
 * client JavaScript.
 *
 * This is implemented without a cookie plugin on purpose: the behavior we need
 * (one HttpOnly cookie, fixed attributes from config) is small and explicit,
 * and a dependency-free helper keeps the security-sensitive serialization in
 * plain sight.
 */

/** Attributes that define the refresh cookie. Sourced from typed config. */
export interface RefreshCookieAttributes {
  name: string;
  path: string;
  sameSite: 'lax';
  httpOnly: true;
  secure: boolean;
  /** Lifetime in seconds; also used (negated) when clearing. */
  maxAgeSeconds: number;
}

/**
 * Serialize one cookie into a `Set-Cookie` header value. `maxAgeSeconds === 0`
 * additionally emits `Expires` in the past so the cookie is removed even by
 * clients that ignore `Max-Age`.
 */
function serializeCookie(
  value: string,
  attributes: RefreshCookieAttributes,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${attributes.name}=${encodeURIComponent(value)}`,
    `Path=${attributes.path}`,
    `SameSite=${attributes.sameSite === 'lax' ? 'Lax' : attributes.sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (attributes.httpOnly) {
    parts.push('HttpOnly');
  }
  if (attributes.secure) {
    parts.push('Secure');
  }
  if (maxAgeSeconds === 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

/** Set the refresh cookie to a freshly issued/rotated raw refresh token. */
export function setRefreshCookie(
  reply: FastifyReply,
  rawToken: string,
  attributes: RefreshCookieAttributes,
): void {
  reply.header(
    'set-cookie',
    serializeCookie(rawToken, attributes, attributes.maxAgeSeconds),
  );
}

/**
 * Clear the refresh cookie. Uses the same name/path/SameSite/Secure/HttpOnly
 * attributes as `setRefreshCookie` (a browser only removes a cookie when the
 * clearing attributes match the ones it was set with) with an empty value and
 * an immediate expiry.
 */
export function clearRefreshCookie(
  reply: FastifyReply,
  attributes: RefreshCookieAttributes,
): void {
  reply.header('set-cookie', serializeCookie('', attributes, 0));
}

/** Read a single cookie value from the request `Cookie` header, or null. */
export function readCookie(
  request: FastifyRequest,
  name: string,
): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return null;
}
