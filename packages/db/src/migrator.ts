import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Absolute path to the generated SQL migrations folder. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

/**
 * Apply all pending migrations against `connectionString`.
 *
 * Uses a single-connection client (Drizzle's recommendation for migrations)
 * and always closes it. Running against a fresh database applies the full
 * baseline from scratch.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  // `onnotice` is silenced: re-running an applied baseline emits "already
  // exists, skipping" NOTICEs from Drizzle's IF NOT EXISTS bookkeeping, which
  // is expected and not useful output.
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
