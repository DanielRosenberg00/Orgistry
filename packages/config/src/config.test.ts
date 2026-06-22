import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './index';

/** Minimal valid environment used as a base for each case. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    JWT_SECRET: 'test-jwt-secret-value-1234',
    COOKIE_SECRET: 'test-cookie-secret-value-1234',
  };
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

  it('throws a ConfigValidationError when a required secret is missing', () => {
    const env = baseEnv();
    delete env.JWT_SECRET;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('reports every invalid value, not just the first', () => {
    try {
      loadConfig({
        NODE_ENV: 'staging',
        DATABASE_URL: 'not-a-url',
        JWT_SECRET: 'short',
        COOKIE_SECRET: 'short',
      });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
