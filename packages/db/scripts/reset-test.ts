import { loadWorkspaceEnv } from '@orgistry/shared/node';
import postgres from 'postgres';
import { requireTestDatabaseUrl } from '../src/env';
import { runMigrations } from '../src/migrator';

/**
 * CLI entry point for `pnpm db:reset:test`.
 *
 * Drops and recreates the `public` schema on the TEST database, then re-applies
 * the migration baseline — giving suites a clean, fully-migrated database.
 * Guarded by `requireTestDatabaseUrl` (NODE_ENV=test + explicit
 * TEST_DATABASE_URL) so it can never run against dev/prod.
 */
async function main(): Promise<void> {
  loadWorkspaceEnv();
  const url = requireTestDatabaseUrl();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Drop `public` (app tables) AND `drizzle` (migration history) so the
    // baseline re-applies in full — dropping only `public` would leave Drizzle
    // believing migrations were already applied and skip recreating tables.
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }

  await runMigrations(url);
  console.log('Test database reset and migrated.');
}

main().catch((error) => {
  console.error('Test reset failed:', error);
  process.exitCode = 1;
});
