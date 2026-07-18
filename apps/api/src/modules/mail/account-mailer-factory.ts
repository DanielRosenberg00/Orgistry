import type { Config } from '@orgistry/config';
import type { AccountMailer } from './account-mailer';
import { createMailpitAccountMailer } from './mailpit-account-mailer';
import { createSmtpAccountMailer } from './smtp-account-mailer';
import { createInMemoryAccountMailer } from './testing/in-memory-account-mailer';

/**
 * Deterministic, configuration-driven mailer selection (Sprint 16).
 *
 * The driver comes exclusively from validated config (`MAIL_DRIVER`) — there
 * is no environment sniffing and no fallback chain. The config layer already
 * fails closed in production (only `smtp` loads); the checks here are a
 * second, independent line of defense so even a hand-built `Config` object
 * cannot wire a dev sink into a production process.
 */
export function createAccountMailer(config: Config): AccountMailer {
  if (config.isProduction && config.mail.driver !== 'smtp') {
    throw new Error(
      `Refusing to create the "${config.mail.driver}" account mailer in production; only the smtp driver is allowed`,
    );
  }

  const sender = { email: config.mail.fromEmail, name: config.mail.fromName };

  switch (config.mail.driver) {
    case 'mailpit':
      return createMailpitAccountMailer({
        host: config.mailpit.host,
        port: config.mailpit.smtpPort,
        sender,
        timeoutMs: config.mail.timeoutMs,
      });
    case 'smtp': {
      const smtp = config.mail.smtp;
      if (!smtp) {
        // Unreachable through loadConfig (mail-policy.ts requires the block
        // for the smtp driver); guards hand-built Config objects.
        throw new Error(
          'Refusing to create the smtp account mailer without SMTP configuration',
        );
      }
      return createSmtpAccountMailer({
        host: smtp.host,
        port: smtp.port,
        username: smtp.username,
        password: smtp.password,
        sender,
        timeoutMs: config.mail.timeoutMs,
      });
    }
    case 'memory':
      return createInMemoryAccountMailer();
  }
}
