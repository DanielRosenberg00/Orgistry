import { defineConfig } from 'vitest/config';

/**
 * Integration test runner for the API package.
 *
 * Targets `*.integration.test.ts` (excluded from the root unit run). These
 * tests require live PostgreSQL + Redis and are run by `pnpm test:integration`
 * / CI. Workspace packages are consumed as TypeScript source, so they must be
 * transformed rather than externalized.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Integration suites share one PostgreSQL and each apply migrations, so
    // they must run sequentially — concurrent `CREATE SCHEMA` races on
    // PostgreSQL's namespace catalog.
    fileParallelism: false,
    server: {
      deps: {
        inline: [/^@orgistry\//],
      },
    },
  },
});
