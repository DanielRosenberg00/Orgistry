import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Infrastructure metadata table — NOT a domain table.
 *
 * `app_meta` is a generic key/value store used to record baseline facts about
 * the deployment (e.g. a schema-baseline marker). It exists so the migration
 * pipeline has something concrete to create and so migration-from-scratch can
 * be validated end-to-end. Domain tables (users, orgs, etc.) are introduced in
 * later sprints in their own schema files.
 */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppMetaRow = typeof appMeta.$inferSelect;
