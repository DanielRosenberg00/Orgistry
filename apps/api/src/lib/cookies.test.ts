import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  clearRefreshCookie,
  readCookie,
  setRefreshCookie,
  type RefreshCookieAttributes,
} from './cookies';

const ATTRS: RefreshCookieAttributes = {
  name: 'orgistry_rt',
  path: '/v1/auth',
  sameSite: 'lax',
  httpOnly: true,
  secure: false,
  maxAgeSeconds: 1000,
};

/** Capture the single `set-cookie` header a helper emits. */
function captureSetCookie(run: (reply: FastifyReply) => void): string {
  let captured = '';
  const reply = {
    header(name: string, value: string) {
      if (name === 'set-cookie') {
        captured = value;
      }
      return this;
    },
  } as unknown as FastifyReply;
  run(reply);
  return captured;
}

describe('setRefreshCookie', () => {
  it('serializes the configured attributes', () => {
    const cookie = captureSetCookie((reply) =>
      setRefreshCookie(reply, 'raw-token-value', ATTRS),
    );
    expect(cookie).toContain('orgistry_rt=raw-token-value');
    expect(cookie).toContain('Path=/v1/auth');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=1000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure in production-like mode', () => {
    const cookie = captureSetCookie((reply) =>
      setRefreshCookie(reply, 'v', { ...ATTRS, secure: true }),
    );
    expect(cookie).toContain('Secure');
  });
});

describe('clearRefreshCookie', () => {
  it('clears with matching attributes and an immediate expiry', () => {
    const cleared = captureSetCookie((reply) =>
      clearRefreshCookie(reply, ATTRS),
    );
    const set = captureSetCookie((reply) =>
      setRefreshCookie(reply, 'v', ATTRS),
    );

    // Same name/path/attributes so the browser actually drops the cookie...
    expect(cleared).toContain('orgistry_rt=');
    expect(cleared).toContain('Path=/v1/auth');
    expect(cleared).toContain('SameSite=Lax');
    expect(cleared).toContain('HttpOnly');
    // ...but with an empty value and immediate expiry.
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    expect(cleared).not.toContain('Max-Age=1000');
    expect(set).toContain('Max-Age=1000');
  });
});

describe('readCookie', () => {
  function requestWith(cookie?: string): FastifyRequest {
    return { headers: cookie ? { cookie } : {} } as FastifyRequest;
  }

  it('reads a named cookie from the Cookie header', () => {
    const request = requestWith('a=1; orgistry_rt=the-token; b=2');
    expect(readCookie(request, 'orgistry_rt')).toBe('the-token');
  });

  it('returns null when the cookie or header is absent', () => {
    expect(readCookie(requestWith(), 'orgistry_rt')).toBeNull();
    expect(readCookie(requestWith('other=1'), 'orgistry_rt')).toBeNull();
  });

  it('round-trips url-encoded values', () => {
    const request = requestWith('orgistry_rt=a%20b');
    expect(readCookie(request, 'orgistry_rt')).toBe('a b');
  });
});
