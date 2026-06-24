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
      auth.ts                    users, sessions, refresh_tokens,
                                 email_verification_tokens, security_events
      organizations.ts           roles, organizations, memberships (Sprint 4)
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

`app_meta` is a **placeholder**: a generic key/value table that gives the
migration pipeline something concrete to create and validate. It carries no
domain meaning.

`auth.ts` (Sprint 2) adds the first domain tables. All follow the platform
model: prefixed opaque public IDs (`$defaultFn` via `@orgistry/shared`),
`snake_case` columns, `timestamptz` audit columns, hash-only secret storage, and
explicit lifecycle state.

| Table | Purpose | Notable invariants |
| --- | --- | --- |
| `users` | Accounts | unique index on `normalized_email`; `password_hash` only |
| `sessions` | Login sessions (access-token anchor) | indexed by `user_id`, `expires_at` |
| `refresh_tokens` | Refresh rotation + reuse detection (Sprint 3) | unique `token_hash`; `family_id` lineage; `used_at`/`replacement_token_id`/`revoked_*` |
| `email_verification_tokens` | Verification scaffolding (no behavior yet) | unique `token_hash` |
| `security_events` | Durable auth/security records | sanitized `metadata`; indexed by `event_type`, `created_at` |

`refresh_tokens` is now exercised by the Sprint 3 session lifecycle (rotation,
reuse detection, family/session revocation) — **no migration was needed**, the
Sprint 2 columns/indexes already modeled it. `email_verification_tokens` remains
schema-complete scaffolding with no endpoint. See
[`auth-foundation.md`](auth-foundation.md) and
[`session-lifecycle.md`](session-lifecycle.md).

`organizations.ts` (Sprint 4) adds the tenant layer (`User → Organization →
Membership`) plus the minimum role baseline. Same platform model: prefixed opaque
IDs (`role_`/`org_`/`mem_`), `snake_case` columns, `timestamptz` audit columns,
explicit lifecycle state.

| Table | Purpose | Notable invariants |
| --- | --- | --- |
| `roles` | Role baseline (identity only — **not** permissions) | unique `key`; seeded Owner/Admin/Member/Viewer with stable IDs |
| `organizations` | Personal + team tenants | unique `slug`; `type` ∈ {personal, team}; indexed by `created_by_user_id`, `status` |
| `memberships` | User ↔ organization with role | **partial** unique index on `(user_id, organization_id) WHERE status='active'`; soft-removal columns |

The baseline roles are seeded **idempotently** in the same migration
(`INSERT … ON CONFLICT (key) DO NOTHING`) with stable IDs (`role_owner`, …)
referenced from code via `ROLE_IDS`. The partial unique index enforces *one
active membership per (user, organization)* while retaining `removed` history.
Authorization is keyed on organization **ID**, never slug. See
[`organization-foundation.md`](organization-foundation.md).

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
  baseline, asserts `app_meta` and every auth + organization table exist, checks
  the lookup/uniqueness/cleanup indexes (incl. the membership partial unique
  index), verifies the normalized-email uniqueness constraint and the one-active-
  membership invariant, confirms the role seed, and re-runs to confirm
  idempotency. Needs PostgreSQL via `TEST_DATABASE_URL` or `DATABASE_URL`.
- `apps/api/src/modules/organization/organization.integration.test.ts` —
  registration-provisioned personal workspaces, atomic registration rollback,
  team create, membership uniqueness, list/read scoping, and removed-membership
  access against live PostgreSQL. Needs `TEST_DATABASE_URL` or `DATABASE_URL`.
- `apps/api/src/routes/readiness.integration.test.ts` — boots the app against
  live PostgreSQL + Redis probes and asserts `/ready` returns `200`. Needs
  `DATABASE_URL` and `REDIS_URL`.
- `apps/api/src/modules/auth/auth.integration.test.ts` — registers/logs in/
  resolves the current user against live PostgreSQL and asserts hash-only
  persistence, durable sanitized security events, and DB-level email uniqueness.
  Needs `TEST_DATABASE_URL` or `DATABASE_URL`.

Both load the root `.env` and **skip with a printed warning** (never a silent
pass) when their required services are not configured.

- Run locally: `pnpm test:integration` (with infra up).
- When no database is configured the suite **skips with a printed warning**, not
  a silent pass.
- CI runs it against a PostgreSQL service container.
