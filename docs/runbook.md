# Local Infrastructure Runbook

Operating the local services Orgistry depends on. All infrastructure is defined
in `infra/docker-compose.yml` and is local-only — there is no production
deployment automation here.

## Services

| Service | Image | Host port(s) | Purpose |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | `5432` | Durable application store (and the test database). |
| `redis` | `redis:7-alpine` | `6379` | Auth + external-API rate limiting; backs the `/ready` probe. |
| `mailpit` | `axllent/mailpit` | `1025` (SMTP), `8025` (web UI) | Local email sink for invitation delivery. |

The Compose project name is `orgistry`, so containers are named
`orgistry-postgres-1`, `orgistry-redis-1`, `orgistry-mailpit-1`.

### PostgreSQL

Credentials come from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` in
`.env` (defaults `orgistry`/`orgistry`/`orgistry`). These are local-only
development defaults, not secrets. On first volume initialization the container
also runs `infra/postgres-init/01-create-test-db.sql`, which creates the
`orgistry_test` database used by `pnpm db:reset:test` and the integration tests —
so no manual test-database creation is needed.

Data persists in the `postgres_data` named volume across restarts. `DATABASE_URL`
and `TEST_DATABASE_URL` in `.env` must match these credentials.

### Redis

No credentials. Backs the fixed-window rate-limit buckets (auth + external API)
and the readiness probe. Rate limiting **fails open**: if Redis is unavailable,
requests are allowed rather than blocked, so a Redis outage never breaks
authentication — but `/ready` reports the outage. Data persists in `redis_data`.

### Mailpit

A local SMTP sink with a web UI. The invitation mailer delivers over SMTP to
`MAILPIT_HOST:MAILPIT_SMTP_PORT` (default `localhost:1025`); view delivered
messages at <http://localhost:8025>. Mailpit is **not** a production email
provider and is the only email path implemented. Data persists in `mailpit_data`.

## Relevant environment variables

From `.env` (see `.env.example` for the full annotated list):

```bash
DATABASE_URL=postgres://orgistry:orgistry@localhost:5432/orgistry
TEST_DATABASE_URL=postgres://orgistry:orgistry@localhost:5432/orgistry_test
REDIS_URL=redis://localhost:6379
MAILPIT_HOST=localhost
MAILPIT_SMTP_PORT=1025
MAILPIT_UI_PORT=8025
# Consumed only by docker-compose for Postgres provisioning:
POSTGRES_USER=orgistry
POSTGRES_PASSWORD=orgistry
POSTGRES_DB=orgistry
```

## Starting and stopping

```bash
pnpm infra:up      # start all services detached
pnpm infra:down    # stop services, keep data volumes
pnpm infra:reset   # stop services AND delete volumes (wipes all local data)
```

Check status and health:

```bash
docker compose -f infra/docker-compose.yml ps
```

All three services define health checks; wait for `healthy` before running
migrations or tests.

## Resetting data

- **Application data only (test DB)**: `pnpm db:reset:test` — drops and re-migrates
  the test database; leaves your dev database untouched.
- **Everything (all volumes)**: `pnpm infra:reset` — removes the Postgres, Redis,
  and Mailpit volumes. After this, `pnpm infra:up` recreates empty services and
  the test database is provisioned again from `infra/postgres-init/`. Re-run
  `pnpm db:migrate` to rebuild the dev schema.

## Inspecting Mailpit

```bash
open http://localhost:8025                       # web UI
curl -s http://localhost:8025/api/v1/messages    # list messages via API
```

Invitation emails appear here. The raw invitation token is delivered only in
this email (never in a URL or log).

## Running integration tests

Integration tests need PostgreSQL + Redis (Mailpit is not exercised):

```bash
pnpm infra:up
pnpm validate:integration   # db:reset:test + test:integration
```

See the [validation matrix](./validation.md) for what this proves.

## Handling port conflicts

The most common local failure is another process already holding a required
port — most often **PostgreSQL on 5432** (a system Postgres, Postgres.app, or
another project's container). Symptoms: `pnpm infra:up` reports a bind error, or
the orgistry Postgres container is missing from `docker ps` while `/ready`
reports Postgres down, or `psql` against 5432 fails authentication (you reached
a *different* Postgres).

Diagnose which process owns a port:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN     # macOS/Linux
```

Resolution options, in order of preference:

1. **Stop the conflicting service.** If it is a stray local Postgres you don't
   need, stop it (e.g. `brew services stop postgresql`, quit Postgres.app, or
   stop the other container) and run `pnpm infra:up` again.
2. **Move Orgistry's Postgres to a free host port.** Edit the `postgres` port
   mapping in `infra/docker-compose.yml` (e.g. `'5433:5432'`) and update
   `DATABASE_URL`/`TEST_DATABASE_URL` in `.env` to the new host port. The
   container still listens on 5432 internally; only the host mapping changes.
3. **Run a one-off Postgres on an alternate port** for a single validation run
   and point the env vars at it — useful when you can't disturb the occupying
   service:

   ```bash
   docker run -d --name orgistry-pg-alt \
     -e POSTGRES_USER=orgistry -e POSTGRES_PASSWORD=orgistry -e POSTGRES_DB=orgistry \
     -p 55432:5432 postgres:16-alpine
   docker exec orgistry-pg-alt psql -U orgistry -d orgistry -c 'CREATE DATABASE orgistry_test;'
   # then run commands with DATABASE_URL/TEST_DATABASE_URL pointing at :55432
   docker rm -f orgistry-pg-alt   # clean up afterwards
   ```

The same diagnosis applies to Redis (6379), the API (3000), the web demo (5173),
and Mailpit (1025/8025). See the [troubleshooting guide](./troubleshooting.md)
for symptom-driven fixes.
