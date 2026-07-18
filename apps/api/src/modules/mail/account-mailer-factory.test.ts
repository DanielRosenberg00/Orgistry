import { loadConfig } from '@orgistry/config';
import { describe, expect, it } from 'vitest';
import { createAccountMailer } from './account-mailer-factory';

/**
 * Driver selection is configuration-driven and deterministic. The production
 * rejections here are the factory's own second line of defense; the primary
 * guard (config refuses to load mailpit/memory in production at all) is
 * covered in packages/config/src/config.test.ts.
 */

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    JWT_SECRET: 'test-jwt-secret-value-1234',
    ...overrides,
  };
}

describe('createAccountMailer', () => {
  it('selects the mailpit driver from config', () => {
    const mailer = createAccountMailer(
      loadConfig(testEnv({ MAIL_DRIVER: 'mailpit' })),
    );
    expect(typeof mailer.deliver).toBe('function');
  });

  it('selects the in-memory driver from config', async () => {
    const mailer = createAccountMailer(
      loadConfig(testEnv({ MAIL_DRIVER: 'memory' })),
    );
    // The memory driver resolves without any socket work.
    await expect(
      mailer.deliver({ to: 'a@b.example', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
  });

  it('selects the smtp driver when fully configured', () => {
    const mailer = createAccountMailer(
      loadConfig(
        testEnv({
          MAIL_DRIVER: 'smtp',
          SMTP_HOST: 'smtp.provider.example-deployment.com',
          SMTP_USERNAME: 'orgistry-mailer',
          SMTP_PASSWORD: 'test-smtp-password-value-1234',
        }),
      ),
    );
    expect(typeof mailer.deliver).toBe('function');
  });

  it('refuses non-smtp drivers on a production-shaped config object', () => {
    // loadConfig cannot produce this state (the production guard rejects it),
    // so simulate a hand-built config: take a valid test config and flip the
    // production flag.
    for (const driver of ['mailpit', 'memory'] as const) {
      const config = loadConfig(testEnv({ MAIL_DRIVER: driver }));
      const productionShaped = { ...config, isProduction: true };
      expect(() => createAccountMailer(productionShaped)).toThrow(
        /Refusing to create/,
      );
    }
  });

  it('refuses an smtp selection without an smtp config block', () => {
    const config = loadConfig(testEnv({ MAIL_DRIVER: 'memory' }));
    const broken = {
      ...config,
      mail: { ...config.mail, driver: 'smtp' as const, smtp: undefined },
    };
    expect(() => createAccountMailer(broken)).toThrow(
      /without SMTP configuration/,
    );
  });
});
