import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { defineConfig } from 'drizzle-kit';

// Load the workspace-root `.env` so `drizzle-kit` commands pick up DATABASE_URL
// without manual exports. `generate` works offline; only DB-touching commands
// consult these credentials.
loadWorkspaceEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/orgistry',
  },
});
