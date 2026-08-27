import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  loadConfig,
  TRUST_PROXY_MAX_HOPS,
} from './index';

// Every case builds its own explicit env record and passes it to `loadConfig`
// directly — `process.env` is never read or mutated, so cases cannot leak
// state into each other and the suite is order-independent.

/** Minimal valid environment used as a base for each case. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    JWT_SECRET: 'test-jwt-secret-value-1234',
  };
}

/**
 * Minimal environment that satisfies the production guard. The JWT secret and
 * SMTP password are generated-STYLE unit-test fixtures — they are public in
 * this repository and must never be used as real credentials. Sprint 16 adds
 * the mail requirements: smtp driver, real-shaped credentials, a deliverable
 * sender, and an https public web URL.
 */
function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://orgistry:orgistry@db.internal:5432/orgistry',
    JWT_SECRET: 'test-suite-jwt-secret-not-real-not-real-not-real',
    COOKIE_SECURE: 'true',
    WEB_DEMO_URL: 'https://app.orgistry.example-deployment.com',
    MAIL_DRIVER: 'smtp',
    MAIL_FROM_EMAIL: 'no-reply@orgistry.example-deployment.com',
    SMTP_HOST: 'smtp.provider.example-deployment.com',
    SMTP_USERNAME: 'orgistry-mailer',
    SMTP_PASSWORD: 'test-suite-smtp-password-not-real',
  };
}

/** Load an env expected to fail and return the reported issues. */
function loadIssues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).issues;
  }
  expect.unreachable('loadConfig should have thrown');
}

describe('loadConfig', () => {
  it('applies documented defaults when only required values are set', () => {
    const config = loadConfig(baseEnv());

    expect(config.api.host).toBe('0.0.0.0');
    expect(config.api.port).toBe(3000);
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.mailpit.smtpPort).toBe(1025);
    expect(config.rateLimit.max).toBe(300);
    expect(config.auth.cookieSecure).toBe(false);
    // Sprint 19 edge defaults: no proxy trust, open failure mode outside
    // production, HSTS lifetime present for the production header.
    expect(config.api.trustProxy).toBe(false);
    expect(config.rateLimit.failureMode).toBe('open');
    expect(config.security.hstsMaxAgeSeconds).toBe(15_552_000);
    expect(config.rateLimit.external.authFailEventsPerIpMax).toBe(10);
    expect(config.rateLimit.invitations.inspectPerIpMax).toBe(30);
    expect(config.rateLimit.mutations.orgCreatePerUserMax).toBe(10);
  });

  it('parses TRUST_PROXY into its typed forms', () => {
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: 'false' }).api.trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '1' }).api.trustProxy).toBe(1);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '2' }).api.trustProxy).toBe(2);
    // The documented ceiling itself is accepted…
    expect(
      loadConfig({ ...baseEnv(), TRUST_PROXY: String(TRUST_PROXY_MAX_HOPS) }).api
        .trustProxy,
    ).toBe(TRUST_PROXY_MAX_HOPS);
  });

  it.each([
    ['one above the documented maximum', String(TRUST_PROXY_MAX_HOPS + 1)],
    ['a decimal hop count', '1.5'],
    ['scientific notation', '1e3'],
    ['a value above Number.MAX_SAFE_INTEGER', '9007199254740993'],
    ['an extremely long numeric string', '9'.repeat(64)],
  ])('rejects %s as a hop count', (_label, raw) => {
    const issues = loadIssues({ ...baseEnv(), TRUST_PROXY: raw });
    expect(issues.join('\n')).toContain('TRUST_PROXY');
    expect(issues.join('\n')).toContain(`between 1 and ${TRUST_PROXY_MAX_HOPS}`);
  });

  it.each([
    ['a single IPv4 address', '127.0.0.1', ['127.0.0.1']],
    ['an IPv4 CIDR', '10.0.0.0/8', ['10.0.0.0/8']],
    ['a single IPv6 address', '::1', ['::1']],
    ['an IPv6 CIDR', '2001:db8::/32', ['2001:db8::/32']],
    [
      'a mixed IPv4/IPv6/CIDR list with spacing',
      '10.0.0.0/8, 172.16.0.0/12, ::1, 2001:db8::/32, 192.0.2.7',
      ['10.0.0.0/8', '172.16.0.0/12', '::1', '2001:db8::/32', '192.0.2.7'],
    ],
    ['edge prefixes 0 and 32 (IPv4)', '0.0.0.0/0,10.1.2.3/32', ['0.0.0.0/0', '10.1.2.3/32']],
    ['edge prefix 128 (IPv6)', '2001:db8::1/128', ['2001:db8::1/128']],
  ])('accepts %s as a semantic proxy list', (_label, raw, expected) => {
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: raw }).api.trustProxy).toEqual(
      expected,
    );
  });

  it.each([
    ['the literal true (unbounded trust)', 'true'],
    ['zero hops', '0'],
    ['a negative hop count', '-1'],
    ['a hostname', 'localhost'],
    ['a dotted hostname', 'proxy.internal'],
    ['out-of-range IPv4 octets', '999.999.999.999'],
    ['an IPv4 prefix above 32', '10.0.0.1/33'],
    ['an IPv6 prefix above 128', '2001:db8::/129'],
    ['ambiguous colon junk', '::::'],
    ['an empty entry between commas', '10.0.0.0/8,,192.0.2.1'],
    ['a trailing comma', '10.0.0.0/8,'],
    ['a leading comma', ',10.0.0.0/8'],
    ['a zero-padded prefix', '10.0.0.0/08'],
    ['a CIDR with a hostname address', 'proxy.internal/8'],
    ['a non-numeric prefix', '10.0.0.0/abc'],
  ])('rejects %s at configuration load', (_label, raw) => {
    const issues = loadIssues({ ...baseEnv(), TRUST_PROXY: raw });
    expect(issues.join('\n')).toContain('TRUST_PROXY');
  });

  it('derives the rate-limit failure mode from the environment', () => {
    expect(loadConfig(baseEnv()).rateLimit.failureMode).toBe('open');
    expect(
      loadConfig({ ...baseEnv(), RATE_LIMIT_FAILURE_MODE: 'closed' }).rateLimit
        .failureMode,
    ).toBe('closed');
  });

  it('distinguishes test mode from local development mode', () => {
    const testConfig = loadConfig({ ...baseEnv(), NODE_ENV: 'test' });
    const localConfig = loadConfig({ ...baseEnv(), NODE_ENV: 'development' });

    expect(testConfig.isTest).toBe(true);
    expect(testConfig.isProduction).toBe(false);
    expect(localConfig.isTest).toBe(false);
    expect(localConfig.isProduction).toBe(false);
  });

  it('coerces numeric and boolean env strings into typed values', () => {
    const config = loadConfig({
      ...baseEnv(),
      API_PORT: '8080',
      COOKIE_SECURE: 'true',
      RATE_LIMIT_MAX: '500',
    });

    expect(config.api.port).toBe(8080);
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.rateLimit.max).toBe(500);
  });

  it('parses CORS origins into a trimmed list', () => {
    const config = loadConfig({
      ...baseEnv(),
      CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
    });

    expect(config.cors.origins).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
  });

  it('derives refresh-cookie attributes and the CSRF header from env', () => {
    const config = loadConfig({ ...baseEnv(), COOKIE_SECURE: 'true' });
    expect(config.auth.refreshCookie).toMatchObject({
      name: 'orgistry_rt',
      path: '/v1/auth',
      sameSite: 'lax',
      httpOnly: true,
      secure: true,
    });
    expect(config.auth.refreshCookie.maxAgeSeconds).toBe(
      config.auth.refreshTokenTtlSeconds,
    );
    // The CSRF header is normalized to lowercase to match Fastify's headers.
    expect(config.auth.csrfHeaderName).toBe('x-orgistry-csrf');
  });

  it('exposes per-bucket auth rate limits with sane defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.rateLimit.auth).toMatchObject({
      windowSeconds: 60,
      loginPerIpMax: 10,
      loginPerEmailMax: 5,
      refreshPerSessionMax: 60,
      refreshPerIpMax: 120,
    });
  });

  it('exposes the verification-first registration knobs with sane defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.registration.completionTtlSeconds).toBe(86_400);
    expect(config.rateLimit.registration).toMatchObject({
      windowSeconds: 60,
      requestPerIpMax: 5,
      requestPerEmailMax: 3,
      completePerIpMax: 10,
      completePerTokenMax: 5,
      existingAccountNoticePerEmailMax: 1,
    });
  });

  it('throws a ConfigValidationError when a required secret is missing', () => {
    const env = baseEnv();
    delete env.JWT_SECRET;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('reports every invalid value, not just the first', () => {
    const issues = loadIssues({
      NODE_ENV: 'staging',
      DATABASE_URL: 'not-a-url',
      JWT_SECRET: 'short',
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts the documented .env.example defaults in development', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry',
      JWT_SECRET: 'dev-only-jwt-secret-change-me',
      COOKIE_SECURE: 'false',
    });
    expect(config.isProduction).toBe(false);
    expect(config.auth.jwtSecret).toBe('dev-only-jwt-secret-change-me');
  });

  it('does not require COOKIE_SECRET and does not expose a cookieSecret', () => {
    // COOKIE_SECRET was removed in Sprint 15 (ORG-PR-047): no code path signs
    // cookies, so requiring the secret only implied protection that did not
    // exist. A stale value in an operator's .env is ignored, not an error.
    const config = loadConfig({
      ...baseEnv(),
      COOKIE_SECRET: 'stale-value-from-an-old-env-file',
    });
    expect(Object.keys(config.auth)).not.toContain('cookieSecret');
  });
});

describe('production configuration guard (NODE_ENV=production)', () => {
  it('accepts a generated-style secret with COOKIE_SECURE=true', () => {
    const config = loadConfig(productionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.auth.refreshCookie.secure).toBe(true);
  });

  it('defaults the rate-limit failure mode to closed in production', () => {
    expect(loadConfig(productionEnv()).rateLimit.failureMode).toBe('closed');
  });

  it('rejects an explicit RATE_LIMIT_FAILURE_MODE=open in production', () => {
    const issues = loadIssues({
      ...productionEnv(),
      RATE_LIMIT_FAILURE_MODE: 'open',
    });
    expect(issues.join('\n')).toContain('RATE_LIMIT_FAILURE_MODE');
    expect(issues.join('\n')).toContain('fail closed');
  });

  it('rejects the known development-default JWT_SECRET', () => {
    const issues = loadIssues({
      ...productionEnv(),
      JWT_SECRET: 'dev-only-jwt-secret-change-me',
    });
    expect(issues.some((issue) => issue.includes('JWT_SECRET'))).toBe(true);
    expect(issues.join('\n')).toContain('development-only default');
  });

  it('rejects the test-fixture and CI JWT secrets', () => {
    for (const knownSecret of [
      'test-jwt-secret-value-1234',
      'ci-jwt-secret-value-1234',
    ]) {
      const issues = loadIssues({ ...productionEnv(), JWT_SECRET: knownSecret });
      expect(issues.join('\n')).toContain('development-only default');
    }
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    const issues = loadIssues({
      ...productionEnv(),
      // 31 chars, otherwise unremarkable.
      JWT_SECRET: 'short-testing-secret-31-chars-x',
    });
    expect(issues.some((issue) => issue.includes('JWT_SECRET'))).toBe(true);
    expect(issues.join('\n')).toContain('at least 32 characters');
  });

  it('rejects a placeholder-style JWT_SECRET regardless of length', () => {
    const issues = loadIssues({
      ...productionEnv(),
      JWT_SECRET: 'please-CHANGE-ME-before-launch-0123456789abcdef',
    });
    expect(issues.join('\n')).toContain('placeholder');
    expect(issues.join('\n')).toContain('JWT_SECRET');
  });

  it('rejects an obviously degenerate repeated-character JWT_SECRET', () => {
    const issues = loadIssues({
      ...productionEnv(),
      JWT_SECRET: 'a'.repeat(64),
    });
    expect(issues.join('\n')).toContain('single repeated character');
  });

  it('rejects COOKIE_SECURE=false, naming the field', () => {
    const issues = loadIssues({ ...productionEnv(), COOKIE_SECURE: 'false' });
    expect(issues.some((issue) => issue.includes('COOKIE_SECURE'))).toBe(true);
  });

  it('rejects an unset COOKIE_SECURE (the false default is not coerced)', () => {
    const env = productionEnv();
    delete env.COOKIE_SECURE;
    const issues = loadIssues(env);
    expect(issues.some((issue) => issue.includes('COOKIE_SECURE'))).toBe(true);
  });

  it('never echoes the rejected secret value in the error message', () => {
    const rejectedSecret = 'please-CHANGE-ME-before-launch-0123456789abcdef';
    const issues = loadIssues({ ...productionEnv(), JWT_SECRET: rejectedSecret });
    expect(issues.join('\n')).not.toContain(rejectedSecret);
  });

  it('does not apply production rules in development or test mode', () => {
    for (const nodeEnv of ['development', 'test']) {
      const config = loadConfig({
        ...baseEnv(),
        NODE_ENV: nodeEnv,
        JWT_SECRET: 'dev-only-jwt-secret-change-me',
        COOKIE_SECURE: 'false',
      });
      expect(config.isProduction).toBe(false);
    }
  });
});

describe('mailer configuration (driver-aware, Sprint 16)', () => {
  it('defaults to the mailpit driver with local-only sender identity', () => {
    const config = loadConfig(baseEnv());
    expect(config.mail.driver).toBe('mailpit');
    expect(config.mail.fromEmail).toBe('no-reply@orgistry.local');
    expect(config.mail.fromName).toBe('Orgistry');
    expect(config.mail.timeoutMs).toBe(10_000);
    expect(config.mail.smtp).toBeUndefined();
    expect(config.emailVerification.ttlSeconds).toBe(86_400);
  });

  it('never requires provider credentials for the mailpit driver', () => {
    // Local development must work with only the .env.example values.
    const config = loadConfig({ ...baseEnv(), MAIL_DRIVER: 'mailpit' });
    expect(config.mail.driver).toBe('mailpit');
    expect(config.mail.smtp).toBeUndefined();
  });

  it('never requires provider credentials for the memory driver', () => {
    const config = loadConfig({ ...baseEnv(), MAIL_DRIVER: 'memory' });
    expect(config.mail.driver).toBe('memory');
    expect(config.mail.smtp).toBeUndefined();
  });

  it('requires host, username, and password when the smtp driver is selected', () => {
    const issues = loadIssues({ ...baseEnv(), MAIL_DRIVER: 'smtp' });
    for (const field of ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD']) {
      expect(issues.some((issue) => issue.includes(field))).toBe(true);
    }
  });

  it('populates the smtp block only for the smtp driver', () => {
    const config = loadConfig({
      ...baseEnv(),
      MAIL_DRIVER: 'smtp',
      SMTP_HOST: 'smtp.provider.example-deployment.com',
      SMTP_USERNAME: 'orgistry-mailer',
      SMTP_PASSWORD: 'test-smtp-password-value-1234',
    });
    expect(config.mail.smtp).toEqual({
      host: 'smtp.provider.example-deployment.com',
      port: 465,
      username: 'orgistry-mailer',
      password: 'test-smtp-password-value-1234',
    });
  });

  it('rejects an unknown mail driver', () => {
    const issues = loadIssues({ ...baseEnv(), MAIL_DRIVER: 'sendmail' });
    expect(issues.some((issue) => issue.includes('MAIL_DRIVER'))).toBe(true);
  });

  it('rejects a malformed sender address', () => {
    const issues = loadIssues({ ...baseEnv(), MAIL_FROM_EMAIL: 'not-an-email' });
    expect(issues.some((issue) => issue.includes('MAIL_FROM_EMAIL'))).toBe(true);
  });

  it('exposes the email-verification rate-limit buckets with sane defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.rateLimit.emailVerification).toEqual({
      windowSeconds: 60,
      requestPerUserMax: 3,
      requestPerIpMax: 10,
      completePerIpMax: 10,
    });
  });
});

describe('production mailer guard (NODE_ENV=production, Sprint 16)', () => {
  it('accepts a fully configured smtp driver', () => {
    const config = loadConfig(productionEnv());
    expect(config.mail.driver).toBe('smtp');
    expect(config.mail.smtp?.port).toBe(465);
  });

  it('accepts an isolated non-provider SMTP endpoint (the staging-like deployment model)', () => {
    // Sprint 27 (ORG-PR-001) depends on this: a staging-like target must be
    // able to run with NODE_ENV=production — which is what activates every
    // guard in this file — WITHOUT a production email provider, and therefore
    // without ORG-PR-002 being closed. The production rules constrain the
    // DRIVER (never a local sink), the CREDENTIAL (never a placeholder), and
    // the SENDER (never a reserved domain). They deliberately do not constrain
    // the endpoint's identity, so an operator-run sink reachable only from the
    // deployment network is a valid production-mode configuration.
    //
    // This is NOT evidence of email-provider validation: nothing here proves
    // the endpoint exists, accepts the credential, or delivers anything.
    // ORG-PR-002 owns that and stays open.
    const config = loadConfig({
      ...productionEnv(),
      SMTP_HOST: 'mail-sink.orgistry-staging.internal',
      SMTP_PORT: '465',
    });
    expect(config.mail.driver).toBe('smtp');
    expect(config.mail.smtp?.host).toBe('mail-sink.orgistry-staging.internal');
  });

  it('rejects the mailpit driver in production', () => {
    const issues = loadIssues({ ...productionEnv(), MAIL_DRIVER: 'mailpit' });
    expect(issues.join('\n')).toContain('MAIL_DRIVER must be "smtp"');
  });

  it('rejects the memory driver in production', () => {
    const issues = loadIssues({ ...productionEnv(), MAIL_DRIVER: 'memory' });
    expect(issues.join('\n')).toContain('MAIL_DRIVER must be "smtp"');
  });

  it('rejects the implicit default driver in production (no silent Mailpit)', () => {
    const env = productionEnv();
    delete env.MAIL_DRIVER;
    const issues = loadIssues(env);
    expect(issues.join('\n')).toContain('MAIL_DRIVER must be "smtp"');
  });

  it('rejects missing production SMTP credentials', () => {
    const env = productionEnv();
    delete env.SMTP_PASSWORD;
    const issues = loadIssues(env);
    expect(issues.some((issue) => issue.includes('SMTP_PASSWORD'))).toBe(true);
  });

  it('rejects a placeholder-style SMTP_PASSWORD', () => {
    const issues = loadIssues({
      ...productionEnv(),
      SMTP_PASSWORD: 'please-CHANGE-ME-later',
    });
    expect(issues.join('\n')).toContain('SMTP_PASSWORD');
    expect(issues.join('\n')).toContain('placeholder');
  });

  it('does not impose the generated-secret length floor on SMTP_PASSWORD', () => {
    // Provider-issued credentials can legitimately be short; only obvious
    // non-secrets are refused.
    const config = loadConfig({
      ...productionEnv(),
      SMTP_PASSWORD: 'Zk8fQ2wLp9',
    });
    expect(config.mail.smtp?.password).toBe('Zk8fQ2wLp9');
  });

  it('rejects the local-only default sender in production', () => {
    const issues = loadIssues({
      ...productionEnv(),
      MAIL_FROM_EMAIL: 'no-reply@orgistry.local',
    });
    expect(issues.join('\n')).toContain('MAIL_FROM_EMAIL');
  });

  it('rejects reserved-domain senders in production', () => {
    for (const sender of [
      'no-reply@orgistry.test',
      'no-reply@example.com',
      'no-reply@mail.invalid',
    ]) {
      const issues = loadIssues({ ...productionEnv(), MAIL_FROM_EMAIL: sender });
      expect(issues.join('\n')).toContain('MAIL_FROM_EMAIL');
    }
  });

  it('rejects a localhost or plain-HTTP public web URL in production', () => {
    for (const url of ['http://localhost:5173', 'http://app.orgistry.example-deployment.com']) {
      const issues = loadIssues({ ...productionEnv(), WEB_DEMO_URL: url });
      expect(issues.some((issue) => issue.includes('WEB_DEMO_URL'))).toBe(true);
    }
  });

  it('never echoes a rejected SMTP password in the error message', () => {
    const rejectedSecret = 'smtp-placeholder-password';
    const issues = loadIssues({
      ...productionEnv(),
      SMTP_PASSWORD: rejectedSecret,
    });
    expect(issues.join('\n')).not.toContain(rejectedSecret);
  });
});

describe('access-token secret rotation config (Sprint 24)', () => {
  // Public unit-test fixtures shaped like generated secrets; never real.
  const RETIRING_SECRET = 'test-suite-jwt-secret-PREVIOUS-not-real-not-real';

  it('leaves the previous secret absent by default', () => {
    expect(loadConfig(baseEnv()).auth.previousJwtSecret).toBeUndefined();
  });

  it('exposes a configured previous secret alongside the current one', () => {
    const config = loadConfig({
      ...baseEnv(),
      JWT_PREVIOUS_SECRET: RETIRING_SECRET,
    });

    expect(config.auth.jwtSecret).toBe('test-jwt-secret-value-1234');
    expect(config.auth.previousJwtSecret).toBe(RETIRING_SECRET);
  });

  it('rejects a previous secret equal to the current one, in every mode', () => {
    // A no-op "rotation" is refused everywhere, not just in production.
    const currentSecret = 'test-suite-jwt-secret-CURRENT-not-real-not-real';
    for (const env of [baseEnv(), productionEnv()]) {
      const issues = loadIssues({
        ...env,
        JWT_SECRET: currentSecret,
        JWT_PREVIOUS_SECRET: currentSecret,
      });
      expect(issues.join('\n')).toContain(
        'JWT_PREVIOUS_SECRET must not equal JWT_SECRET',
      );
    }
  });

  it('applies the base length floor to the previous secret', () => {
    const issues = loadIssues({ ...baseEnv(), JWT_PREVIOUS_SECRET: 'too-short' });
    expect(issues.join('\n')).toContain(
      'JWT_PREVIOUS_SECRET must be at least 16 characters',
    );
  });

  it('holds the previous secret to the production rules of the current one', () => {
    const rejections: [string, string][] = [
      ['dev-only-jwt-secret-change-me', 'known development-only default'],
      ['still-a-short-secret-123456789', 'at least 32 characters'],
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'single repeated character'],
      ['please-replace-me-0123456789abcdefghij', 'placeholder marker'],
    ];

    for (const [secret, expectedMessage] of rejections) {
      const issues = loadIssues({
        ...productionEnv(),
        JWT_PREVIOUS_SECRET: secret,
      });
      const previousSecretIssues = issues.filter((issue) =>
        issue.startsWith('JWT_PREVIOUS_SECRET'),
      );
      expect(previousSecretIssues.join('\n')).toContain(expectedMessage);
      expect(issues.join('\n')).not.toContain(secret);
    }
  });

  it('accepts a valid rotation pair in production', () => {
    const config = loadConfig({
      ...productionEnv(),
      JWT_PREVIOUS_SECRET: RETIRING_SECRET,
    });

    expect(config.auth.previousJwtSecret).toBe(RETIRING_SECRET);
  });
});

describe('data retention configuration (Sprint 25)', () => {
  it('exposes documented defaults when nothing is set', () => {
    const config = loadConfig(baseEnv());

    expect(config.retention).toEqual({
      securityEventDays: 180,
      expiredAuthTokenDays: 30,
      endedSessionDays: 90,
      cleanupBatchSize: 1000,
    });
  });

  it('accepts explicit operator values', () => {
    const config = loadConfig({
      ...baseEnv(),
      RETENTION_SECURITY_EVENT_DAYS: '365',
      RETENTION_EXPIRED_AUTH_TOKEN_DAYS: '14',
      RETENTION_ENDED_SESSION_DAYS: '30',
      RETENTION_CLEANUP_BATCH_SIZE: '5000',
    });

    expect(config.retention).toEqual({
      securityEventDays: 365,
      expiredAuthTokenDays: 14,
      endedSessionDays: 30,
      cleanupBatchSize: 5000,
    });
  });

  it('rejects zero and negative retention windows', () => {
    // A window of 0 would make `cutoff = now`, putting live rows in scope; a
    // negative window would push the cutoff into the FUTURE and make every
    // row eligible. Both must fail the process, not widen the predicate.
    const dangerous = [
      ['RETENTION_SECURITY_EVENT_DAYS', '0'],
      ['RETENTION_SECURITY_EVENT_DAYS', '-1'],
      ['RETENTION_EXPIRED_AUTH_TOKEN_DAYS', '0'],
      ['RETENTION_EXPIRED_AUTH_TOKEN_DAYS', '-30'],
      ['RETENTION_ENDED_SESSION_DAYS', '0'],
      ['RETENTION_ENDED_SESSION_DAYS', '-7'],
    ] as const;

    for (const [name, value] of dangerous) {
      expect(
        () => loadConfig({ ...baseEnv(), [name]: value }),
        `${name}=${value} must be rejected`,
      ).toThrow(ConfigValidationError);
    }
  });

  it('rejects windows below the documented minimum safe retention', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), RETENTION_SECURITY_EVENT_DAYS: '29' }),
    ).toThrow(/at least 30 days/);
    expect(() =>
      loadConfig({ ...baseEnv(), RETENTION_ENDED_SESSION_DAYS: '6' }),
    ).toThrow(/at least 7 days/);
  });

  it('rejects a batch size outside 1..50000', () => {
    for (const value of ['0', '-1', '50001']) {
      expect(
        () => loadConfig({ ...baseEnv(), RETENTION_CLEANUP_BATCH_SIZE: value }),
        `RETENTION_CLEANUP_BATCH_SIZE=${value} must be rejected`,
      ).toThrow(ConfigValidationError);
    }
    expect(
      loadConfig({ ...baseEnv(), RETENTION_CLEANUP_BATCH_SIZE: '50000' }).retention
        .cleanupBatchSize,
    ).toBe(50000);
  });

  it('rejects a non-numeric window without falling back to the default', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), RETENTION_SECURITY_EVENT_DAYS: 'forever' }),
    ).toThrow(ConfigValidationError);
  });

  it('keeps the default security-event window above the largest plan audit retention', () => {
    // The seeded plan catalog advertises at most 90 days of audit retention
    // (`plans.audit_retention_days`, migration 0005). The default cleanup
    // window must not delete history a plan promises to keep.
    expect(loadConfig(baseEnv()).retention.securityEventDays).toBeGreaterThan(90);
  });
});
