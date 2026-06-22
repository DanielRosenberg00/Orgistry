import { loadWorkspaceEnv } from '@orgistry/shared/node';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrator';

// Integration entry point: load the root `.env` so this runs locally with only
// `cp .env.example .env`. CI sets these variables directly (no `.env` present).
loadWorkspaceEnv();

/**
 * Migration-from-scratch integration test.
 *
 * Requires a reachable, disposable PostgreSQL database. It is EXCLUDED from the
 * default `pnpm test` run (filename suffix `*.integration.test.ts`) and is run
 * by `pnpm test:integration` / CI with infrastructure up.
 *
 * Set `TEST_DATABASE_URL` (preferred) or `DATABASE_URL`. When neither is set
 * the suite is skipped with a clear warning rather than silently passing.
 */
const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[db] Skipping migrate.integration.test.ts: set TEST_DATABASE_URL or DATABASE_URL with a live PostgreSQL to run it.',
  );
}

describe.skipIf(!connectionString)('migration from scratch', () => {
  const sql = postgres(connectionString as string, {
    max: 1,
    onnotice: () => {},
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('applies the baseline to an empty schema and creates app_meta', async () => {
    // Drop both the app schema and Drizzle's migration-history schema so the
    // baseline is genuinely applied from scratch.
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );

    await runMigrations(connectionString as string);

    const rows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.app_meta') IS NOT NULL AS exists
    `;
    expect(rows[0]?.exists).toBe(true);
  });

  it('is idempotent when run a second time', async () => {
    await expect(
      runMigrations(connectionString as string),
    ).resolves.not.toThrow();
  });
});
