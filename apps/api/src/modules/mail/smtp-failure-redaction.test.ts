import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountEmail } from './account-mailer';
import { createSmtpAccountMailer } from './smtp-account-mailer';
import { startFakeSmtp, type FakeSmtp } from './testing/fake-smtp-server';
import { TEST_SMTP_TLS_CERT } from './testing/tls-fixtures';

/**
 * SMTP failure-mode credential hygiene (Sprint 24, ORG-PR-002/ORG-PR-006).
 *
 * The existing driver suite proves each failure mode FAILS CLOSED. This suite
 * asks the complementary question for every representative provider failure a
 * real deployment hits: does the credential survive anywhere in the thrown
 * error — message, stack, or an own property nodemailer attached (it copies
 * transport options onto some errors)? A caller that logs `{ err }` must not
 * be able to print the SMTP password.
 *
 * The rejected-recipient, temporary-error, and timeout modes are exercised
 * here; a real provider's TLS/certificate failure is covered by the driver
 * suite's untrusted-certificate case.
 */

const SENDER = { email: 'no-reply@orgistry.example-deployment.com', name: 'Orgistry' };
// Public test fixture, deliberately distinctive so a substring search is exact.
const CREDENTIALS = {
  username: 'orgistry-mailer',
  password: 'unit-test-smtp-password-DISTINCTIVE-not-real',
};

function message(): AccountEmail {
  return {
    to: 'user@example.com',
    subject: 'Verify your email address',
    text: 'Verify here: https://app.example-deployment.com/auth/verify-email#token=raw',
  };
}

/**
 * Everything a `log.error({ err })` or an unhandled rejection could surface:
 * the message, the stack, and every own enumerable property.
 */
function serializeThrown(error: unknown): string {
  if (!(error instanceof Error)) {
    return JSON.stringify(error);
  }
  return [
    error.message,
    error.stack ?? '',
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ].join('\n');
}

let smtp: FakeSmtp | undefined;

afterEach(async () => {
  await smtp?.close();
  smtp = undefined;
});

/**
 * `host` defaults to `localhost` because the TLS fixture certificate certifies
 * that name; only the timeout case overrides it (see `startSilentListener`).
 */
function mailer(port: number, timeoutMs = 5000, host = 'localhost') {
  return createSmtpAccountMailer({
    host,
    port,
    username: CREDENTIALS.username,
    password: CREDENTIALS.password,
    sender: SENDER,
    timeoutMs,
    trustedCaCertificates: [TEST_SMTP_TLS_CERT],
  });
}

/** Deliver and return the thrown error; fails the test if delivery succeeds. */
async function captureDeliveryFailure(
  deliver: () => Promise<void>,
): Promise<unknown> {
  try {
    await deliver();
  } catch (error) {
    return error;
  }
  return expect.unreachable('delivery should have failed');
}

describe('SMTP failure modes never expose the credential', () => {
  it('rejected authentication', async () => {
    smtp = await startFakeSmtp({ secureTransport: true, failAt: 'AUTH' });
    const error = await captureDeliveryFailure(() =>
      mailer(requirePort(smtp)).deliver(message()),
    );

    const serialized = serializeThrown(error);
    expect(serialized).toContain('535');
    expect(serialized).not.toContain(CREDENTIALS.password);
  });

  it('rejected sender', async () => {
    smtp = await startFakeSmtp({
      secureTransport: true,
      expectedAuth: CREDENTIALS,
      failAt: 'MAIL',
    });
    const error = await captureDeliveryFailure(() =>
      mailer(requirePort(smtp)).deliver(message()),
    );

    expect(serializeThrown(error)).not.toContain(CREDENTIALS.password);
  });

  it('rejected recipient', async () => {
    smtp = await startFakeSmtp({
      secureTransport: true,
      expectedAuth: CREDENTIALS,
      failAt: 'RCPT',
    });
    const error = await captureDeliveryFailure(() =>
      mailer(requirePort(smtp)).deliver(message()),
    );

    expect(serializeThrown(error)).not.toContain(CREDENTIALS.password);
  });

  it('connection refused (wrong host/port)', async () => {
    // Start and immediately close a server so the port is known-unused.
    const closed = await startFakeSmtp({ secureTransport: true });
    const deadPort = closed.port;
    await closed.close();

    const error = await captureDeliveryFailure(() =>
      mailer(deadPort).deliver(message()),
    );

    expect(serializeThrown(error)).not.toContain(CREDENTIALS.password);
  });

  it('untrusted certificate', async () => {
    smtp = await startFakeSmtp({ secureTransport: true });
    const untrusting = createSmtpAccountMailer({
      host: 'localhost',
      port: requirePort(smtp),
      username: CREDENTIALS.username,
      password: CREDENTIALS.password,
      sender: SENDER,
      timeoutMs: 5000,
    });
    const error = await captureDeliveryFailure(() => untrusting.deliver(message()));

    expect(serializeThrown(error)).not.toContain(CREDENTIALS.password);
  });

  it('connection timeout (unresponsive provider endpoint)', async () => {
    // A listener that accepts the socket and then says nothing: the configured
    // timeout is the only thing that can end the attempt.
    //
    // Connect to the listener's LITERAL address, not `localhost`. The listener
    // binds IPv4 loopback only, while `localhost` resolves to `::1` first on a
    // dual-stack Linux host — and nodemailer resolves the hostname itself and
    // dials one literal IP, so Node's happy-eyeballs fallback never engages.
    // Using `localhost` here silently turned this into a connection-REFUSED
    // test on CI, which proves nothing about the timeout path.
    const silent = await startSilentListener();
    try {
      const error = await captureDeliveryFailure(() =>
        mailer(silent.port, 300, silent.host).deliver(message()),
      );

      const serialized = serializeThrown(error);
      expect(serialized.toLowerCase()).toContain('timeout');
      expect(serialized).not.toContain(CREDENTIALS.password);
    } finally {
      await silent.close();
    }
  }, 10_000);
});

/**
 * A TCP listener that accepts connections and never writes a single byte.
 * Returns the address it actually bound so callers dial exactly that endpoint
 * rather than a name that may resolve to a different address family.
 */
async function startSilentListener(): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('silent listener did not bind a TCP port');
  }
  return {
    host: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/** Narrow the module-level `smtp` handle inside a test that just set it. */
function requirePort(server: FakeSmtp | undefined): number {
  if (server === undefined) {
    throw new Error('fake SMTP server was not started');
  }
  return server.port;
}
