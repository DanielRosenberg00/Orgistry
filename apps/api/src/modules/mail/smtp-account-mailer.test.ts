import { afterEach, describe, expect, it } from 'vitest';
import { requireDefined } from '../../lib/invariant';
import { UnsafeHeaderValueError, type AccountEmail } from './account-mailer';
import { createMailpitAccountMailer } from './mailpit-account-mailer';
import {
  createSmtpAccountMailer,
  SmtpMailerConfigurationError,
} from './smtp-account-mailer';
import { startFakeSmtp, type FakeSmtp } from './testing/fake-smtp-server';
import { TEST_SMTP_TLS_CERT } from './testing/tls-fixtures';

/**
 * Exercises both socket drivers (nodemailer-backed) against an in-process
 * fake SMTP server — the Mailpit driver over plaintext, and the production
 * smtp driver over a REAL implicit-TLS handshake (self-signed localhost
 * fixture trusted via the additional-CA seam; verification stays enabled)
 * with authentication. No external service is contacted.
 */

const SENDER = { email: 'no-reply@orgistry.example-deployment.com', name: 'Orgistry' };
const CREDENTIALS = { username: 'orgistry-mailer', password: 'test-smtp-password-value-1234' };
const INJECTION = 'Acme\r\nBcc: attacker@example.com';

function message(overrides: Partial<AccountEmail> = {}): AccountEmail {
  return {
    to: 'user@example.com',
    subject: 'Verify your email address',
    text: 'Verify here: http://localhost:5173/auth/verify-email#token=raw-token-for-smtp-test',
    ...overrides,
  };
}

let smtp: FakeSmtp | undefined;

afterEach(async () => {
  await smtp?.close();
  smtp = undefined;
});

describe('Mailpit account mailer (plaintext local driver)', () => {
  function mailer(port: number) {
    return createMailpitAccountMailer({
      host: '127.0.0.1',
      port,
      sender: SENDER,
      timeoutMs: 5000,
    });
  }

  it('delivers the message over SMTP with the configured sender', async () => {
    smtp = await startFakeSmtp();
    await expect(mailer(smtp.port).deliver(message())).resolves.toBeUndefined();

    expect(smtp.received).toHaveLength(1);
    const delivered = smtp.received[0];
    expect(delivered).toContain('To: user@example.com');
    expect(delivered).toContain('Subject: Verify your email address');
    // The body is quoted-printable on the wire (clients decode it back
    // losslessly), so assert on fragments unaffected by `=`/soft-wrap escaping.
    expect(delivered).toContain('/auth/verify-email#');
    expect(delivered).toContain('raw-token-for-');
    expect(delivered).toContain('no-reply@orgistry.example-deployment.com');
    expect(smtp.authAttempts).toHaveLength(0);
  });

  it('rejects (fail-closed) when the server refuses the message', async () => {
    smtp = await startFakeSmtp({ failAt: 'MAIL' });
    await expect(mailer(smtp.port).deliver(message())).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  it('refuses a header-injection attempt before anything reaches the socket', async () => {
    smtp = await startFakeSmtp();
    await expect(
      mailer(smtp.port).deliver(message({ subject: INJECTION })),
    ).rejects.toThrow(UnsafeHeaderValueError);
    await expect(
      mailer(smtp.port).deliver(
        message({ to: 'user@example.com\r\nRCPT TO:<attacker@example.com>' }),
      ),
    ).rejects.toThrow(UnsafeHeaderValueError);
    expect(smtp.received).toHaveLength(0);
  });

  it('delivers non-ASCII subjects as encoded words, never raw header lines', async () => {
    smtp = await startFakeSmtp();
    await mailer(smtp.port).deliver(message({ subject: 'Bestätige deine E-Mail ✓' }));

    const delivered = requireDefined(smtp.received[0], 'delivered message');
    // RFC 2047 encoded-word (nodemailer's encoding) — a single Subject line.
    expect(delivered).toMatch(/Subject: =\?utf-8\?/i);
    expect(delivered.match(/^Subject:/gim)).toHaveLength(1);
  });

  it('fails construction for a forgeable sender display name', () => {
    expect(() =>
      createMailpitAccountMailer({
        host: '127.0.0.1',
        port: 1025,
        sender: { email: 'a@b.example', name: INJECTION },
        timeoutMs: 5000,
      }),
    ).toThrow(UnsafeHeaderValueError);
  });
});

describe('SMTP account mailer (production driver, implicit TLS + auth)', () => {
  function tlsMailer(port: number, overrides: Partial<Parameters<typeof createSmtpAccountMailer>[0]> = {}) {
    return createSmtpAccountMailer({
      host: 'localhost',
      port,
      username: CREDENTIALS.username,
      password: CREDENTIALS.password,
      sender: SENDER,
      timeoutMs: 5000,
      trustedCaCertificates: [TEST_SMTP_TLS_CERT],
      ...overrides,
    });
  }

  it('authenticates over TLS and delivers the message', async () => {
    smtp = await startFakeSmtp({ secureTransport: true, expectedAuth: CREDENTIALS });
    await expect(tlsMailer(smtp.port).deliver(message())).resolves.toBeUndefined();

    expect(smtp.authAttempts).toHaveLength(1);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]).toContain('To: user@example.com');
  });

  it('rejects when the server refuses the credentials, without leaking them', async () => {
    smtp = await startFakeSmtp({ secureTransport: true, failAt: 'AUTH' });
    const failure = await tlsMailer(smtp.port)
      .deliver(message())
      .then(() => null)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('535');
    expect(failure?.message).not.toContain(CREDENTIALS.password);
    expect(smtp.received).toHaveLength(0);
  });

  it('rejects a permanent 5xx recipient refusal (fail-closed)', async () => {
    smtp = await startFakeSmtp({ secureTransport: true, expectedAuth: CREDENTIALS, failAt: 'RCPT' });
    await expect(tlsMailer(smtp.port).deliver(message())).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  it('rejects when the server certificate is not trusted', async () => {
    smtp = await startFakeSmtp({ secureTransport: true });
    // No trustedCaCertificates: the self-signed fixture must fail verification.
    const mailer = tlsMailer(smtp.port, { trustedCaCertificates: undefined });
    await expect(mailer.deliver(message())).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  it('refuses a plaintext server (implicit TLS is unconditional for this driver)', async () => {
    smtp = await startFakeSmtp();
    await expect(tlsMailer(smtp.port).deliver(message())).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  it('refuses a header-injection attempt before anything reaches the socket', async () => {
    smtp = await startFakeSmtp({ secureTransport: true, expectedAuth: CREDENTIALS });
    await expect(
      tlsMailer(smtp.port).deliver(message({ subject: INJECTION })),
    ).rejects.toThrow(UnsafeHeaderValueError);
    expect(smtp.received).toHaveLength(0);
    expect(smtp.authAttempts).toHaveLength(0);
  });

  it('fails construction for blank host, credentials, sender, or bad numbers', () => {
    const base = {
      host: 'smtp.example-provider.com',
      port: 465,
      username: 'user',
      password: 'secret',
      sender: SENDER,
      timeoutMs: 5000,
    };
    expect(() => createSmtpAccountMailer({ ...base, host: '  ' })).toThrow(
      SmtpMailerConfigurationError,
    );
    expect(() => createSmtpAccountMailer({ ...base, username: '' })).toThrow(
      SmtpMailerConfigurationError,
    );
    expect(() => createSmtpAccountMailer({ ...base, password: '' })).toThrow(
      SmtpMailerConfigurationError,
    );
    expect(() =>
      createSmtpAccountMailer({ ...base, sender: { email: '', name: 'Orgistry' } }),
    ).toThrow(SmtpMailerConfigurationError);
    expect(() =>
      createSmtpAccountMailer({ ...base, sender: { email: 'a@b.example', name: INJECTION } }),
    ).toThrow(UnsafeHeaderValueError);
    expect(() => createSmtpAccountMailer({ ...base, port: 0 })).toThrow(
      SmtpMailerConfigurationError,
    );
    expect(() => createSmtpAccountMailer({ ...base, timeoutMs: 0 })).toThrow(
      SmtpMailerConfigurationError,
    );
  });
});
