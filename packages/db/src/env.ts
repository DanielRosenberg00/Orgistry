import { z } from 'zod';

/**
 * Minimal environment reader for DB tooling (migrate / reset scripts).
 *
 * Migrations must not require the full application config (JWT/cookie secrets,
 * etc.), so this package validates only the connection strings it needs.
 */
const dbEnvSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  TEST_DATABASE_URL: z.string().url().optional(),
});

/** The connection string used by `migrate`. Throws if `DATABASE_URL` is unset. */
export function requireDatabaseUrl(): string {
  const env = dbEnvSchema.parse(process.env);
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }
  return env.DATABASE_URL;
}

/**
 * The connection string used by the destructive test-reset flow.
 *
 * Safety model: requires an explicit `TEST_DATABASE_URL` that DIFFERS from
 * `DATABASE_URL`, so the reset can never drop the development/production
 * database. This guard (rather than a `NODE_ENV` check) lets the reset run from
 * a clean clone with the default `.env` while remaining footgun-proof.
 */
export function requireTestDatabaseUrl(): string {
  const env = dbEnvSchema.parse(process.env);
  if (!env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required to reset the test database.');
  }
  if (env.DATABASE_URL && env.TEST_DATABASE_URL === env.DATABASE_URL) {
    throw new Error(
      'Test reset refused: TEST_DATABASE_URL must differ from DATABASE_URL.',
    );
  }
  return env.TEST_DATABASE_URL;
}
