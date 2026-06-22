import { loadWorkspaceEnv } from '@orgistry/shared/node';
import { requireDatabaseUrl } from '../src/env';
import { runMigrations } from '../src/migrator';

/**
 * CLI entry point for `pnpm db:migrate`.
 *
 * Applies the full migration baseline against `DATABASE_URL`. Safe to run
 * against an empty database (migration-from-scratch) and idempotent on an
 * already-migrated one.
 */
async function main(): Promise<void> {
  loadWorkspaceEnv();
  const url = requireDatabaseUrl();
  await runMigrations(url);
  console.log('Migrations applied successfully.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
