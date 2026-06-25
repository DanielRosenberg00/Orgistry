import type {
  InvitationEmailMessage,
  InvitationMailer,
} from '../invitation.mailer';

/**
 * Capturing invitation mailer for tests.
 *
 * Records every delivered message (including the `acceptUrl`, which carries the
 * raw token) IN MEMORY so a test can both assert the send path was exercised and
 * recover the raw token to drive inspect/accept — without the token ever being
 * logged. `failNext` makes the next send reject, exercising the fail-closed
 * create flow (no invitation persisted when delivery fails).
 */
export interface CapturingInvitationMailer extends InvitationMailer {
  readonly messages: InvitationEmailMessage[];
  /** Set true to make the NEXT send reject; auto-resets after it fires. */
  failNext: boolean;
  /** Recover the raw token from the most recently delivered message. */
  lastToken(): string | null;
}

/** Extract the `token` query parameter from an acceptance URL. */
function tokenFromUrl(url: string): string | null {
  const match = url.match(/[?&]token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createCapturingInvitationMailer(): CapturingInvitationMailer {
  const messages: InvitationEmailMessage[] = [];
  return {
    messages,
    failNext: false,
    async sendInvitationEmail(message: InvitationEmailMessage): Promise<void> {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('Simulated invitation email delivery failure.');
      }
      messages.push(message);
    },
    lastToken(): string | null {
      const last = messages.at(-1);
      return last ? tokenFromUrl(last.acceptUrl) : null;
    },
  };
}
