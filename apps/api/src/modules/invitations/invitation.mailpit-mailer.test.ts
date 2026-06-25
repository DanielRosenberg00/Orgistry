import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInvitationAcceptUrl } from './invitation.mailer';
import { createMailpitInvitationMailer } from './invitation.mailpit-mailer';

/**
 * Exercises the Mailpit/local SMTP transport against an in-process fake SMTP
 * server (no external dependency, no real Mailpit needed for the unit run). The
 * live Mailpit container is exercised by `pnpm test:integration`.
 */

interface FakeSmtp {
  port: number;
  received: string[];
  close(): Promise<void>;
}

/** A minimal SMTP server. `failAt` makes it reject at a given command. */
function startFakeSmtp(failAt?: 'MAIL' | 'RCPT'): Promise<FakeSmtp> {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let dataBuf = '';

    const consumeData = (): void => {
      const end = dataBuf.indexOf('\r\n.\r\n');
      if (end !== -1) {
        received.push(dataBuf.slice(0, end));
        inData = false;
        dataBuf = '';
        socket.write('250 queued\r\n');
      }
    };

    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      if (inData) {
        dataBuf += chunk;
        consumeData();
        return;
      }
      buffer += chunk;
      let nl = buffer.indexOf('\r\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') {
          socket.write('250 ok\r\n');
        } else if (cmd === 'MAIL') {
          socket.write(failAt === 'MAIL' ? '550 denied\r\n' : '250 ok\r\n');
        } else if (cmd === 'RCPT') {
          socket.write(failAt === 'RCPT' ? '550 denied\r\n' : '250 ok\r\n');
        } else if (cmd === 'DATA') {
          socket.write('354 go ahead\r\n');
          inData = true;
          dataBuf = buffer;
          buffer = '';
          consumeData();
          return;
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
        nl = buffer.indexOf('\r\n');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        received,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

const RAW_TOKEN = 'raw-token-for-smtp-test';

function message() {
  return {
    to: 'invitee@example.com',
    organizationName: 'Acme Inc',
    roleName: 'Member',
    acceptUrl: buildInvitationAcceptUrl('http://localhost:5173', RAW_TOKEN),
    expiresAt: new Date('2026-07-02T12:00:00.000Z'),
  };
}

let smtp: FakeSmtp;

afterEach(async () => {
  await smtp.close();
});

describe('Mailpit SMTP invitation mailer', () => {
  it('delivers the composed message over SMTP', async () => {
    smtp = await startFakeSmtp();
    const mailer = createMailpitInvitationMailer({
      host: '127.0.0.1',
      port: smtp.port,
    });
    await expect(mailer.sendInvitationEmail(message())).resolves.toBeUndefined();

    expect(smtp.received).toHaveLength(1);
    const delivered = smtp.received[0];
    expect(delivered).toContain('To: invitee@example.com');
    expect(delivered).toContain('Acme Inc');
    expect(delivered).toContain('Member');
    expect(delivered).toContain(RAW_TOKEN); // the acceptance link
    expect(delivered).toContain('2026-07-02T12:00:00.000Z');
  });

  it('rejects (fail-closed) when the server refuses the message', async () => {
    smtp = await startFakeSmtp('MAIL');
    const mailer = createMailpitInvitationMailer({
      host: '127.0.0.1',
      port: smtp.port,
    });
    await expect(mailer.sendInvitationEmail(message())).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });
});
