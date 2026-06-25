import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes';
import { registerRequestSchema } from './auth';
import {
  invitationCreateRequestSchema,
  invitationSchema,
  invitationStatusSchema,
  invitationTokenRequestSchema,
  publicInvitationSchema,
} from './invitations';

describe('invitation contracts', () => {
  it('defines the four lifecycle statuses', () => {
    for (const status of ['pending', 'accepted', 'revoked', 'expired']) {
      expect(invitationStatusSchema.parse(status)).toBe(status);
    }
    expect(invitationStatusSchema.safeParse('cancelled').success).toBe(false);
  });

  it('validates the create request: fixed role + valid email only', () => {
    expect(
      invitationCreateRequestSchema.parse({
        email: 'a@example.com',
        role: 'admin',
      }),
    ).toEqual({ email: 'a@example.com', role: 'admin' });

    expect(
      invitationCreateRequestSchema.safeParse({
        email: 'a@example.com',
        role: 'superadmin',
      }).success,
    ).toBe(false);
    expect(
      invitationCreateRequestSchema.safeParse({
        email: 'not-an-email',
        role: 'member',
      }).success,
    ).toBe(false);
  });

  it('never models a raw token or token hash in any public DTO', () => {
    const invitationKeys = Object.keys(invitationSchema.shape);
    const publicKeys = Object.keys(publicInvitationSchema.shape);
    for (const key of [...invitationKeys, ...publicKeys]) {
      expect(key.toLowerCase()).not.toContain('token');
      expect(key.toLowerCase()).not.toContain('hash');
      expect(key.toLowerCase()).not.toContain('secret');
    }
  });

  it('requires a non-empty token on the token-bearing request', () => {
    expect(invitationTokenRequestSchema.safeParse({ token: '' }).success).toBe(
      false,
    );
    expect(
      invitationTokenRequestSchema.parse({ token: 'abc' }),
    ).toEqual({ token: 'abc' });
  });

  it('exposes the stable invitation error codes', () => {
    expect(ERROR_CODES.INVITATION_INVALID).toBe('INVITATION_INVALID');
    expect(ERROR_CODES.INVITATION_EXPIRED).toBe('INVITATION_EXPIRED');
    expect(ERROR_CODES.INVITATION_REVOKED).toBe('INVITATION_REVOKED');
    expect(ERROR_CODES.INVITATION_ALREADY_ACCEPTED).toBe(
      'INVITATION_ALREADY_ACCEPTED',
    );
    expect(ERROR_CODES.INVITATION_EMAIL_MISMATCH).toBe(
      'INVITATION_EMAIL_MISMATCH',
    );
  });

  it('accepts registration with and without an optional invitation token', () => {
    const base = {
      email: 'a@example.com',
      password: 'a-strong-password-123',
      displayName: 'A',
    };
    expect(registerRequestSchema.parse(base).invitationToken).toBeUndefined();
    expect(
      registerRequestSchema.parse({ ...base, invitationToken: 'tok' })
        .invitationToken,
    ).toBe('tok');
  });
});
