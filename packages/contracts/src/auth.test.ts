import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  authUserSchema,
  changeEmailRequestSchema,
  changeEmailResponseSchema,
  changePasswordRequestSchema,
  emailVerificationCompleteRequestSchema,
  emailVerificationCompleteResponseSchema,
  emailVerificationRequestResponseSchema,
  loginRequestSchema,
  passwordRecoveryCompleteRequestSchema,
  passwordRecoveryRequestResponseSchema,
  passwordRecoveryRequestSchema,
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

describe('email verification contracts (Sprint 16)', () => {
  it('request response reports only sent/alreadyVerified — never token material', () => {
    const keys = Object.keys(emailVerificationRequestResponseSchema.shape).sort();
    expect(keys).toEqual(['alreadyVerified', 'sent']);
    expect(JSON.stringify(keys)).not.toMatch(/token/i);
  });

  it('complete request takes the raw token in the body', () => {
    expect(
      emailVerificationCompleteRequestSchema.safeParse({ token: 'raw-token' })
        .success,
    ).toBe(true);
    expect(
      emailVerificationCompleteRequestSchema.safeParse({ token: '' }).success,
    ).toBe(false);
    expect(
      emailVerificationCompleteRequestSchema.safeParse({}).success,
    ).toBe(false);
  });

  it('complete request rejects absurdly long tokens', () => {
    expect(
      emailVerificationCompleteRequestSchema.safeParse({
        token: 'x'.repeat(513),
      }).success,
    ).toBe(false);
  });

  it('complete response confirms verification without echoing anything else', () => {
    const keys = Object.keys(emailVerificationCompleteResponseSchema.shape);
    expect(keys).toEqual(['verified']);
    expect(
      emailVerificationCompleteResponseSchema.safeParse({ verified: true })
        .success,
    ).toBe(true);
  });
});

describe('password recovery contracts (Sprint 17)', () => {
  it('request takes only an email; response reports only the generic acceptance', () => {
    expect(
      passwordRecoveryRequestSchema.safeParse({ email: 'user@example.com' })
        .success,
    ).toBe(true);
    expect(
      passwordRecoveryRequestSchema.safeParse({ email: 'not-an-email' })
        .success,
    ).toBe(false);
    const keys = Object.keys(passwordRecoveryRequestResponseSchema.shape);
    expect(keys).toEqual(['accepted']);
    expect(JSON.stringify(keys)).not.toMatch(/token|sent|exists|user/i);
  });

  it('complete takes the raw token + new password in the body', () => {
    expect(
      passwordRecoveryCompleteRequestSchema.safeParse({
        token: 'raw-token',
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(true);
    expect(
      passwordRecoveryCompleteRequestSchema.safeParse({
        token: '',
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(false);
    expect(
      passwordRecoveryCompleteRequestSchema.safeParse({
        token: 'x'.repeat(513),
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(false);
  });

  it('enforces the SAME shared password policy as registration', () => {
    // A password registration would reject must also be rejected here (and by
    // change-password below) — the policy is one shared schema by design.
    const weak = 'short';
    expect(
      registerRequestSchema.safeParse({
        email: 'a@example.com',
        password: weak,
        displayName: 'A',
      }).success,
    ).toBe(false);
    expect(
      passwordRecoveryCompleteRequestSchema.safeParse({
        token: 'raw-token',
        newPassword: weak,
      }).success,
    ).toBe(false);
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'whatever-current',
        newPassword: weak,
      }).success,
    ).toBe(false);
  });
});

describe('credential change contracts (Sprint 17)', () => {
  it('change password requires the current password and a policy-valid new one', () => {
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'old-password',
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(true);
    expect(
      changePasswordRequestSchema.safeParse({
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(false);
    // The CURRENT password is only shape-checked (it may pre-date the policy).
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'short',
        newPassword: 'a-strong-password',
      }).success,
    ).toBe(true);
  });

  it('change email requires the current password and a valid new email', () => {
    expect(
      changeEmailRequestSchema.safeParse({
        currentPassword: 'old-password',
        newEmail: 'new@example.com',
      }).success,
    ).toBe(true);
    expect(
      changeEmailRequestSchema.safeParse({ newEmail: 'new@example.com' })
        .success,
    ).toBe(false);
    expect(
      changeEmailRequestSchema.safeParse({
        currentPassword: 'old-password',
        newEmail: 'not-an-email',
      }).success,
    ).toBe(false);
  });

  it('change email response is the public user shape (no credential material)', () => {
    const keys = Object.keys(changeEmailResponseSchema.shape);
    expect(keys).toEqual(['user']);
  });
});
