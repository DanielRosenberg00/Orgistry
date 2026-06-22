import { defineConfig } from 'vitest/config';

/**
 * Integration test runner for the db package.
 *
 * Unlike the root config (which excludes `*.integration.test.ts`), this config
 * targets them explicitly. These tests require a live PostgreSQL reachable via
 * TEST_DATABASE_URL or DATABASE_URL and are run by `pnpm test:integration` / CI.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
  },
});
