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

  it('keeps safe opaque identifiers even when the key contains a denylisted substring', () => {
    // `apiKeyId` contains the `apikey` substring but is a non-secret `key_…` id
    // the audit/security DTOs need for actor/target summaries.
    const result = sanitizeSecurityMetadata({
      apiKeyId: 'key_1',
      targetApiKeyId: 'key_2',
      actorApiKeyId: 'key_3',
      targetKeyId: 'key_4',
      membershipId: 'mem_1',
      targetMembershipId: 'mem_2',
      targetProjectId: 'prj_1',
      targetInvitationId: 'inv_1',
      targetUserId: 'user_1',
    });

    expect(result).toEqual({
      apiKeyId: 'key_1',
      targetApiKeyId: 'key_2',
      actorApiKeyId: 'key_3',
      targetKeyId: 'key_4',
      membershipId: 'mem_1',
      targetMembershipId: 'mem_2',
      targetProjectId: 'prj_1',
      targetInvitationId: 'inv_1',
      targetUserId: 'user_1',
    });
  });

  it('still drops secret-bearing API key material (exact-match allowlist only)', () => {
    const result = sanitizeSecurityMetadata({
      targetApiKeyId: 'key_1', // safe id — kept
      apiKey: 'key_raw_secret',
      apiKeySecret: 'shh',
      apiKeyHash: 'deadbeef',
      apiKeyToken: 'raw',
      apiKeyValue: 'raw',
      apiKeyCredential: 'raw',
      nested: { apiKeySecret: 'shh', targetApiKeyId: 'key_2' },
    });

    expect(result).toEqual({
      targetApiKeyId: 'key_1',
      nested: { targetApiKeyId: 'key_2' },
    });
    expect(JSON.stringify(result)).not.toContain('shh');
    expect(JSON.stringify(result)).not.toContain('deadbeef');
  });

  it('drops request-correlation identifiers (ip/user-agent/session) from metadata', () => {
    const result = sanitizeSecurityMetadata({
      reason: 'ok',
      ipAddress: '203.0.113.1',
      userAgent: 'curl/8',
      sessionId: 'sess_1',
      nested: { ipAddress: '203.0.113.2' },
    });

    expect(result).toEqual({ reason: 'ok', nested: {} });
  });

  it('drops a raw refresh token even if one is wrongly placed in metadata', () => {
    // Defense-in-depth: callers must never put a raw token in metadata, but if
    // they do, any `token`-named key is dropped entirely (not masked in place).
    const result = sanitizeSecurityMetadata({
      bucket: 'refresh_per_ip',
      refreshToken: 'raw-secret-token',
      refresh_token_hash: 'deadbeef',
    });
    expect(result).toEqual({ bucket: 'refresh_per_ip' });
    expect(JSON.stringify(result)).not.toContain('raw-secret-token');
    expect(JSON.stringify(result)).not.toContain('deadbeef');
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

  it('defines stable Sprint 3 session-lifecycle event names', () => {
    expect(SECURITY_EVENT_TYPES.refreshTokenRotated).toBe(
      'auth.refresh_token_rotated',
    );
    expect(SECURITY_EVENT_TYPES.refreshTokenReuseDetected).toBe(
      'auth.refresh_token_reuse_detected',
    );
    expect(SECURITY_EVENT_TYPES.refreshFailed).toBe('auth.refresh_failed');
    expect(SECURITY_EVENT_TYPES.logoutSucceeded).toBe('auth.logout_succeeded');
    expect(SECURITY_EVENT_TYPES.sessionRevoked).toBe('auth.session_revoked');
    expect(SECURITY_EVENT_TYPES.rateLimitExceeded).toBe(
      'auth.rate_limit_exceeded',
    );
  });
});
