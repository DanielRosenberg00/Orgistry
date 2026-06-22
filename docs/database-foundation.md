# Database Foundation

`packages/db` provides the Drizzle ORM setup, connection factory, schema
registry, migration baseline, and a guarded test-database reset. It contains
**no business workflows** — only schema and infrastructure.

## Layout

```
packages/db/
  drizzle.config.ts              Drizzle Kit config (generate target)
  migrations/                    Generated SQL + meta (committed)
  src/
    client.ts                    createDbClient(connectionString) -> { db, sql, close }
    health.ts                    pingDatabase(sql) — SELECT 1
    migrator.ts                  runMigrations(connectionString)
    env.ts                       reads DATABASE_URL / TEST_DATABASE_URL only
    schema/
      index.ts                   schema registry (barrel)
      meta.ts                    app_meta — infrastructure metadata (placeholder)
    migrate.integration.test.ts  migration-from-scratch test (needs PostgreSQL)
  scripts/
    migrate.ts                   pnpm db:migrate
    reset-test.ts                pnpm db:reset:test
```

## Connection

`createDbClient(connectionString)` returns `{ db, sql, close }`. The caller (the
API) owns config and passes the connection string explicitly — the package does
**not** depend on `@orgistry/config`, so migrations never require unrelated app
secrets (JWT/cookie). `sql` (the raw `postgres` client) backs the readiness
probe and shutdown.

The DB CLI scripts (`migrate`, `reset:test`) and `drizzle.config.ts` load the
workspace-root `.env` via `loadWorkspaceEnv()` from `@orgistry/shared/node` and
read only the connection strings they need (`src/env.ts`). `packages/db` depends
on `@orgistry/shared` for this loader but still not on `@orgistry/config`.

## Schema registry

Drizzle reads every table re-exported from `src/schema/index.ts`. Add a new
schema file and re-export it here so `db:generate` and the runtime client always
agree.

`app_meta` is the only table and is a **placeholder**: a generic key/value table
that gives the migration pipeline something concrete to create and validate. It
carries no domain meaning. Domain tables arrive in later sprints.

## Migrations

```bash
pnpm db:generate     # regenerate SQL from the schema (offline; no DB needed)
pnpm db:migrate      # apply baseline to DATABASE_URL (safe from scratch; idempotent)
```

`runMigrations` uses Drizzle's migrator and records applied migrations in a
separate `drizzle` schema (table `__drizzle_migrations`).

## Test database reset

```bash
pnpm db:reset:test   # requires TEST_DATABASE_URL, distinct from DATABASE_URL
```

This drops both `public` (app tables) **and** `drizzle` (migration history),
recreates `public`, and re-applies the baseline. Dropping `drizzle` is essential
— otherwise the migrator would consider the baseline already applied and skip
recreating tables.

**Safety model:** the reset requires an explicit `TEST_DATABASE_URL` that
differs from `DATABASE_URL`, so it can never drop the dev/prod database. This
URL-distinctness guard (rather than a `NODE_ENV=test` check) keeps the command
working from a clean clone, where the default `.env` sets
`NODE_ENV=development`. The `orgistry_test` database is provisioned on first
container start by `infra/postgres-init/01-create-test-db.sql`.

## Integration validation

Two integration suites (suffix `*.integration.test.ts`, excluded from
`pnpm test`, run by `pnpm test:integration` / CI):

- `packages/db/src/migrate.integration.test.ts` — drops the schema, runs the
  baseline, asserts `app_meta` exists, and re-runs to confirm idempotency. Needs
  PostgreSQL via `TEST_DATABASE_URL` or `DATABASE_URL`.
- `apps/api/src/routes/readiness.integration.test.ts` — boots the app against
  live PostgreSQL + Redis probes and asserts `/ready` returns `200`. Needs
  `DATABASE_URL` and `REDIS_URL`.

Both load the root `.env` and **skip with a printed warning** (never a silent
pass) when their required services are not configured.

- Run locally: `pnpm test:integration` (with infra up).
- When no database is configured the suite **skips with a printed warning**, not
  a silent pass.
- CI runs it against a PostgreSQL service container.
