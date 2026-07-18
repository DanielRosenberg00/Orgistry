import {
  assertSafeSenderIdentity,
  type AccountMailer,
  type SenderIdentity,
} from './account-mailer';
import {
  createAccountSmtpTransport,
  createTransportAccountMailer,
} from './smtp-transport';

/**
 * Production SMTP driver (Sprint 16, ORG-PR-002).
 *
 * Capabilities, stated precisely (see docs/email-and-verification.md for the
 * evidence backing each):
 *  - transport: SMTP over implicit TLS (SMTPS, conventionally port 465) with
 *    certificate and hostname verification always on. STARTTLS upgrade on a
 *    plaintext port is NOT offered by this driver.
 *  - authentication: whatever mechanism nodemailer negotiates from the
 *    server's advertised capabilities. AUTH PLAIN has direct automated test
 *    evidence; other mechanisms rely on nodemailer and are untested here.
 *  - one adapter, no provider SDKs, no plugin architecture.
 *
 * Construction FAILS for incomplete configuration so a misconfigured process
 * dies at boot, not on the first send. Sending fails closed and never logs:
 * message bodies carry raw tokens and the AUTH exchange carries the
 * credential.
 */

export interface SmtpAccountMailerOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  sender: SenderIdentity;
  timeoutMs: number;
  /**
   * Additional trusted CA certificates (PEM) for private CAs; also the seam
   * that lets the test suite run a real TLS handshake against a self-signed
   * fixture. Appended to the system roots — verification is never disabled.
   */
  trustedCaCertificates?: readonly string[];
}

/** Thrown at construction time for invalid adapter configuration. */
export class SmtpMailerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpMailerConfigurationError';
  }
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new SmtpMailerConfigurationError(
      `SMTP account mailer: ${field} must not be blank`,
    );
  }
}

export function createSmtpAccountMailer(
  options: SmtpAccountMailerOptions,
): AccountMailer {
  requireNonBlank(options.host, 'host');
  requireNonBlank(options.username, 'username');
  requireNonBlank(options.password, 'password');
  requireNonBlank(options.sender.email, 'sender email');
  assertSafeSenderIdentity(options.sender);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new SmtpMailerConfigurationError(
      'SMTP account mailer: port must be an integer between 1 and 65535',
    );
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new SmtpMailerConfigurationError(
      'SMTP account mailer: timeoutMs must be a positive integer',
    );
  }

  const transporter = createAccountSmtpTransport({
    host: options.host,
    port: options.port,
    secureTransport: true,
    auth: { username: options.username, password: options.password },
    timeoutMs: options.timeoutMs,
    trustedCaCertificates: options.trustedCaCertificates,
  });
  return createTransportAccountMailer(transporter, options.sender);
}
