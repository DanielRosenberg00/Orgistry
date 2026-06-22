import type postgres from 'postgres';

/**
 * Liveness probe for the database connection. Runs a trivial query and resolves
 * if PostgreSQL answers. Throws on any connection/query failure so callers can
 * translate it into a readiness status.
 */
export async function pingDatabase(sql: postgres.Sql): Promise<void> {
  await sql`SELECT 1`;
}
