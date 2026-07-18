import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './index';

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
 * Minimal environment that satisfies the production guard. The JWT secret is a
 * generated-STYLE unit-test fixture (48 hex chars) — it is public in this
 * repository and must never be used as a real credential.
 */
function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://orgistry:orgistry@db.internal:5432/orgistry',
    JWT_SECRET: '4f1c9b2e7a8d3c6f5e0b9a4d7c2f8e1b6a3d0c5f9e2b7a4d',
    COOKIE_SECURE: 'true',
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
    expect(config.rateLimit.max).toBe(100);
    expect(config.auth.cookieSecure).toBe(false);
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
      registerPerIpMax: 5,
      refreshPerSessionMax: 60,
      refreshPerIpMax: 120,
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
      JWT_SECRET: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
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
