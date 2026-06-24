import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  authUserSchema,
  loginRequestSchema,
  refreshResponseSchema,
  registerRequestSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
} from './auth';

describe('registerRequestSchema', () => {
  const valid = {
    email: 'New.User@Example.com',
    password: 'a-strong-password',
    displayName: 'New User',
  };

  it('accepts a well-formed registration body', () => {
    expect(registerRequestSchema.safeParse(valid).success).toBe(true);
  });

  it(`rejects passwords shorter than ${MIN_PASSWORD_LENGTH} characters`, () => {
    const result = registerRequestSchema.safeParse({
      ...valid,
      password: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(
      registerRequestSchema.safeParse({ ...valid, email: 'not-an-email' })
        .success,
    ).toBe(false);
  });

  it('rejects a blank display name', () => {
    expect(
      registerRequestSchema.safeParse({ ...valid, displayName: '   ' }).success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('does not impose the registration minimum length on login', () => {
    // An existing account may pre-date a policy change; login must still try.
    const result = loginRequestSchema.safeParse({
      email: 'user@example.com',
      password: 'short',
    });
    expect(result.success).toBe(true);
  });
});

describe('authUserSchema', () => {
  it('describes the public user shape without secret fields', () => {
    const keys = Object.keys(authUserSchema.shape).sort();
    expect(keys).toEqual([
      'createdAt',
      'displayName',
      'email',
      'emailVerified',
      'id',
    ]);
    expect(keys).not.toContain('passwordHash');
    expect(keys).not.toContain('normalizedEmail');
  });
});

describe('session lifecycle contracts', () => {
  it('refresh response carries only an access token (no refresh credential)', () => {
    const keys = Object.keys(refreshResponseSchema.shape);
    expect(keys).toEqual(['tokens']);
    expect(JSON.stringify(keys)).not.toMatch(/refresh/i);
  });

  it('session summary exposes only non-sensitive lifecycle metadata', () => {
    const keys = Object.keys(sessionSummarySchema.shape).sort();
    expect(keys).toEqual([
      'createdAt',
      'current',
      'expiresAt',
      'id',
      'ipAddress',
      'updatedAt',
      'userAgent',
    ]);
    // No persistence internals are part of the contract.
    expect(keys).not.toContain('tokenHash');
    expect(keys).not.toContain('familyId');
    expect(keys).not.toContain('userId');
  });

  it('session list response is a cursor page of session summaries', () => {
    const parsed = sessionListResponseSchema.safeParse({
      items: [
        {
          id: 'sess_1',
          current: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-02-01T00:00:00.000Z',
          userAgent: 'test-agent',
          ipAddress: null,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(parsed.success).toBe(true);
  });
});
