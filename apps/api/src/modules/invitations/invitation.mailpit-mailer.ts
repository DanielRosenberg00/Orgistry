import net from 'node:net';
import {
  composeInvitationEmail,
  serializeInvitationEmail,
  type InvitationEmailMessage,
  type InvitationMailer,
} from './invitation.mailer';

/**
 * Mailpit / local SMTP invitation transport.
 *
 * The DEFAULT runtime mailer. It speaks the minimal SMTP exchange Mailpit
 * accepts on its SMTP port (no auth, no TLS — Mailpit is a local dev sink) using
 * Node's built-in `net` socket, so it adds NO production email dependency and no
 * worker/queue. Delivered messages are visible in the Mailpit web UI.
 *
 * FAIL-CLOSED: any connection error, timeout, or non-2xx/3xx SMTP reply REJECTS,
 * so invitation creation aborts before persisting (the service sends the email
 * before writing the invitation row). It never logs (so the raw token in the
 * message body is never written to application logs).
 */

export interface MailpitMailerOptions {
  host: string;
  port: number;
  /** Envelope/From address. Local-only; not a real deliverable mailbox. */
  from?: string;
  /** Socket timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_FROM = 'invitations@orgistry.local';
const DEFAULT_TIMEOUT_MS = 10_000;
const SMTP_CLIENT_NAME = 'orgistry.local';

/** One SMTP step: an optional command to send and the reply code to expect. */
interface SmtpStep {
  send?: string;
  expect: number;
}

/**
 * Length of the first COMPLETE SMTP reply in `buffer`, or -1 if none yet.
 * A reply ends at the first line whose 4th character is a space (`250 ok`),
 * after any continuation lines (`250-...`).
 */
function completeReplyLength(buffer: string): number {
  let consumed = 0;
  const lines = buffer.split('\r\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    consumed += line.length + 2;
    if (line.length === 3 || (line.length >= 4 && line[3] === ' ')) {
      return consumed;
    }
  }
  return -1;
}

/** Run the SMTP conversation for one message. Resolves on success, rejects otherwise. */
function deliverOverSmtp(
  options: Required<MailpitMailerOptions>,
  envelopeTo: string,
  rawMessage: string,
): Promise<void> {
  const steps: SmtpStep[] = [
    { expect: 220 }, // server greeting
    { send: `EHLO ${SMTP_CLIENT_NAME}\r\n`, expect: 250 },
    { send: `MAIL FROM:<${options.from}>\r\n`, expect: 250 },
    { send: `RCPT TO:<${envelopeTo}>\r\n`, expect: 250 },
    { send: 'DATA\r\n', expect: 354 },
    { send: `${rawMessage}\r\n.\r\n`, expect: 250 },
    { send: 'QUIT\r\n', expect: 221 },
  ];

  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({
      host: options.host,
      port: options.port,
    });
    socket.setEncoding('utf8');
    socket.setTimeout(options.timeoutMs);

    let buffer = '';
    let step = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve();
    };

    function processReplies(): void {
      let length = completeReplyLength(buffer);
      while (length !== -1) {
        const reply = buffer.slice(0, length);
        buffer = buffer.slice(length);
        const code = Number.parseInt(reply.slice(0, 3), 10);
        const expected = steps[step].expect;
        if (code !== expected) {
          fail(
            new Error(
              `SMTP step ${step}: expected ${expected}, got ${reply.trim()}`,
            ),
          );
          return;
        }
        step += 1;
        if (step >= steps.length) {
          succeed();
          return;
        }
        const next = steps[step].send;
        if (next) {
          socket.write(next);
        }
        length = completeReplyLength(buffer);
      }
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      processReplies();
    });
    socket.on('timeout', () => fail(new Error('SMTP connection timed out.')));
    socket.on('error', (error) => fail(error));
    socket.on('close', () => {
      if (!settled) {
        fail(new Error('SMTP connection closed before completion.'));
      }
    });
  });
}

export function createMailpitInvitationMailer(
  options: MailpitMailerOptions,
): InvitationMailer {
  const resolved: Required<MailpitMailerOptions> = {
    host: options.host,
    port: options.port,
    from: options.from ?? DEFAULT_FROM,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return {
    async sendInvitationEmail(message: InvitationEmailMessage): Promise<void> {
      const email = composeInvitationEmail(message, resolved.from);
      const rawMessage = serializeInvitationEmail(email, new Date());
      await deliverOverSmtp(resolved, message.to, rawMessage);
    },
  };
}
