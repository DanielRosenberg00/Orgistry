import tls from 'node:tls';
import { createTransport, type Transporter } from 'nodemailer';
import {
  assertSafeAccountEmail,
  type AccountEmail,
  type AccountMailer,
  type SenderIdentity,
} from './account-mailer';

/**
 * Shared SMTP transport for the socket-backed drivers (Sprint 16 refinement).
 *
 * The SMTP protocol itself is nodemailer's — a mature implementation that
 * handles the parts a hand-written client gets wrong under real providers:
 * multiline replies, EHLO capability parsing, AUTH mechanism negotiation from
 * advertised capabilities, TLS certificate + hostname verification, dot
 * stuffing, RFC 2047 encoding of non-ASCII headers, and socket teardown on
 * every path. (This replaced the Sprint 16 hand-rolled step-table client; the
 * fake-server interop tests were kept and now exercise nodemailer.)
 *
 * This module owns only the Orgistry-specific policy around it:
 *  - the central header-injection guard runs before every send;
 *  - `secureTransport: true` means implicit TLS from the first byte (SMTPS)
 *    with certificate verification always on;
 *  - `secureTransport: false` (the local Mailpit sink) disables STARTTLS
 *    negotiation too — Mailpit advertises STARTTLS with a self-signed
 *    certificate, and an opportunistic upgrade would fail verification;
 *  - the configured timeout bounds connect, greeting, and socket inactivity;
 *  - extra trusted CAs are APPENDED to the system roots (private CAs and the
 *    test fixture), never replacing them, and verification is never disabled;
 *  - nothing is ever logged (message bodies carry raw tokens; the AUTH
 *    exchange carries the credential).
 */

export interface AccountSmtpTransportOptions {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (SMTPS). False = plaintext local sink. */
  secureTransport: boolean;
  auth?: { username: string; password: string };
  /** Bounds connect, greeting, and socket-inactivity phases, in ms. */
  timeoutMs: number;
  /** Additional trusted CA certificates (PEM), appended to system roots. */
  trustedCaCertificates?: readonly string[];
}

export function createAccountSmtpTransport(
  options: AccountSmtpTransportOptions,
): Transporter {
  return createTransport({
    host: options.host,
    port: options.port,
    secure: options.secureTransport,
    ignoreTLS: !options.secureTransport,
    auth: options.auth
      ? { user: options.auth.username, pass: options.auth.password }
      : undefined,
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
    tls: options.trustedCaCertificates
      ? { ca: [...tls.rootCertificates, ...options.trustedCaCertificates] }
      : undefined,
  });
}

/**
 * Wrap a transport as an `AccountMailer`: enforce the header-safety guard,
 * then hand the message to nodemailer with the configured sender identity.
 */
export function createTransportAccountMailer(
  transporter: Transporter,
  sender: SenderIdentity,
): AccountMailer {
  return {
    async deliver(email: AccountEmail): Promise<void> {
      assertSafeAccountEmail(email);
      await transporter.sendMail({
        from: { name: sender.name, address: sender.email },
        to: email.to,
        subject: email.subject,
        text: email.text,
      });
    },
  };
}
