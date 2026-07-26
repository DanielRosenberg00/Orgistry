import { loadConfig, type Config } from '@orgistry/config';
import type { FastifyServerOptions } from 'fastify';
import { buildApp } from '../app';
import type { RateLimiter } from '../lib/rate-limit';
import type { ReadinessProbe } from '../lib/readiness';

/** Valid configuration for tests — no real infrastructure is contacted. */
export function testConfig(
  overrides: Record<string, string> = {},
): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret-value-1234',
    // Tests must never open real SMTP sockets; suites that assert on delivery
    // inject the in-memory account mailer and inspect its captured messages.
    MAIL_DRIVER: 'memory',
    ...overrides,
  });
}

/**
 * PRODUCTION-SHAPED configuration for edge-behavior tests (HSTS, coarse
 * readiness, fail-closed limiters). The values satisfy the production config
 * guard but are public unit-test fixtures — never real credentials — and no
 * test using this config touches real SMTP, PostgreSQL, or Redis (`buildApp`
 * constructs no clients; services are injected).
 */
export function productionLikeTestConfig(
  overrides: Record<string, string> = {},
): Config {
  return loadConfig({
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
    ...overrides,
  });
}

/** A probe that always succeeds. */
export function passingProbe(name: string): ReadinessProbe {
  return { name, check: async () => {} };
}

/** A probe that always fails, simulating an unavailable dependency. */
export function failingProbe(name: string): ReadinessProbe {
  return {
    name,
    check: async () => {
      throw new Error(`${name} unavailable`);
    },
  };
}

export interface BuildTestAppOptions {
  /** Config override; defaults to `testConfig()`. */
  config?: Config;
  /** Store for the global per-IP rate limit; absent = no global limit. */
  globalRateLimiter?: RateLimiter;
  /** Logger override (defaults to disabled for clean test output). */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Build an app for injection tests. Logging is disabled to keep test output
 * clean; readiness probes default to healthy PostgreSQL + Redis.
 */
export function buildTestApp(
  probes: ReadinessProbe[] = [passingProbe('postgres'), passingProbe('redis')],
  options: BuildTestAppOptions = {},
) {
  return buildApp({
    config: options.config ?? testConfig(),
    readinessProbes: probes,
    globalRateLimiter: options.globalRateLimiter,
    logger: options.logger ?? false,
  });
}
