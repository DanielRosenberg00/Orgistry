import { loadConfig, type Config } from '@orgistry/config';
import { buildApp } from '../app';
import type { ReadinessProbe } from '../lib/readiness';

/** Valid configuration for tests — no real infrastructure is contacted. */
export function testConfig(): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://orgistry:orgistry@localhost:5432/orgistry_test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret-value-1234',
    COOKIE_SECRET: 'test-cookie-secret-value-1234',
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

/**
 * Build an app for injection tests. Logging is disabled to keep test output
 * clean; readiness probes default to healthy PostgreSQL + Redis.
 */
export function buildTestApp(
  probes: ReadinessProbe[] = [passingProbe('postgres'), passingProbe('redis')],
) {
  return buildApp({
    config: testConfig(),
    readinessProbes: probes,
    logger: false,
  });
}
