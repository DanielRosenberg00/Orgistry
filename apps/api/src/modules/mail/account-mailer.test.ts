import { describe, expect, it } from 'vitest';
import {
  assertSafeAccountEmail,
  assertSafeSenderIdentity,
  UnsafeHeaderValueError,
  type AccountEmail,
} from './account-mailer';
import { renderInvitationEmail } from '../invitations/invitation.mailer';

/**
 * Central header-injection guard. Every socket driver calls
 * `assertSafeAccountEmail` per delivery and `assertSafeSenderIdentity` at
 * construction, so proving rejection here proves it for every send path;
 * the driver-level enforcement itself is covered in
 * smtp-account-mailer.test.ts.
 */

const INJECTION = 'Acme\r\nBcc: attacker@example.com';

function email(overrides: Partial<AccountEmail> = {}): AccountEmail {
  return {
    to: 'user@example.com',
    subject: 'Verify your email',
    text: 'Hello',
    ...overrides,
  };
}

describe('assertSafeAccountEmail', () => {
  it('accepts a normal message', () => {
    expect(() => assertSafeAccountEmail(email())).not.toThrow();
  });

  it('rejects CR/LF injection through the recipient', () => {
    expect(() =>
      assertSafeAccountEmail(email({ to: `user@example.com\r\nBcc: attacker@example.com` })),
    ).toThrow(UnsafeHeaderValueError);
  });

  it('rejects CR/LF injection through the subject', () => {
    expect(() => assertSafeAccountEmail(email({ subject: INJECTION }))).toThrow(
      UnsafeHeaderValueError,
    );
  });

  it('rejects lone CR, lone LF, and NUL individually', () => {
    for (const bad of ['a\rb', 'a\nb', 'a\u0000b']) {
      expect(() => assertSafeAccountEmail(email({ subject: bad }))).toThrow(
        UnsafeHeaderValueError,
      );
    }
  });

  it('allows CR/LF in the body (it is not a header)', () => {
    expect(() =>
      assertSafeAccountEmail(email({ text: 'line one\r\nline two' })),
    ).not.toThrow();
  });

  it('never echoes the offending value in the error message', () => {
    try {
      assertSafeAccountEmail(email({ subject: INJECTION }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('attacker@example.com');
    }
  });
});

describe('assertSafeSenderIdentity', () => {
  it('rejects injection through the sender display name (MAIL_FROM_NAME)', () => {
    expect(() =>
      assertSafeSenderIdentity({ email: 'no-reply@orgistry.local', name: INJECTION }),
    ).toThrow(UnsafeHeaderValueError);
  });

  it('rejects injection through the sender email', () => {
    expect(() =>
      assertSafeSenderIdentity({ email: `a@b.example\r\nBcc: attacker@example.com`, name: 'Orgistry' }),
    ).toThrow(UnsafeHeaderValueError);
  });

  it('accepts a normal sender, including non-ASCII display names', () => {
    expect(() =>
      assertSafeSenderIdentity({ email: 'no-reply@orgistry.local', name: 'Örgistry GmbH' }),
    ).not.toThrow();
  });
});

describe('feature-rendered content that lands in headers', () => {
  it('an organization name with CR/LF cannot forge a header via the invitation subject', () => {
    const rendered = renderInvitationEmail({
      to: 'invitee@example.com',
      organizationName: INJECTION,
      roleName: 'Member',
      acceptUrl: 'http://localhost:5173/invitations/accept?token=x',
      expiresAt: new Date('2026-07-02T12:00:00.000Z'),
    });
    // The malicious name flows into the subject; the central guard stops it
    // before any transport sees it.
    expect(() => assertSafeAccountEmail(rendered)).toThrow(UnsafeHeaderValueError);
  });
});
