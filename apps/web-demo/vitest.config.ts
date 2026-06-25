import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Web demo test runner.
 *
 * Component/route-level smoke tests run under jsdom. The root workspace runner
 * (`vitest run` at the repo root) deliberately scopes itself to API + package
 * `*.test.ts` files, so these `.test.tsx` suites run via the web-demo package
 * script (`pnpm --filter @orgistry/web-demo test`). `@orgistry/contracts` is
 * consumed as TypeScript source, so it is inlined for transformation.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    server: {
      deps: {
        inline: [/^@orgistry\//],
      },
    },
  },
});
