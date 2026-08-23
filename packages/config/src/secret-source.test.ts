import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './index';
import {
  FILE_BACKED_SECRET_NAMES,
  resolveSecretSources,
  SecretFileError,
  type SecretFileReader,
} from './secret-source';

// Every secret value in this file is a PUBLIC unit-test fixture. They are
// shaped like real secrets so the production guard treats them realistically,
// and they must never be used as real credentials.
const FAKE_JWT_SECRET = 'unit-test-jwt-secret-not-real-not-real-not-real';
const FAKE_SMTP_PASSWORD = 'unit-test-smtp-password-not-real';

/** A reader backed by an explicit path -> contents map; no filesystem. */
function fakeReader(files: Record<string, string>): SecretFileReader {
  return (filePath) => {
    const contents = files[filePath];
    if (contents === undefined) {
      throw new SecretFileError('does not exist or is not accessible to this process');
    }
    return contents;
  };
}

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    JWT_SECRET: 'test-jwt-secret-value-1234',
  };
}

/** Environment that satisfies the production guard, minus the JWT secret. */
function productionEnvWithoutJwtSecret(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://orgistry:orgistry@db.internal:5432/orgistry',
    COOKIE_SECURE: 'true',
    WEB_DEMO_URL: 'https://app.orgistry.example-deployment.com',
    MAIL_DRIVER: 'smtp',
    MAIL_FROM_EMAIL: 'no-reply@orgistry.example-deployment.com',
    SMTP_HOST: 'smtp.provider.example-deployment.com',
    SMTP_USERNAME: 'orgistry-mailer',
    SMTP_PASSWORD: FAKE_SMTP_PASSWORD,
  };
}

function loadIssues(
  env: Record<string, string | undefined>,
  readSecretFile?: SecretFileReader,
): string[] {
  try {
    loadConfig(env, { readSecretFile });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).issues;
  }
  expect.unreachable('loadConfig should have thrown');
}

describe('resolveSecretSources', () => {
  it('passes a direct environment value through untouched', () => {
    const { env, issues } = resolveSecretSources(
      { JWT_SECRET: FAKE_JWT_SECRET },
      fakeReader({}),
    );

    expect(issues).toEqual([]);
    expect(env.JWT_SECRET).toBe(FAKE_JWT_SECRET);
  });

  it('reads the configured file when only the _FILE variable is set', () => {
    const { env, issues } = resolveSecretSources(
      { JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': FAKE_JWT_SECRET }),
    );

    expect(issues).toEqual([]);
    expect(env.JWT_SECRET).toBe(FAKE_JWT_SECRET);
  });

  it('rejects an ambiguous configuration where both sources are set', () => {
    const { env, issues } = resolveSecretSources(
      { JWT_SECRET: FAKE_JWT_SECRET, JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': 'a-different-value' }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('both JWT_SECRET and JWT_SECRET_FILE are set');
    // Neither source wins: the value is dropped so nothing downstream can use it.
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('leaves the variable absent when neither source is set', () => {
    const { env, issues } = resolveSecretSources({}, fakeReader({}));

    expect(issues).toEqual([]);
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('treats a blank value or blank path as unset, not as a configured source', () => {
    const { env, issues } = resolveSecretSources(
      { JWT_SECRET: '   ', JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': FAKE_JWT_SECRET }),
    );

    // The blank direct value does not make this ambiguous.
    expect(issues).toEqual([]);
    expect(env.JWT_SECRET).toBe(FAKE_JWT_SECRET);

    const blankPath = resolveSecretSources(
      { JWT_SECRET: FAKE_JWT_SECRET, JWT_SECRET_FILE: '' },
      fakeReader({}),
    );
    expect(blankPath.issues).toEqual([]);
    expect(blankPath.env.JWT_SECRET).toBe(FAKE_JWT_SECRET);
  });

  it('strips exactly one terminal line ending and preserves everything else', () => {
    const files = {
      '/lf': `${FAKE_JWT_SECRET}\n`,
      '/crlf': `${FAKE_JWT_SECRET}\r\n`,
      '/double-lf': `${FAKE_JWT_SECRET}\n\n`,
      '/inner-space': `  ${FAKE_JWT_SECRET} with spaces  \n`,
      '/no-ending': FAKE_JWT_SECRET,
    };
    const read = fakeReader(files);
    const resolve = (path: string) =>
      resolveSecretSources({ JWT_SECRET_FILE: path }, read).env.JWT_SECRET;

    expect(resolve('/lf')).toBe(FAKE_JWT_SECRET);
    expect(resolve('/crlf')).toBe(FAKE_JWT_SECRET);
    // Only ONE line ending is removed; a second is part of the value.
    expect(resolve('/double-lf')).toBe(`${FAKE_JWT_SECRET}\n`);
    expect(resolve('/inner-space')).toBe(`  ${FAKE_JWT_SECRET} with spaces  `);
    expect(resolve('/no-ending')).toBe(FAKE_JWT_SECRET);
  });

  it('rejects an empty secret file', () => {
    const { env, issues } = resolveSecretSources(
      { JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': '\n' }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('is empty');
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('reports an unreadable file with the path but never the contents', () => {
    const { issues } = resolveSecretSources(
      { JWT_SECRET_FILE: '/run/secrets/missing' },
      fakeReader({}),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('JWT_SECRET_FILE');
    expect(issues[0]).toContain('/run/secrets/missing');
    expect(issues[0]).toContain('does not exist');
  });

  it('never mutates the source record', () => {
    const source = { JWT_SECRET_FILE: '/run/secrets/jwt' };
    resolveSecretSources(source, fakeReader({ '/run/secrets/jwt': FAKE_JWT_SECRET }));

    expect(source).toEqual({ JWT_SECRET_FILE: '/run/secrets/jwt' });
  });

  it('ignores _FILE variables outside the supported list', () => {
    // Unrelated tooling uses `*_FILE` names; resolution must not touch them.
    const { env, issues } = resolveSecretSources(
      { SSL_CERT_FILE: '/etc/ssl/cert.pem', JWT_SECRET: FAKE_JWT_SECRET },
      fakeReader({}),
    );

    expect(issues).toEqual([]);
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem');
  });

  it('supports every documented file-backed variable', () => {
    expect([...FILE_BACKED_SECRET_NAMES]).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'JWT_PREVIOUS_SECRET',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
    ]);

    for (const name of FILE_BACKED_SECRET_NAMES) {
      const { env, issues } = resolveSecretSources(
        { [`${name}${'_FILE'}`]: `/run/secrets/${name}` },
        fakeReader({ [`/run/secrets/${name}`]: `resolved-${name}` }),
      );
      expect(issues).toEqual([]);
      expect(env[name]).toBe(`resolved-${name}`);
    }
  });
});

describe('readSecretFileFromDisk (real filesystem)', () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'orgistry-secret-source-'));
    writeFileSync(join(directory, 'jwt_secret'), `${FAKE_JWT_SECRET}\n`);
    mkdirSync(join(directory, 'a-directory'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads config from a real mounted secret file', () => {
    const env = { ...baseEnv(), JWT_SECRET: undefined } as Record<
      string,
      string | undefined
    >;
    env.JWT_SECRET_FILE = join(directory, 'jwt_secret');

    // No reader injected: this exercises the real disk reader.
    const config = loadConfig(env);

    expect(config.auth.jwtSecret).toBe(FAKE_JWT_SECRET);
  });

  it('rejects a directory instead of a file', () => {
    const env = { ...baseEnv(), JWT_SECRET: undefined } as Record<
      string,
      string | undefined
    >;
    env.JWT_SECRET_FILE = join(directory, 'a-directory');

    const issues = loadIssues(env);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('is a directory, not a file');
  });

  it('rejects a nonexistent path', () => {
    const env = { ...baseEnv(), JWT_SECRET: undefined } as Record<
      string,
      string | undefined
    >;
    env.JWT_SECRET_FILE = join(directory, 'no-such-file');

    const issues = loadIssues(env);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('does not exist or is not accessible');
  });
});

describe('file-backed secrets are validated exactly like direct values', () => {
  it('applies the production guard to a file-loaded JWT_SECRET', () => {
    const issues = loadIssues(
      { ...productionEnvWithoutJwtSecret(), JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': 'dev-only-jwt-secret-change-me' }),
    );

    // The exact same rejections a direct value would receive: known dev
    // default, placeholder marker, and (for this value) the length floor.
    expect(issues.join('\n')).toContain(
      'JWT_SECRET is a known development-only default',
    );
    expect(issues.join('\n')).toContain('placeholder marker');
    // The rejected value is never echoed back.
    expect(issues.join('\n')).not.toContain('dev-only-jwt-secret-change-me');
  });

  it('applies the production length floor to a file-loaded JWT_SECRET', () => {
    const issues = loadIssues(
      { ...productionEnvWithoutJwtSecret(), JWT_SECRET_FILE: '/run/secrets/jwt' },
      fakeReader({ '/run/secrets/jwt': 'short-but-sixteen' }),
    );

    expect(issues.join('\n')).toContain(
      'JWT_SECRET must be at least 32 characters in production',
    );
  });

  it('applies the production credential guard to a file-loaded SMTP_PASSWORD', () => {
    const env = productionEnvWithoutJwtSecret();
    delete env.SMTP_PASSWORD;
    const issues = loadIssues(
      {
        ...env,
        JWT_SECRET: FAKE_JWT_SECRET,
        SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      },
      fakeReader({ '/run/secrets/smtp': 'placeholder-value' }),
    );

    expect(issues.join('\n')).toContain(
      'SMTP_PASSWORD contains the placeholder marker',
    );
    expect(issues.join('\n')).not.toContain('placeholder-value');
  });

  it('accepts a fully file-backed production configuration', () => {
    const env = productionEnvWithoutJwtSecret();
    delete env.SMTP_PASSWORD;
    const config = loadConfig(
      {
        ...env,
        JWT_SECRET_FILE: '/run/secrets/jwt',
        SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      },
      {
        readSecretFile: fakeReader({
          '/run/secrets/jwt': `${FAKE_JWT_SECRET}\n`,
          '/run/secrets/smtp': `${FAKE_SMTP_PASSWORD}\n`,
        }),
      },
    );

    expect(config.auth.jwtSecret).toBe(FAKE_JWT_SECRET);
    expect(config.mail.smtp?.password).toBe(FAKE_SMTP_PASSWORD);
  });

  it('still enforces the mailer completeness rules for file-backed credentials', () => {
    const env = productionEnvWithoutJwtSecret();
    delete env.SMTP_PASSWORD;
    const issues = loadIssues(
      { ...env, JWT_SECRET: FAKE_JWT_SECRET },
      fakeReader({}),
    );

    expect(issues.join('\n')).toContain(
      'SMTP_PASSWORD is required when MAIL_DRIVER=smtp',
    );
  });
});
