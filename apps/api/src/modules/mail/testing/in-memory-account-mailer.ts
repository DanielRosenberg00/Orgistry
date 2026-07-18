import type { AccountEmail, AccountMailer } from '../account-mailer';

/**
 * In-memory account mailer (the `memory` driver): captures every delivered
 * message so tests can inspect delivery without opening sockets and without
 * production HTTP contracts ever exposing token material. Raw tokens are
 * recovered from the captured email body — the same out-of-band channel a
 * real recipient would use.
 */
export interface InMemoryAccountMailer extends AccountMailer {
  readonly messages: AccountEmail[];
  /** Set true to make the NEXT delivery reject; auto-resets after it fires. */
  failNext: boolean;
  /** The most recently delivered message, if any. */
  lastMessage(): AccountEmail | null;
  /** Recover the raw token from the first `token=` link in the last message. */
  lastLinkToken(): string | null;
}

function tokenFromText(text: string): string | null {
  // Invitation links carry the token as a query parameter; verification links
  // carry it in the URL fragment (never sent to a server).
  const match = text.match(/[?&#]token=([^&\s]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createInMemoryAccountMailer(): InMemoryAccountMailer {
  const messages: AccountEmail[] = [];
  return {
    messages,
    failNext: false,
    async deliver(email: AccountEmail): Promise<void> {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('Simulated account email delivery failure.');
      }
      messages.push(email);
    },
    lastMessage(): AccountEmail | null {
      return messages.at(-1) ?? null;
    },
    lastLinkToken(): string | null {
      const last = messages.at(-1);
      return last ? tokenFromText(last.text) : null;
    },
  };
}
