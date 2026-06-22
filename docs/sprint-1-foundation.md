# Sprint 1 — Foundation

This document is the engineering reference for the Orgistry Sprint 1 foundation.
It describes what exists, why it is shaped this way, the contracts later sprints
must respect, and where the boundaries are.

> The official Sprint 1 completion artifact is
> [`docs/sprint-1-artifact-package.md`](sprint-1-artifact-package.md) — start
> there for capabilities, validation evidence, scope control, and Sprint 2
> readiness. This document is the deeper engineering reference behind it.

---

## Developer Documentation

### What was implemented

A typed pnpm monorepo with clean dependency direction and no product/domain
logic. The pieces:

| Area | Location | Summary |
| --- | --- | --- |
| Typed config | `packages/config` | Zod-validated runtime config; single source of truth |
| API contracts | `packages/contracts` | Envelopes, error codes, cursor pagination |
| Primitives | `packages/shared` | Prefixed IDs, request IDs, clock, cursors |
| Database | `packages/db` | Drizzle client, schema registry, migrations, test reset |
| API shell | `apps/api` | Fastify app: health, readiness, error handling, logging |
| Web shell | `apps/web-demo` | React/Vite shell, static foundation status page |
| Infra | `infra/docker-compose.yml` | PostgreSQL, Redis, Mailpit |
| CI | `.github/workflows/ci.yml` | Install, typecheck, lint, test, migrate, integration |

### How it works

- **No build step for internal packages.** Each `@orgistry/*` package exposes
  its TypeScript source directly via `package.json` `exports` (`"." ->
  "./src/index.ts"`). `tsx` (API), Vite (web), `vitest`, and `tsc`
  (`moduleResolution: bundler`) all resolve and transform the source. This keeps
  the local loop fast and removes a class of "did you rebuild the package?"
  bugs. Packages are published nowhere in Sprint 1.
- **Config is validated once, at the edge.** `loadConfig(source)` validates a
  raw environment record and returns a structured `Config`. `getConfig()` caches
  a load from `process.env` for process startup. Invalid config throws
  `ConfigValidationError` listing every problem.
- **The API separates construction from startup.** `buildApp(options)` returns a
  wired Fastify instance with no open ports; `server.ts` owns config loading,
  real PostgreSQL/Redis clients, signal handling, and `listen`. Tests use
  `app.inject(...)` against `buildApp` with injected probes.
- **Readiness is real.** Probes are injected into `buildApp`. In production
  `server.ts` wires a PostgreSQL `SELECT 1` and a Redis `PING`; in tests fakes
  stand in. `/ready` returns `503` with an error envelope if any probe fails.
- **Migrations run from scratch.** `pnpm db:migrate` applies the generated SQL
  baseline against `DATABASE_URL` using Drizzle's migrator.

### Where it lives

```
apps/
  api/        Fastify shell (buildApp + server + routes + plugins)
  web-demo/   React/Vite shell
packages/
  config/     Zod config schema + loader
  contracts/  Envelopes, error codes, pagination DTOs
  shared/     IDs, request IDs, clock, cursors
  db/         Drizzle client, schema, migrator, scripts, migrations/
infra/        docker-compose.yml
tooling/      lint placeholder
docs/         this and companion docs
```

### How to extend it safely

- **New env var:** add it to `packages/config/src/schema.ts`, surface it in the
  structured `Config` (`index.ts`), and add it to `.env.example` in the same
  change. Add a config test if it has non-trivial parsing.
- **New domain table:** add a schema file under `packages/db/src/schema/`,
  re-export it from `schema/index.ts`, run `pnpm db:generate`, and commit the
  generated migration. Keep business logic out of `packages/db`.
- **New API module:** create it under `apps/api/src/modules/*` (this directory
  arrives with the first real feature). Reuse `sendSuccess` and throw `AppError`
  so every response stays enveloped. Do not add repository/service abstraction
  layers preemptively.
- **New error code:** extend `ERROR_CODES` in `packages/contracts`. Treat it as
  a reviewed contract change — clients branch on these values.
- **New entity ID prefix:** add it to `ID_PREFIXES` in `packages/shared`. The
  v1 set is already complete (see Contracts & Invariants).

---

## Architectural Notes

### Key design decisions

1. **Source-only internal packages (no build step).** Chosen for local-first
   speed and simplicity. The whole toolchain understands TypeScript natively.
2. **`buildApp` vs `server.ts` split.** Makes the app testable via injection
   without sockets and keeps process/lifecycle concerns out of route code.
3. **Injected readiness probes.** Readiness logic is dependency-agnostic and
   unit-testable; real clients are wired only in `server.ts`.
4. **`packages/db` does not depend on `packages/config`.** Migrations and DB
   tooling read only the connection strings they need (`packages/db/src/env.ts`)
   so running a migration never requires unrelated app secrets (JWT/cookie).
5. **Config grouped into intent-revealing sections.** Application code consumes
   `config.api.port`, `config.redis.url`, etc., not a flat string bag.
6. **Lint deferred behind an explicit, green placeholder.** Strict `tsc` is the
   active quality gate for a foundation; the placeholder keeps `validate` honest
   and makes the future ESLint rollout a drop-in.

### Tradeoffs made

- **Source-only packages** trade a production build story (added later, per
  deploy target) for local simplicity. No package is published in Sprint 1.
- **`DATABASE_URL` as a single connection string** (rather than discrete host/
  port/user fields) keeps `.env` aligned with Docker Compose and Drizzle at the
  cost of slightly less granular validation.
- **Lightweight web routing** (a path→component map, no router library) avoids a
  dependency before there are real screens; it will be replaced when feature
  routes appear.

### Constraints respected

- No product/domain capability implemented (see Scope Boundary below).
- Clean dependency direction: nothing depends on `apps/api`; `contracts` and
  `shared` depend on neither apps nor DB; DB entities are never exposed as API
  DTOs.
- No real secrets committed; no worker/queue/object-storage/production-deploy
  infrastructure introduced.

### Rejected alternatives

- **TypeScript project references / prebuilt `dist` for internal packages** —
  rejected for Sprint 1: more config and a build step for no local benefit.
- **Cosmetic readiness endpoint** — rejected; `/ready` must reflect real
  dependency state to be useful to orchestrators.
- **Offset/limit pagination** — rejected in favor of an opaque-cursor baseline
  that stays stable as data changes.
- **A generic repository/service framework layer** — rejected as premature
  abstraction; modules will be added concretely when features need them.
- **ESLint in Sprint 1** — deferred; `tsc` strict mode covers the highest-value
  checks for a foundation.

---

## Contracts & Invariants

These are stable interfaces. Changing them is a deliberate, reviewed action.

### Response envelopes (`@orgistry/contracts`)

- Success: `{ ok: true, data: T }`.
- Error: `{ ok: false, error: { code, message, requestId, details? } }`.
- `ok` is the discriminant. `error.requestId` is **always** present.
- Error responses also carry the request id in the `x-request-id` response
  header. The same id appears in server logs as `requestId`.

### Error-code catalog

Baseline, generic codes only: `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`,
`INTERNAL_ERROR`. Values are stable strings clients may branch on; do not rename
without review. Domain-specific codes are added deliberately in later sprints.

### Public ID prefixes (`@orgistry/shared`)

Public IDs are `"<prefix>_<crockford-base32>"`. The complete v1 prefix set is:

```
user  org  mem  role  perm  inv  prj  key  sess  rtok  evt  sevt
```

Invariants: generated IDs never encode numeric/sequential/internal keys; an
unknown prefix throws; `parseId`/`isValidId` reject malformed input.

### Pagination

Cursor-based. `cursor` is an opaque token (base64url JSON via `shared`); clients
must not parse it. `limit` defaults to 20, max 100. Page shape:
`{ items, nextCursor, hasMore }`.

### Behavioral guarantees

- `/health` never checks dependencies and is `200` whenever the process is up.
- `/ready` reflects PostgreSQL + Redis and returns `503` + error envelope when a
  dependency is down.
- The central error handler is the only error path: `AppError` maps to its
  declared code/status; unknown errors become a generic `500 INTERNAL_ERROR`
  with no stack trace or internal message leaked to the client.
- Invalid configuration fails fast before the app serves traffic.

### Must not change without deliberate review

Envelope shapes, error-code string values, ID prefix set and format, cursor
opacity, health/readiness semantics, and the config→`.env.example` alignment.

---

## Integration Notes

How the pieces connect:

- **config → everything runtime.** `apps/api` loads config via `getConfig()` and
  passes typed values onward (DB connection string, Redis URL, CORS origins,
  log level, port).
- **config → db (indirectly).** The API passes `config.database.url` to
  `createDbClient(connectionString)`. `packages/db` itself only reads
  `DATABASE_URL` / `TEST_DATABASE_URL` directly for its CLI tooling.
- **shared/node → env loading.** Entry points (`apps/api/src/server.ts`, DB
  scripts, `drizzle.config.ts`, integration tests) call `loadWorkspaceEnv()` from
  `@orgistry/shared/node` to load the root `.env` before reading `process.env`.
  It is explicit (never an import side effect), `dotenv`-backed (works across the
  whole supported Node range), and existing env vars win. The loader is Node-only
  and therefore lives under the `/node` subpath — the main `@orgistry/shared`
  entrypoint stays general/browser-safe. `packages/db` depends on
  `@orgistry/shared` for this; it still does not depend on `@orgistry/config`.
- **db → api readiness.** `server.ts` builds a `postgres` probe from
  `pingDatabase(dbClient.sql)` and a `redis` probe from `redis.ping()`, and
  injects both into `buildApp`.
- **contracts → api + web.** The API builds every response with `makeSuccess` /
  `makeError`. The web demo imports the same package (e.g. `ERROR_CODES`) so the
  client never invents its own copy of the conventions.
- **shared → api.** Request-id generation/resolution and (later) cursor encoding
  come from `@orgistry/shared`; Fastify is configured to reuse an inbound
  `x-request-id` or generate one.
- **infra → api.** Docker Compose provides PostgreSQL (durable store), Redis
  (readiness today, rate limiting later), and Mailpit (future email). The
  readiness endpoint is what proves the API can reach Postgres and Redis.
- **web ← api (later).** The web demo will consume real API contracts in future
  sprints. It is not a source of truth and holds no domain state today.

---

## Known Limitations

- **Integration tests require infrastructure (by design).** `pnpm test` (unit)
  runs with no services. The integration suites
  (`packages/db/src/migrate.integration.test.ts` and
  `apps/api/src/routes/readiness.integration.test.ts`) require PostgreSQL (and
  Redis for readiness); when their services are not configured they **skip with
  a printed warning** (never a silent pass). CI runs both against live
  PostgreSQL + Redis service containers via `pnpm test:integration`.
- **Live readiness is now covered.** Both injected unit tests (pass→200,
  fail→503 with request id) and a live integration test (real PostgreSQL + Redis
  → `/ready` 200) exist; the failure path was also verified manually by stopping
  Redis (503 error envelope). See the changelog.
- **Docker not exercised in this environment.** The Docker daemon was
  unavailable, so `pnpm infra:up`/`down` were not run here. The full dependency
  path was validated instead against an ephemeral local PostgreSQL + Redis on the
  standard ports, and CI exercises the Docker-equivalent service containers.
- **Lint is a placeholder.** `pnpm lint` intentionally exits 0. Replace with
  ESLint in a later sprint.
- **No internal-package build/publish story.** Source-only consumption is fine
  for local dev and CI; a production build/runtime story is per deploy target
  and out of scope.
- **`app_meta` is a placeholder table.** It exists only to give the migration
  pipeline something concrete to create and validate. It carries no domain
  meaning.
- **Web routing is minimal.** A path→component map, no history/router; replaced
  when real screens arrive.

---

## Sprint Changelog

**Sprint 1 — Foundation (initial).**

Iteration summary:

1. Scaffolded the pnpm workspace, root scripts, `tsconfig.base.json`, and the
   `apps/*` + `packages/*` shape.
2. Implemented `packages/config` (Zod schema, structured loader, tests),
   `packages/contracts` (envelopes, error codes, pagination), and
   `packages/shared` (prefixed IDs, request IDs, clock, cursors) with tests.
3. Implemented `packages/db` (Drizzle client, schema registry, migrator, guarded
   test reset) and generated the baseline migration.
4. Implemented the Fastify API shell (`buildApp`/`server` split, request-id
   propagation, structured logging, central error handler, health + readiness)
   with injection-based tests.
5. Implemented the React/Vite web shell with a static foundation status page
   that consumes `@orgistry/contracts`.
6. Added Docker Compose infra and the CI workflow.

Improvements / quality evolution made during the pass (verified, not assumed):

- Fixed a config schema default typing issue (`COOKIE_SECURE` default must be
  the raw env string, transformed to boolean).
- Typed the central error handler's error parameter (`FastifyError`) to satisfy
  strict mode.
- **Found and fixed a real reset bug:** dropping only the `public` schema left
  Drizzle's `drizzle` migration-history schema intact, so re-migration skipped
  and `app_meta` was not recreated. Both `db:reset:test` and the integration
  test now drop the `drizzle` schema too; verified `app_meta` is present after a
  reset.
- Suppressed expected `NOTICE` noise on idempotent migrations and added an
  ioredis `error` listener so an unreachable Redis does not emit unhandled
  error events at boot.

Validation performed (see the implementation report for exact results): full
`pnpm typecheck`, `pnpm test` (36 tests), `pnpm validate`, web demo build, a
real API boot serving `/health` (200) and `/ready` (503 with deps down), and a
migration-from-scratch + reset + integration run against an ephemeral local
PostgreSQL.

**Sprint 1 — Hardening iteration.**

Closed the remaining Definition-of-Done gaps without changing scope:

1. **`.env` loading.** Added `loadWorkspaceEnv()` (then on Node's
   `process.loadEnvFile`; later switched to `dotenv` and moved to
   `@orgistry/shared/node` — see Final Micro-Hardening below). Wired it into
   `apps/api/src/server.ts`, the DB scripts, `drizzle.config.ts`, and the
   integration tests. A clean clone now runs with only `cp .env.example .env` —
   no manual exports. Loading stays explicit at entry points; `packages/config`
   still never reads files on import.
2. **Reset guard fixed for clean-clone UX.** Replaced the `NODE_ENV=test` guard
   (which conflicted with the default `.env`'s `NODE_ENV=development`) with a
   guard requiring `TEST_DATABASE_URL` to be set and **distinct from**
   `DATABASE_URL` — safer (cannot target dev/prod) and clone-friendly.
3. **Test database provisioning.** Added `infra/postgres-init/01-create-test-db.sql`
   so Compose creates `orgistry_test` on first start; CI creates it explicitly.
4. **Live readiness coverage.** Added `apps/api/src/routes/readiness.integration.test.ts`
   (real PostgreSQL + Redis → `/ready` 200) and made `pnpm test:integration` run
   recursively across packages. Strengthened the readiness unit test to assert
   all checks pass and a request-id header is present.
5. **CI proves the foundation.** CI now provisions `orgistry_test`, points
   `TEST_DATABASE_URL` at it (distinct from `DATABASE_URL`), and runs migration
   baseline + both integration suites against live PostgreSQL + Redis. Mailpit is
   intentionally excluded (no command needs it).
6. **Web demo typecheck includes `vite.config.ts`** via a dedicated
   `tsconfig.node.json`; the `typecheck` script checks both projects. No
   weakening of strictness.
7. **Quality fix found during hardening:** the live readiness integration suite
   instantiated its Redis client at collection time, emitting an unhandled
   ioredis error event when skipped. Moved client creation into `beforeAll` so a
   skipped run opens no connections.

Validation performed this iteration (Docker daemon was unavailable, so an
ephemeral local PostgreSQL + Redis on standard ports stood in): `pnpm typecheck`,
`pnpm test` (36), `pnpm validate`, web build; clean-clone `pnpm db:migrate` and
`pnpm db:reset:test` driven solely by `.env`; `pnpm test:integration` live (4
tests pass) and skipping cleanly with no infra; and a real API boot verifying
`/health` 200, `/ready` 200 with both deps up, request-id propagation/echo/logs,
and `/ready` 503 error envelope after stopping Redis.

**Sprint 1 — Final micro-hardening.**

Removed the last `.env`-loading portability/boundary footgun:

1. **Deterministic loading across the declared Node engine.** The loader
   previously used Node's `process.loadEnvFile`, which is not present in every
   Node 20 release allowed by `engines` (`node >=20.0.0`). On such a version a
   clean clone could `cp .env.example .env && pnpm dev:api` and still fail
   because `.env` was silently not loaded. Switched the loader to `dotenv`, so it
   works across the entire supported range. Existing env still wins; a missing
   `.env` is still a non-fatal no-op (config validation remains the gate for
   required values).
2. **Node-only code off the general entrypoint.** Moved the loader to
   `packages/shared/src/node/load-env.ts`, exported via the new
   `@orgistry/shared/node` subpath (`exports` map updated). The main
   `@orgistry/shared` entrypoint no longer surfaces `fs`/`path`/`.env` behavior,
   keeping it general/browser-safe. All five import sites now use
   `@orgistry/shared/node`.
3. **Tests.** Added `packages/shared/src/node/load-env.test.ts` (6 cases):
   loads from a workspace-root `.env`, does not override existing env, safe no-op
   when `.env` or the workspace root is absent, and `findWorkspaceRoot`
   behavior — with per-test cleanup to avoid env leakage.

Validation this iteration (Docker daemon still unavailable; ephemeral local
PostgreSQL + Redis on standard ports stood in): `pnpm install` /
`--frozen-lockfile`, `pnpm typecheck`, `pnpm test` (42), `pnpm validate`, web
build, `pnpm db:generate`; clean-clone `pnpm db:migrate` + `pnpm db:reset:test`
driven solely by the `dotenv`-loaded `.env`; live `pnpm test:integration` (4
tests pass); and a real API boot serving `/health` 200 and `/ready` 200 with
both dependencies up.
