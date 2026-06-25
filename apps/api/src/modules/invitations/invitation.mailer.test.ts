import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInvitationAcceptUrl,
  composeInvitationEmail,
  serializeInvitationEmail,
  type InvitationEmailMessage,
} from './invitation.mailer';

const RAW_TOKEN = 'super-secret-raw-token-value';

function message(): InvitationEmailMessage {
  return {
    to: 'invitee@example.com',
    organizationName: 'Acme Inc',
    roleName: 'Admin',
    acceptUrl: buildInvitationAcceptUrl('http://localhost:5173', RAW_TOKEN),
    expiresAt: new Date('2026-07-02T12:00:00.000Z'),
  };
}

describe('invitation email builder', () => {
  it('builds an acceptance URL carrying the raw token as a query param', () => {
    const url = buildInvitationAcceptUrl('http://localhost:5173/', RAW_TOKEN);
    expect(url).toBe(
      `http://localhost:5173/invitations/accept?token=${encodeURIComponent(RAW_TOKEN)}`,
    );
  });

  it('composes an email with recipient, organization, role, link, and expiry', () => {
    const email = composeInvitationEmail(message(), 'invitations@orgistry.local');
    expect(email.to).toBe('invitee@example.com');
    expect(email.from).toBe('invitations@orgistry.local');
    expect(email.subject).toContain('Acme Inc');
    expect(email.text).toContain('Admin');
    expect(email.text).toContain('invitee@example.com');
    expect(email.text).toContain(RAW_TOKEN); // the link (out-of-band) carries it
    expect(email.text).toContain('2026-07-02T12:00:00.000Z');
  });

  it('serializes a valid RFC 822 message with the required headers', () => {
    const email = composeInvitationEmail(message(), 'invitations@orgistry.local');
    const raw = serializeInvitationEmail(email, new Date('2026-06-25T00:00:00Z'));
    expect(raw).toContain('From: invitations@orgistry.local\r\n');
    expect(raw).toContain('To: invitee@example.com\r\n');
    expect(raw).toContain('Subject: ');
    expect(raw).toContain('MIME-Version: 1.0\r\n');
    expect(raw).toContain('\r\n\r\n'); // header/body separator
    expect(raw).toContain(RAW_TOKEN);
  });

  it('does NOT write the raw token (or anything) to the console/logs', () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const email = composeInvitationEmail(message(), 'from@orgistry.local');
    serializeInvitationEmail(email, new Date('2026-06-25T00:00:00Z'));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  let restore: Array<() => void> = [];
  beforeEach(() => {
    restore = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of restore) r();
  });
});
