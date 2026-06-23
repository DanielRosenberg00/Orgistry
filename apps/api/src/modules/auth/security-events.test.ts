import { describe, expect, it } from 'vitest';
import {
  SECURITY_EVENT_TYPES,
  sanitizeSecurityMetadata,
} from './security-events';

describe('sanitizeSecurityMetadata', () => {
  it('drops forbidden top-level keys', () => {
    const result = sanitizeSecurityMetadata({
      reason: 'bad_password',
      password: 'hunter2',
      passwordHash: '$argon2id$...',
      accessToken: 'eyJ...',
      refreshToken: 'raw-token',
      authorization: 'Bearer eyJ...',
      cookie: 'session=abc',
      apiKey: 'key_123',
      otp: '123456',
    });

    expect(result).toEqual({ reason: 'bad_password' });
  });

  it('recursively strips forbidden keys in nested objects and arrays', () => {
    const result = sanitizeSecurityMetadata({
      context: {
        email: 'user@example.com',
        credentials: { secret: 'nope' },
      },
      attempts: [{ token: 'leak' }, { ok: true }],
    });

    expect(result).toEqual({
      context: { email: 'user@example.com' },
      attempts: [{}, { ok: true }],
    });
  });

  it('preserves safe primitive values', () => {
    const result = sanitizeSecurityMetadata({
      reason: 'unknown_email',
      count: 3,
      flagged: false,
      missing: null,
    });

    expect(result).toEqual({
      reason: 'unknown_email',
      count: 3,
      flagged: false,
      missing: null,
    });
  });

  it('caps very long string values', () => {
    const long = 'a'.repeat(5000);
    const result = sanitizeSecurityMetadata({ note: long }) as {
      note: string;
    };
    expect(result.note.length).toBeLessThan(long.length);
  });
});

describe('SECURITY_EVENT_TYPES', () => {
  it('uses stable dotted names', () => {
    expect(SECURITY_EVENT_TYPES.registrationSucceeded).toBe(
      'auth.registration_succeeded',
    );
    expect(SECURITY_EVENT_TYPES.loginSucceeded).toBe('auth.login_succeeded');
    expect(SECURITY_EVENT_TYPES.loginFailed).toBe('auth.login_failed');
    expect(SECURITY_EVENT_TYPES.accessTokenRejected).toBe(
      'auth.access_token_rejected',
    );
  });
});
