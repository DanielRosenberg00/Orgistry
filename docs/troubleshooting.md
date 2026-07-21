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
- Note: rate limiting **fails open locally** (development/test derive
  `RATE_LIMIT_FAILURE_MODE=open`) — auth still works without Redis — but the
  readiness probe and the rate-limit integration behavior depend on it. In
  production the sensitive limiters fail **closed** instead; see
  "503 SERVICE_UNAVAILABLE on auth endpoints" below.

## Mailpit unavailable

- Invitation creation fails with a delivery error. Invitation delivery is
  **fail-closed**: if SMTP delivery fails, no invitation is persisted and no
  event is recorded. Start Mailpit (`pnpm infra:up`) and confirm
  `localhost:1025` is reachable.
- A registration request still returns the generic `{ accepted: true }` when
  Mailpit is down — on the public, enumeration-safe register endpoint a mail
  failure never alters the response — but the completion email cannot be
  delivered, so the account cannot be created until Mailpit is back. Submit
  the register form again to get a fresh completion email (each request
  supersedes prior unused pending generations).
- An explicit verification resend fails with an error while Mailpit is down;
  the previously issued verification link (if any) stays usable.
- Can't see an email you expect: open <http://localhost:8025> and check the
  Mailpit inbox; confirm `MAILPIT_HOST`/`MAILPIT_SMTP_PORT` match the container
  and that `MAIL_DRIVER` is `mailpit` (the default).

## Mail configuration rejected at startup

- `SMTP_HOST is required when MAIL_DRIVER=smtp` (any mode): selecting the
  production smtp driver requires `SMTP_HOST`/`SMTP_USERNAME`/`SMTP_PASSWORD`.
  For local development leave `MAIL_DRIVER=mailpit`.
- Under `NODE_ENV=production` the config guard additionally refuses
  `MAIL_DRIVER=mailpit`/`memory`, placeholder-style `SMTP_PASSWORD` values,
  local-only/reserved-domain `MAIL_FROM_EMAIL`, and a non-HTTPS or localhost
  `WEB_DEMO_URL`. See
  [production-config-guard.md](./production-config-guard.md).

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
dependency is down, then apply the relevant fix above. The per-dependency
`checks` output exists only in development/test — under `NODE_ENV=production`
`/ready` is deliberately coarse (`200 {status:'ready'}` or a generic `503`
with no dependency names); per-check outcomes are logged server-side on
failure, so consult the process logs there.

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

## Unexpected `429 RATE_LIMITED` outside auth

Since Sprint 19 the auth buckets are not the only limiters:

- **The global limit.** Every route except `/health`, `/ready`, and `OPTIONS`
  preflight shares one bucket per client IP — `RATE_LIMIT_MAX` (default 300)
  per `RATE_LIMIT_WINDOW_SECONDS` (default 60). Bulk local scripting or a seed
  run hammering the API from one IP can trip it; raise `RATE_LIMIT_MAX` in
  `.env` for local testing.
- **Mutation buckets.** Org create, project create/update/delete, API-key
  create, demo plan change, member role change/removal, and invitation
  create/inspect/accept carry their own per-actor limits
  (`RATE_LIMIT_ORG_CREATE_PER_USER_MAX`,
  `RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX`,
  `RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX`,
  `RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX`,
  `RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX`,
  `RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX`, `RATE_LIMIT_INVITATION_*`) over
  `RATE_LIMIT_MUTATION_WINDOW_SECONDS` (default 60). Raise the specific
  variable named for the endpoint you are hitting.

Either way the response is the standard `429 RATE_LIMITED` envelope; wait for
the window or raise the relevant value locally.

## 503 SERVICE_UNAVAILABLE on auth endpoints

Sensitive rate-limited endpoints (login, refresh, registration, password
recovery, email verification, invitation inspect/accept/create, the external
API, the mutation buckets) return a generic `503 SERVICE_UNAVAILABLE` when
Redis is unreachable **and** the limiter failure mode is `closed` — the
production default (`RATE_LIMIT_FAILURE_MODE` unset derives
production→closed; production refuses an explicit `open`). Check `GET /ready`
and Redis health, and look for sanitized limiter-store failure lines in the
server logs (the response itself carries no Redis details). Locally the mode
defaults to `open`, so seeing this in development usually means
`RATE_LIMIT_FAILURE_MODE=closed` was set explicitly.

## Wrong client IPs / all requests share one rate-limit bucket

Behind a reverse proxy with the default `TRUST_PROXY=false`, forwarded headers
are ignored and every request's `request.ip` is the proxy's address — so all
clients collapse into one rate-limit bucket and logs/audit/security events
record the proxy IP. Set `TRUST_PROXY` to the trusted hop count (accepted
range 1–16; `1` for one TLS-terminating proxy) or to a comma-separated proxy IP/CIDR list (entries
are validated semantically at boot: real IPv4/IPv6 addresses, CIDR prefixes
0–32/0–128 — hostnames, malformed entries, and empty comma entries refuse to
start). Do not overshoot: a too-high hop count lets clients spoof their IP
via forged headers. The literal `true` is rejected at boot. For direct local
access, leave the default `false`. Note HSTS also depends on this value:
production emits it only for requests whose proxy-aware protocol resolves to
`https`, so a wrong `TRUST_PROXY` silently disables HSTS.

## `x-request-id` differs from what the client sent

An inbound `x-request-id` is honored only if it matches
`[A-Za-z0-9._-]{1,128}`. Anything else — empty, over 128 chars, whitespace,
control characters, or other characters — is replaced by a server-generated
`req_<uuid>`, which is what the response header, logs, and error envelopes
then carry. If your correlation ids "change", make the client send ids in the
accepted format.

## Integration test environment variables

The integration suites need `NODE_ENV=test`, `DATABASE_URL`, `TEST_DATABASE_URL`,
`REDIS_URL`, and `JWT_SECRET`. If these are unset the suites
**skip with a warning** rather than fail — a green run full of skips is not a
validated run. `cp .env.example .env` provides working defaults; CI sets them
explicitly in the workflow `env` block.

## Stale generated Drizzle artifacts

If `pnpm db:check` fails after you changed the schema, regenerating produced
new or changed files under `packages/db/migrations` — the migrations no longer
match `packages/db/src/schema`. Run `pnpm db:generate`, review the new SQL,
and include it with the schema change. The check compares directory content
before and after generation, so an already-generated migration that is merely
uncommitted does **not** fail it. Never hand-edit generated migration files —
regenerate instead.

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
