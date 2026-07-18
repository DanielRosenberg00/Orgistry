import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildInvitationAcceptUrl,
  renderInvitationEmail,
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

describe('invitation email rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an acceptance URL carrying the raw token as a query param', () => {
    const url = buildInvitationAcceptUrl('http://localhost:5173/', RAW_TOKEN);
    expect(url).toBe(
      `http://localhost:5173/invitations/accept?token=${encodeURIComponent(RAW_TOKEN)}`,
    );
  });

  it('renders an email with recipient, organization, role, link, and expiry', () => {
    const email = renderInvitationEmail(message());
    expect(email.to).toBe('invitee@example.com');
    expect(email.subject).toContain('Acme Inc');
    expect(email.text).toContain('Admin');
    expect(email.text).toContain('invitee@example.com');
    expect(email.text).toContain(RAW_TOKEN); // the link (out-of-band) carries it
    expect(email.text).toContain('2026-07-02T12:00:00.000Z');
  });

  it('does NOT write the raw token (or anything) to the console/logs', () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    renderInvitationEmail(message());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
