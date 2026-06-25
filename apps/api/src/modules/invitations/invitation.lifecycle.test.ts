import type { InvitationRow } from '@orgistry/db';
import { describe, expect, it } from 'vitest';
import {
  assertAcceptable,
  deriveInvitationStatus,
  isAcceptable,
  isExpired,
} from './invitation.lifecycle';

const NOW = new Date('2026-06-25T12:00:00.000Z');

function invitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: 'inv_test',
    organizationId: 'org_test',
    invitedEmail: 'a@example.com',
    invitedEmailNormalized: 'a@example.com',
    roleId: 'role_member',
    tokenHash: 'hash',
    status: 'pending',
    invitedByUserId: 'user_inviter',
    acceptedByUserId: null,
    revokedByUserId: null,
    expiresAt: new Date(NOW.getTime() + 1000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('invitation lifecycle', () => {
  it('derives expired from expires_at for a still-pending row', () => {
    const future = invitation({ expiresAt: new Date(NOW.getTime() + 1000) });
    const past = invitation({ expiresAt: new Date(NOW.getTime() - 1000) });
    expect(isExpired(future, NOW)).toBe(false);
    expect(isExpired(past, NOW)).toBe(true);
    expect(deriveInvitationStatus(future, NOW)).toBe('pending');
    expect(deriveInvitationStatus(past, NOW)).toBe('expired');
  });

  it('returns terminal persisted statuses as-is', () => {
    expect(deriveInvitationStatus(invitation({ status: 'accepted' }), NOW)).toBe(
      'accepted',
    );
    expect(deriveInvitationStatus(invitation({ status: 'revoked' }), NOW)).toBe(
      'revoked',
    );
  });

  it('treats only a pending, non-expired invitation as acceptable', () => {
    expect(isAcceptable(invitation(), NOW)).toBe(true);
    expect(
      isAcceptable(invitation({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toBe(false);
    expect(isAcceptable(invitation({ status: 'accepted' }), NOW)).toBe(false);
  });

  it('throws the precise error for each non-acceptable state', () => {
    expect(() => assertAcceptable(invitation(), NOW)).not.toThrow();
    expect(() =>
      assertAcceptable(invitation({ status: 'accepted' }), NOW),
    ).toThrow(/already been accepted/i);
    expect(() =>
      assertAcceptable(invitation({ status: 'revoked' }), NOW),
    ).toThrow(/revoked/i);
    expect(() =>
      assertAcceptable(invitation({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toThrow(/expired/i);
  });
});
