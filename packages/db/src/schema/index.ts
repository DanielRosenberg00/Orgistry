/**
 * Schema registry.
 *
 * Drizzle reads every table re-exported from this barrel. New schema files are
 * added here as later sprints introduce tables. Keeping a single registry means
 * `drizzle-kit generate` and the runtime client always see the same schema.
 */
export { appMeta, type AppMetaRow } from './meta';
