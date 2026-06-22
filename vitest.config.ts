import { defineConfig } from 'vitest/config';

// Single root test runner for the whole workspace.
//
// Workspace packages are symlinked into node_modules as `@orgistry/*` and their
// `exports` point directly at TypeScript source. `server.deps.inline` forces
// Vitest to transform that source instead of trying to load it as a built
// CommonJS/ESM dependency. Integration tests that require live infrastructure
// use the `*.integration.test.ts` suffix and are excluded from the default run.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    server: {
      deps: {
        inline: [/^@orgistry\//],
      },
    },
  },
});
