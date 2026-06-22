import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbClient {
  /** Drizzle query interface bound to the full schema. */
  db: Database;
  /** Underlying postgres.js connection — used for health checks and shutdown. */
  sql: postgres.Sql;
  /** Close the connection pool. Call on process shutdown. */
  close(): Promise<void>;
}

/**
 * Create a database client from a connection string.
 *
 * The caller (e.g. the API) owns config and passes the connection string
 * explicitly — this package intentionally does not depend on `@orgistry/config`
 * so migrations and DB tooling do not require unrelated app secrets.
 */
export function createDbClient(
  connectionString: string,
  options: { max?: number } = {},
): DbClient {
  const sql = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
