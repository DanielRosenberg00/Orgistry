# Troubleshooting

Symptom-driven fixes for the common local and CI failures. For the validation
commands themselves see the [validation matrix](./validation.md); for
infrastructure operations see the [runbook](./runbook.md).

## Dependency install fails

- **Lockfile out of date / `--frozen-lockfile` error.** CI installs with
  `pnpm install --frozen-lockfile`. If `package.json` and `pnpm-lock.yaml`
  disagree, run `pnpm install` locally and commit the updated lockfile.
- **Wrong package manager / version.** The repo pins `pnpm@10.29.3` via
  `packageManager` and requires Node ≥ 20. Use `corepack enable` so the pinned
  pnpm is used, and check `node --version`.
- **Native build steps blocked.** Only `esbuild` is allow-listed under
  `pnpm.onlyBuiltDependencies`. If a postinstall is skipped, that is intentional.

## Docker is not running

`pnpm infra:up` errors with "Cannot connect to the Docker daemon". Start Docker
Desktop (or your Docker engine) and retry. Verify with `docker info`.

## PostgreSQL port conflict (5432 already in use)

The single most common failure. Another Postgres (system service, Postgres.app,
or another project's container) holds 5432, so Orgistry's container can't bind
it. Symptoms:

- `pnpm infra:up` reports a port bind error, **or**
- the orgistry Postgres container is absent from `docker ps` while `redis`/
  `mailpit` are up, **or**
- `/ready` reports `postgres` unhealthy, **or**
- `psql` to `localhost:5432` fails authentication (you reached a *different*
  Postgres that doesn't know the `orgistry` role).

Diagnose and resolve:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN     # who owns the port
```

Then either stop the conflicting service, or remap Orgistry's Postgres to a free
host port (e.g. `5433`) in `infra/docker-compose.yml` and update
`DATABASE_URL`/`TEST_DATABASE_URL` in `.env`. Full options are in the runbook's
[port-conflict section](./runbook.md#handling-port-conflicts).

## Redis unavailable

- `/ready` returns `503` with `redis` unhealthy. Start Redis (`pnpm infra:up`)
  or fix a 6379 conflict (`lsof -nP -iTCP:6379 -sTCP:LISTEN`).
- Note: rate limiting **fails open** — auth still works without Redis — but the
  readiness probe and the rate-limit integration behavior depend on it.

## Mailpit unavailable

- Invitation creation fails with a delivery error. The mailer is **fail-closed**:
  if SMTP delivery fails, no invitation is persisted and no event is recorded.
  Start Mailpit (`pnpm infra:up`) and confirm `localhost:1025` is reachable.
- Can't see an email you expect: open <http://localhost:8025> and check the
  Mailpit inbox; confirm `MAILPIT_HOST`/`MAILPIT_SMTP_PORT` match the container.

## Database migration / reset failures

- **`db:reset:test` refuses to run.** It requires `TEST_DATABASE_URL` to be set
  and to differ from `DATABASE_URL` (a guard so it can never wipe your dev
  database). Point `TEST_DATABASE_URL` at a distinct database (the default
  `orgistry_test` is created automatically by the Postgres container).
- **`relation already exists` / dirty state.** Reset to the baseline with
  `pnpm db:reset:test` (test DB) or `pnpm infra:reset && pnpm infra:up &&
  pnpm db:migrate` (dev DB — destroys local data).
- **Migrations don't apply from scratch.** Confirm `DATABASE_URL` points at a
  reachable, empty-or-migratable database and that the Postgres container is
  `healthy`.

## Readiness endpoint failures

`GET /ready` returns `503` with a per-dependency `checks` array naming the failed
dependency (`postgres` and/or `redis`). `GET /health` is liveness only and is
`200` whenever the process is up. Use the `checks` array to see exactly which
dependency is down, then apply the relevant fix above.

## CORS / cookie issues between web and API

The web demo (`http://localhost:5173`) talks to the API (`http://localhost:3000`)
cross-origin, and refresh/logout rely on a cookie sent with
`credentials: include`.

- **Refresh/logout silently fail or the session won't restore.** Ensure the API's
  `CORS_ORIGINS` includes the web origin (`http://localhost:5173`). A strict
  allow-list is required precisely so the custom CSRF header can't be forged
  cross-site.
- **CSRF header mismatch.** The web demo sends `VITE_CSRF_HEADER_NAME` and the
  API expects `AUTH_CSRF_HEADER_NAME`; both default to `x-orgistry-csrf`. If you
  change one, change both.
- **Cookie not stored.** `COOKIE_SECURE=true` makes the refresh cookie
  `Secure`, which browsers drop over plain HTTP. Keep it `false` for localhost.

## Refresh / login issues

- **Login succeeds but reload logs you out.** Access tokens live only in memory
  by design; session restore depends on the HttpOnly refresh cookie. This is the
  CORS/cookie path above — check `CORS_ORIGINS` and `COOKIE_SECURE`.
- **Rate-limited (`429`).** The auth buckets are intentionally tight. Wait for the
  window (default 60s) or raise the relevant `RATE_LIMIT_*` value in `.env` for
  local testing.

## Integration test environment variables

The integration suites need `NODE_ENV=test`, `DATABASE_URL`, `TEST_DATABASE_URL`,
`REDIS_URL`, `JWT_SECRET`, and `COOKIE_SECRET`. If these are unset the suites
**skip with a warning** rather than fail — a green run full of skips is not a
validated run. `cp .env.example .env` provides working defaults; CI sets them
explicitly in the workflow `env` block.

## Stale generated Drizzle artifacts

If `pnpm db:check` fails after you changed the schema, the committed migrations
no longer match `packages/db/src/schema`. Run `pnpm db:generate`, review the new
SQL under `packages/db/migrations`, and commit it. Never hand-edit generated
migration files — regenerate instead.

## Schema drift check failures in CI

The CI "Schema drift check" step runs `pnpm db:check`. A failure means a schema
change was committed without the regenerated migration. Fix locally with
`pnpm db:generate` and commit the result; the check is offline and needs no
database.

## Web demo API base URL mismatch

The web demo reads `VITE_API_BASE_URL` (default `http://localhost:3000`) at
dev/build time. If the API runs elsewhere, set `VITE_API_BASE_URL` before
`pnpm dev:web` / `pnpm build:web`. A wrong base URL shows up as network errors in
the browser console and failed API calls in the UI. Remember the API's
`CORS_ORIGINS` must include the web origin.

## CI service container failures

- **Postgres/Redis not ready.** The workflow declares health checks with retries;
  a flake usually means the container needed longer. Re-run the job.
- **`CREATE DATABASE orgistry_test` fails.** Confirm the `postgres` service env
  (`POSTGRES_USER`/`PASSWORD`/`DB`) matches the `DATABASE_URL` in the job `env`.
- **Integration job green but suspiciously fast.** Check the logs for skip
  warnings — missing env would skip the suites. The workflow sets all required
  env explicitly to prevent this.
