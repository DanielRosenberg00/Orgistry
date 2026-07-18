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
 * Mailpit / local development driver.
 *
 * Delivers over plaintext SMTP to the local Mailpit container (no auth, no
 * TLS — Mailpit is a local dev sink; see infra/docker-compose.yml). Delivered
 * messages are visible in the Mailpit web UI. Never selected in production:
 * the config production guard rejects MAIL_DRIVER=mailpit outright.
 */

export interface MailpitAccountMailerOptions {
  host: string;
  port: number;
  sender: SenderIdentity;
  timeoutMs: number;
}

export function createMailpitAccountMailer(
  options: MailpitAccountMailerOptions,
): AccountMailer {
  assertSafeSenderIdentity(options.sender);
  const transporter = createAccountSmtpTransport({
    host: options.host,
    port: options.port,
    secureTransport: false,
    timeoutMs: options.timeoutMs,
  });
  return createTransportAccountMailer(transporter, options.sender);
}
