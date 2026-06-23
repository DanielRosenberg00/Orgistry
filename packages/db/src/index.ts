export { createDbClient, type DbClient, type Database } from './client';
export { pingDatabase } from './health';
export { runMigrations, MIGRATIONS_FOLDER } from './migrator';
export * as schema from './schema/index';

// Row/insert types are re-exported at the top level for ergonomic consumption
// by repositories in `apps/api`.
export type {
  UserStatus,
  SecurityActorType,
  UserRow,
  UserInsert,
  SessionRow,
  SessionInsert,
  SecurityEventInsert,
} from './schema/auth';
