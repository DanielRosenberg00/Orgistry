# Sprint 1 Artifact Package

Official completion artifact for Orgistry Sprint 1. This is the single
authoritative summary of what the foundation delivers, how it was validated, and
why Sprint 2 can build on it without revisiting Sprint 1 decisions. Companion
documents are indexed in §10.

## 1. Implementation Summary

Sprint 1 delivered the Orgistry technical foundation as a typed, local-first
pnpm monorepo: a Fastify API shell, a React/Vite web shell, typed runtime
configuration, frozen API contracts, low-level primitives, a Drizzle
database/migration baseline, Docker Compose infrastructure (PostgreSQL, Redis,
Mailpit), health/readiness endpoints, request-ID propagation, structured
logging, central error handling, and a CI quality gate.

This is **foundation only**. It contains **no domain or product functionality** —
no auth, organizations, memberships, permissions, entitlements, projects, API
keys, audit, or any product UI (see §12). The foundation is **ready for auth
persistence in Sprint 2**: the layout, config, migration flow, API bootstrap,
contracts, and CI gate are in place and validated (see §15).

## 2. Repository Structure

```txt
apps/
  api/        Fastify API shell (buildApp + server split, routes, plugins)
  web-demo/   React/Vite shell (static foundation status page)
packages/
  config/     typed, validated runtime configuration (Zod)
  contracts/  response envelopes, error-code catalog, cursor pagination
  shared/     low-level primitives; Node-only subpath at src/node/
  db/         Drizzle client, schema registry, migrator, test reset, migrations/
infra/
  docker-compose.yml         PostgreSQL + Redis + Mailpit
  postgres-init/             creates orgistry_test on first volume init
docs/                        foundation, local dev, API conventions, DB, this artifact
tooling/                     lint placeholder
.github/workflows/ci.yml     install → typecheck → lint → test → migrate → integration
```

Future homes reserved by convention (not yet created): `apps/api/src/modules/*`
for feature modules; later `packages/*` for auth-core, access-control, etc.

## 3. Runtime Capabilities

What runs today:

- **API shell** — `pnpm dev:api` boots Fastify on `API_HOST:API_PORT`
  (default `0.0.0.0:3000`), serving `/health` and `/ready`. Boots even if
  PostgreSQL/Redis are down (lazy clients); readiness reports the outage.
- **Web demo shell** — `pnpm dev:web` serves the Vite app at `:5173` with a
  static foundation status page that consumes `@orgistry/contracts` and holds no
  product state.
- **Local infrastructure** — `pnpm infra:up` starts PostgreSQL, Redis, and
  Mailpit via Docker Compose.
- **DB migration baseline** — `pnpm db:migrate` applies the migration baseline
  from scratch; `pnpm db:reset:test` rebuilds the test database.
- **Tests** — `pnpm test` runs 42 unit tests (no infrastructure required);
  `pnpm test:integration` runs the live DB + readiness suites.
- **CI validation** — GitHub Actions installs, typechecks, lints, tests, runs
  the migration baseline, and runs both integration suites against live
  PostgreSQL + Redis service containers.

## 4. Package Responsibilities

| Package | Owns | Must NOT own |
| --- | --- | --- |
| `packages/config` | The single typed, Zod-validated runtime config; `loadConfig`/`getConfig`; structured config sections | File/`.env` loading; secrets in code; domain config |
| `packages/contracts` | Success/error envelopes, error-code catalog, cursor-pagination DTOs; framework-agnostic | App/DB imports; domain DTOs; transport/server code |
| `packages/shared` | Browser-safe primitives: prefixed IDs, request IDs, clock, opaque cursors | Domain policy; Node-only behavior on the main entrypoint; app/DB deps |
| `packages/shared/node` | Node-only utilities: `loadWorkspaceEnv` / `findWorkspaceRoot` (`fs`/`path`/`dotenv`) | Domain logic; being imported by browser-safe code |
| `packages/db` | Drizzle client factory, schema registry, migrator, test reset, generated migrations | Business workflows; domain tables (beyond the `app_meta` placeholder); a dependency on `packages/config` |

## 5. API Foundation

- **`buildApp` vs `server.ts`** — `buildApp(options)` constructs a fully wired
  Fastify instance with no open ports (config + injected readiness probes);
  `server.ts` owns process concerns: `.env` loading, real PostgreSQL/Redis
  clients, signal handling, and `listen`. Tests exercise `buildApp` via
  `app.inject(...)` with fake probes — no sockets, no real infrastructure.
- **Health (`GET /health`)** — liveness only; never touches dependencies;
  returns `200` `{ ok: true, data: { status: "ok" } }` whenever the process is
  up.
- **Readiness (`GET /ready`)** — runs injected probes (PostgreSQL `SELECT 1`,
  Redis `PING`). `200` success envelope with per-dependency `checks` when all
  pass; `503` error envelope (`SERVICE_UNAVAILABLE`, with failing checks in
  `details`) when any fail. Wired to live clients in `server.ts`, so it is never
  cosmetic.
- **Request-ID propagation** — Fastify reuses an inbound `x-request-id` or
  generates `req_<uuid>`; the id is echoed on every response via `x-request-id`,
  included in every error envelope, and logged as `requestId`.
- **Structured logging** — JSON logs (Pino via Fastify) at the configured level,
  each request line carrying `requestId`.
- **Central error handling** — one path: `AppError` maps to its declared
  code/status/message; Fastify validation errors map to `400 VALIDATION_ERROR`;
  anything else becomes a generic `500 INTERNAL_ERROR` with the real error logged
  server-side only (no stack traces or internals leak). Unknown routes return
  `404 NOT_FOUND`.
- **Envelopes** — success responses are sent through `sendSuccess`; all errors
  flow through the central handler. Every response is the discriminated envelope
  from `@orgistry/contracts`.

## 6. Database Foundation

- **Drizzle setup** — `createDbClient(connectionString)` returns
  `{ db, sql, close }` over `postgres.js`. The caller passes the connection
  string explicitly; the package does not depend on `@orgistry/config`.
- **Schema registry** — `src/schema/index.ts` is the single barrel Drizzle reads;
  new tables are added here so `db:generate` and the runtime client always agree.
- **`app_meta`** — the only table, an **infrastructure-only** key/value
  placeholder that gives the migration pipeline something concrete to create and
  validate. It carries no domain meaning.
- **Migration baseline** — `pnpm db:migrate` applies the generated SQL baseline
  via Drizzle's migrator; safe from scratch and idempotent. Drizzle records
  applied migrations in a separate `drizzle` schema.
- **Test DB reset** — `pnpm db:reset:test` drops both `public` and `drizzle`,
  recreates `public`, and re-applies the baseline. Guarded by requiring an
  explicit `TEST_DATABASE_URL` that **differs from `DATABASE_URL`**, so it cannot
  target dev/prod.
- **Migration-from-scratch validation** — `packages/db/src/migrate.integration.test.ts`
  drops the schema, runs the baseline, asserts `app_meta` exists, and re-runs to
  confirm idempotency. Requires live PostgreSQL; skips with a printed warning
  otherwise.
- **No business workflows** in the DB package — schema and infrastructure only.

## 7. Configuration Foundation

- **Typed config** — `packages/config` validates the environment once with Zod
  and returns a structured `Config`; invalid/missing required values throw
  `ConfigValidationError` (listing every problem) before the app serves traffic.
- **`.env.example`** — documents every variable and maps 1:1 to
  `packages/config/src/schema.ts`. Values are local-only placeholders.
- **`.env` loading via `@orgistry/shared/node`** — entry points (API `server.ts`,
  DB scripts, `drizzle.config.ts`, integration tests) call `loadWorkspaceEnv()`
  explicitly. Loading is never an import side effect, so libraries and unit tests
  are not surprised.
- **`dotenv` behavior** — the loader uses `dotenv` (works across the whole
  supported Node range; not dependent on `process.loadEnvFile`). A missing `.env`
  is a non-fatal no-op.
- **Real env overrides `.env`** — existing environment variables always win, so
  CI and explicit exports are authoritative; `.env` only fills gaps.
- **Config validation is the gate** — a missing required value surfaces as a
  clear config error, not as a half-booted process.
- **Local/test distinction** — `NODE_ENV` (`development` | `test` | `production`)
  exposes `isTest` / `isProduction`; the test flow uses a dedicated
  `TEST_DATABASE_URL`.
- **Represented namespaces** — runtime/log level; API host/port; web demo URL;
  CORS origins; PostgreSQL; Redis; Mailpit; auth secrets (`JWT_SECRET`,
  `COOKIE_SECRET`, `COOKIE_SECURE`) reserved for later; rate-limit namespace
  (`RATE_LIMIT_*`) reserved for later.

## 8. Contracts and Invariants

Stable interfaces — changes require deliberate review:

- **Success envelope** — `{ ok: true, data: T }`.
- **Error envelope** — `{ ok: false, error: { code, message, requestId, details? } }`.
- **Request ID in error responses** — `error.requestId` is always present and
  matches the `x-request-id` response header and the `requestId` log field.
- **Pagination baseline** — cursor-based: request `{ cursor?, limit }`
  (default 20, max 100); page `{ items, nextCursor, hasMore }`; the cursor is
  opaque (clients pass it back verbatim).
- **Prefixed ID format** — `"<prefix>_<crockford-base32>"`.
- **Supported ID prefixes (12)** — `user`, `org`, `mem`, `role`, `perm`, `inv`,
  `prj`, `key`, `sess`, `rtok`, `evt`, `sevt`.
- **No numeric public IDs** — random suffix only; internal/sequential keys are
  never exposed.
- **Error-code catalog (9)** — `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`,
  `INTERNAL_ERROR`. Generic only — domain codes are added deliberately later.
- **Package dependency direction** — apps may depend on packages; nothing
  depends on `apps/api`; `contracts` and `shared` depend on neither apps nor DB;
  `db` does not depend on `config`. The main `@orgistry/shared` entrypoint stays
  browser-safe (Node-only code is isolated under `/node`).
- **No database entities as DTOs** — schema types are not exposed as API
  contracts.

## 9. Local Development and Validation

```bash
pnpm install                  # install workspace dependencies
cp .env.example .env          # create local env (loaded automatically by entry points)
pnpm infra:up                 # start PostgreSQL + Redis + Mailpit         [Docker]
pnpm db:migrate               # apply migration baseline                   [PostgreSQL]
pnpm db:reset:test            # rebuild the test database                  [PostgreSQL]
pnpm dev:api                  # boot API shell at :3000
pnpm dev:web                  # boot web demo at :5173
pnpm typecheck                # strict tsc across all packages/apps
pnpm test                     # 42 unit tests (no infrastructure)
pnpm validate                 # typecheck + lint placeholder + test
pnpm test:integration         # live DB + readiness suites      [PostgreSQL + Redis]
```

Infrastructure requirements:

- **No infrastructure:** `pnpm install`, `pnpm typecheck`, `pnpm test`,
  `pnpm validate`, `pnpm db:generate`, web build, `pnpm dev:web`.
- **Docker:** `pnpm infra:up` / `infra:down` / `infra:reset`.
- **PostgreSQL:** `pnpm db:migrate`, `pnpm db:reset:test`, and the DB integration
  test.
- **PostgreSQL + Redis:** `pnpm test:integration` (full), and a live `/ready`
  `200`.

`pnpm dev:api` boots without infrastructure; readiness simply reports
dependencies as down until they are up.

## 10. Documentation Index

| Document | Purpose |
| --- | --- |
| `README.md` | Entry point: what Sprint 1 is/isn't, prerequisites, setup, commands, health/readiness |
| `docs/sprint-1-foundation.md` | Full engineering reference: design decisions, contracts/invariants, integration notes, limitations, iteration changelog |
| `docs/local-development.md` | Day-to-day workflow and command reference |
| `docs/api-conventions.md` | Envelope, error-handling, request-ID, health/readiness, and pagination conventions |
| `docs/database-foundation.md` | DB layout, connection, schema registry, migrations, test reset, integration validation |
| `docs/sprint-1-artifact-package.md` | This document — official Sprint 1 completion artifact |

## 11. Validation Evidence

Final validation for this artifact (Docker daemon unavailable — see note):

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | ✅ Pass | Lockfile up to date |
| `pnpm typecheck` | ✅ Pass | All 6 packages + web app (incl. `vite.config.ts` and the `@orgistry/shared/node` subpath) |
| `pnpm test` | ✅ Pass | 42 unit tests across 11 files |
| `pnpm validate` | ✅ Pass | typecheck + lint placeholder (exit 0) + test |
| `pnpm --filter @orgistry/web-demo run build` | ✅ Pass | Vite production build |
| `pnpm db:generate` | ✅ Pass | No schema changes; confirms `drizzle.config.ts` resolves the `/node` subpath and loads env |
| `cp .env.example .env` → `pnpm db:migrate` | ✅ Pass | Ephemeral PostgreSQL; dotenv-loaded `.env`, no manual exports |
| `pnpm db:reset:test` | ✅ Pass | Ephemeral PostgreSQL; distinct `orgistry_test` |
| `pnpm test:integration` | ✅ Pass | Ephemeral PostgreSQL + Redis; 4 tests (2 DB migration + 2 live readiness) |
| `pnpm --filter @orgistry/api run start` + `GET /health`, `GET /ready` | ✅ Pass | `/health` → 200 success envelope; `/ready` → 200 success envelope, both checks `ok` |
| `pnpm infra:up` / `infra:down` (Docker) | ⚠️ Not run | **Docker daemon unavailable in this environment.** |

**Docker status:** Docker Compose was **not** exercised locally because the
daemon was unavailable. Equivalent validation was performed against an ephemeral
local PostgreSQL + Redis on the standard ports (5432 / 6379): the full
migrate → reset → integration → live `/health` + `/ready` path passed. The
Docker-equivalent path (PostgreSQL + Redis service containers) is covered by the
CI workflow, which has not yet been observed on a real GitHub runner.

## 12. Scope Control

Deliberately **not** implemented in Sprint 1:

- No auth (registration, login, logout, sessions, refresh-token rotation, email
  verification).
- No users/auth flows beyond the reserved `user`/`sess`/`rtok` ID prefixes.
- No organizations, memberships, roles, permissions, or access-control behavior.
- No entitlements or quotas.
- No invitations.
- No projects.
- No API keys.
- No audit logs or security events.
- No workers, queues, or object storage.
- No production deployment automation, OAuth, MFA, Stripe, OpenTelemetry, or
  PostgreSQL RLS.
- No public package publishing.
- No fake product state in the web demo (no auth/org/permission/project/plan/key/
  audit state).

The only domain-adjacent names present are the required ID-prefix registry and
the generic error-code catalog — both explicitly sanctioned Sprint 1 contracts.

## 13. Known Limitations and Remaining Risks

- **Docker Compose not locally exercised** — daemon unavailable; validated via an
  equivalent ephemeral PostgreSQL + Redis run. First verification on a Docker
  host should confirm `pnpm infra:up && pnpm db:migrate && pnpm test:integration`.
- **CI not yet observed on a real GitHub runner** — the workflow is logically
  complete (services, env, `orgistry_test` creation, step order); first run
  should confirm `psql` availability on the runner and service-health timing.
- **Lint is an intentional placeholder** — `pnpm lint` exits 0; strict `tsc` is
  the active gate. ESLint is deferred to a later sprint.
- **`app_meta` is a placeholder table** — exists only to validate the migration
  pipeline; carries no domain meaning.
- **No internal-package build/publish story** — source-only consumption is fine
  for local dev and CI; a production build/runtime story is per deploy target and
  out of scope.
- **No product/domain logic yet** — by design; this is a foundation.

The earlier `.env`-loading portability issue (reliance on `process.loadEnvFile`)
is **resolved** (now `dotenv`-based) and is not a current risk.

## 14. Confidence Assessment

```txt
Confidence: High
Reasoning:
- Full local validation is green: typecheck, 42 unit tests, validate, web build,
  db:generate.
- Live DB + readiness path verified end-to-end against ephemeral PostgreSQL +
  Redis: migrate, reset:test, 4 integration tests, and /health + /ready 200.
- Clean-clone DX confirmed: cp .env.example .env then db:migrate / reset:test /
  API boot work with no manual exports (deterministic dotenv loading).
- Architecture boundaries hold: shared main entrypoint is browser-safe, Node-only
  loading is isolated under /node, db does not depend on config, no DB entities
  as DTOs.
- Documentation is synchronized with the implementation (counts, mechanisms,
  guards, commands verified against code).
Caveats:
- Docker Compose not exercised locally (daemon unavailable); covered by an
  equivalent ephemeral-service run and by CI service containers.
- CI workflow not yet observed on a real GitHub runner.
```

## 15. Readiness for Sprint 2

The repository is **ready for Sprint 2 auth persistence**. Each foundation
concern auth will need is already in place and validated, so Sprint 2 does not
need to revisit:

- **Repo layout** — workspace and `apps/api/src/modules/*` convention are set;
  the first auth module slots in without restructuring.
- **Local infrastructure** — PostgreSQL, Redis, and Mailpit are defined and
  reachable; `orgistry_test` is auto-provisioned.
- **Typed config** — `JWT_SECRET`, `COOKIE_SECRET`, `COOKIE_SECURE`, and the
  rate-limit namespace are already declared and validated.
- **API bootstrap** — `buildApp`/`server.ts` split and injection-based testing
  make adding authenticated routes straightforward.
- **Request-ID handling** — propagation, echo, and logging are in place for
  correlating auth flows.
- **Error envelope** — `UNAUTHORIZED` / `FORBIDDEN` / `CONFLICT` codes and the
  central error path are ready for auth semantics.
- **DB migration flow** — schema registry + verified from-scratch migration and
  safe test reset are ready for `users` / `sessions` / `refresh_tokens` tables;
  the `user` / `sess` / `rtok` ID prefixes already exist.
- **Test harness** — unit (injection) and integration (live) layers are
  established, including a live readiness pattern auth tests can mirror.
- **CI quality gate** — install → typecheck → lint → test → migrate →
  integration against live services is wired and ready to guard auth work.

Sprint 2 can begin by adding auth tables and a first `apps/api/src/modules/auth`
module on top of this foundation.
