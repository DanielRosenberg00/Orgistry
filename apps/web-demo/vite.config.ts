import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // `@orgistry/contracts` is consumed as TypeScript source from the workspace,
  // so it must not be pre-bundled as an external dependency.
  optimizeDeps: {
    exclude: ['@orgistry/contracts'],
  },
});
