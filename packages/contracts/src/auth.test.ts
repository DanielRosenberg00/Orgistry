import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  authUserSchema,
  loginRequestSchema,
  registerRequestSchema,
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
