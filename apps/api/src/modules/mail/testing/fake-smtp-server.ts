import net from 'node:net';
import tls from 'node:tls';
import { TEST_SMTP_TLS_CERT, TEST_SMTP_TLS_KEY } from './tls-fixtures';

/**
 * In-process fake SMTP server for driver tests (no external dependency, no
 * real Mailpit or provider needed). Plaintext mode exercises the Mailpit
 * driver; TLS mode (self-signed localhost fixture) plus AUTH exercises the
 * production smtp driver end-to-end, including the real TLS handshake.
 */

export interface FakeSmtpOptions {
  /** Serve implicit TLS using the committed localhost test certificate. */
  secureTransport?: boolean;
  /** Expect `AUTH PLAIN` with exactly these credentials before MAIL FROM. */
  expectedAuth?: { username: string; password: string };
  /** Make the server reject at a given command. */
  failAt?: 'AUTH' | 'MAIL' | 'RCPT';
}

export interface FakeSmtp {
  port: number;
  /** Message payloads received via DATA (headers + body, CRLF form). */
  received: string[];
  /** Raw AUTH PLAIN arguments observed (base64), for assertion. */
  authAttempts: string[];
  close(): Promise<void>;
}

export function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const received: string[] = [];
  const authAttempts: string[] = [];

  const handleConnection = (socket: net.Socket): void => {
    // Clients abort mid-session by design in failure-path tests (e.g. a TLS
    // client refusing this plaintext server). Without a listener, the
    // resulting ECONNRESET is an uncaught exception that can fail an entire
    // unrelated vitest run; the abort itself is expected and uninteresting.
    socket.on('error', () => {
      socket.destroy();
    });
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
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') {
          socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        } else if (cmd === 'AUTH') {
          const argument = line.split(' ')[2] ?? '';
          authAttempts.push(argument);
          if (options.failAt === 'AUTH') {
            socket.write('535 authentication failed\r\n');
          } else if (options.expectedAuth) {
            const expected = Buffer.from(
              `\u0000${options.expectedAuth.username}\u0000${options.expectedAuth.password}`,
            ).toString('base64');
            socket.write(
              argument === expected
                ? '235 ok\r\n'
                : '535 authentication failed\r\n',
            );
          } else {
            socket.write('235 ok\r\n');
          }
        } else if (cmd === 'MAIL') {
          socket.write(options.failAt === 'MAIL' ? '550 denied\r\n' : '250 ok\r\n');
        } else if (cmd === 'RCPT') {
          socket.write(options.failAt === 'RCPT' ? '550 denied\r\n' : '250 ok\r\n');
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
  };

  const server = options.secureTransport
    ? tls.createServer(
        { cert: TEST_SMTP_TLS_CERT, key: TEST_SMTP_TLS_KEY },
        handleConnection,
      )
    : net.createServer(handleConnection);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        received,
        authAttempts,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
