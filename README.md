# Orgistry

A TypeScript, local-first monorepo foundation. Sprint 1 established the technical
foundation; **Sprint 2 adds the authentication foundation** (register/login/
current-user, Argon2id password handling, JWT access tokens, durable security
events). No other product domain exists yet.

## What this is

A runnable, fully typed pnpm monorepo with:

- **`packages/config`** — single typed, validated source of runtime config (Zod).
- **`packages/contracts`** — frozen API conventions: success/error envelopes,
  error-code catalog, cursor-pagination baseline, and auth request/response DTOs.
- **`packages/shared`** — low-level primitives: prefixed ID generator, request
  ID helpers, clock, opaque cursor encoding.
- **`packages/auth-core`** — reusable security primitives: Argon2id password
  hashing, JWT access-token sign/verify, opaque-token generate/hash, email
  normalization, redaction. No HTTP or database concerns.
- **`packages/db`** — Drizzle ORM setup, connection factory, schema registry,
  migration baseline, a guarded test-database reset, and the auth tables.
- **`apps/api`** — Fastify app: health + readiness, request-id propagation,
  structured logging, central error handling, consistent envelopes, and the
  `/v1/auth/*` module (register, login, current-user).
- **`apps/web-demo`** — React/Vite shell with a static foundation status page.
- **`infra/`** — Docker Compose for PostgreSQL, Redis, and Mailpit.

## Auth at Sprint 2

`POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/auth/me`. Passwords are
hashed with Argon2id and stored hash-only; access tokens are short-lived JWTs;
failed logins are generic (no account-existence disclosure); auth activity is
written to durable, sanitized security events. See
[`docs/auth-foundation.md`](docs/auth-foundation.md).

## What is explicitly NOT implemented

Beyond the auth foundation above, there is no refresh-token rotation, refresh
cookie, logout, session listing/revocation, or email verification; and no
organizations, memberships, roles, permissions, entitlements, quotas, projects,
API keys, invitations, organization audit logs, workers/queues, object storage,
or product/auth UI. Registration does **not** create an organization, personal
workspace, membership, role, or permission. Auth rate limiting is **deferred** to
the session-lifecycle sprint. The web demo holds **no** fake auth/org/permission
state. The auth foundation is implemented and validated, but the system is **not
production-certified**. See [`docs/auth-foundation.md`](docs/auth-foundation.md)
(§E) and [`docs/sprint-1-foundation.md`](docs/sprint-1-foundation.md) for the
full scope boundary.

## Prerequisites

- Node.js >= 20 (developed on Node 22/25)
- pnpm >= 9 (repo pins `pnpm@10.29.3` via `packageManager`)
- Docker + Docker Compose (for local PostgreSQL / Redis / Mailpit)

## Local setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create your environment file
cp .env.example .env

# 3. Start local infrastructure (PostgreSQL, Redis, Mailpit)
pnpm infra:up

# 4. Apply the database migration baseline from scratch
pnpm db:migrate

# 5a. Boot the API shell        -> http://localhost:3000
pnpm dev:api

# 5b. Boot the web demo shell    -> http://localhost:5173
pnpm dev:web

# (or run both together)
pnpm dev
```

## Environment

All configuration is driven by environment variables validated in
`packages/config`. `.env.example` documents every variable and maps 1:1 to the
schema in `packages/config/src/schema.ts`. Invalid or missing required values
cause a clear failure before the process serves traffic. Secrets in
`.env.example` are local-only placeholders — never commit real secrets.

**`.env` loading.** Process and CLI entry points (`apps/api/src/server.ts`, the
DB scripts, `drizzle.config.ts`, and the integration tests) explicitly load the
workspace-root `.env` via `loadWorkspaceEnv()` from `@orgistry/shared/node`
(backed by `dotenv`, so it works across the entire supported Node range). So
`cp .env.example .env` is enough — no manual `export` is needed. Real
environment variables always take precedence over `.env`, so CI and explicit
exports win. Loading is explicit at entry points only; `packages/config` never
reads files on import, so libraries and unit tests are not surprised. The loader
is a Node-only utility, so it lives under the `@orgistry/shared/node` subpath —
the main `@orgistry/shared` entrypoint stays free of Node built-ins and
general/browser-safe.

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Run API and web demo together |
| `pnpm dev:api` | Run the API shell (watch mode) |
| `pnpm dev:web` | Run the web demo (Vite dev server) |
| `pnpm typecheck` | Strict `tsc --noEmit` across every package/app |
| `pnpm test` | Run unit tests (Vitest; excludes DB integration tests) |
| `pnpm test:integration` | Run DB migration + live API readiness integration tests (needs PostgreSQL + Redis) |
| `pnpm lint` | Lint placeholder (deferred — see docs); exits 0 |
| `pnpm validate` | `typecheck` + `lint` + `test` |
| `pnpm infra:up` | Start PostgreSQL, Redis, Mailpit (detached) |
| `pnpm infra:down` | Stop infrastructure |
| `pnpm infra:reset` | Stop infrastructure and delete volumes |
| `pnpm db:generate` | Regenerate SQL migrations from the schema |
| `pnpm db:migrate` | Apply migration baseline to `DATABASE_URL` |
| `pnpm db:reset:test` | Drop + recreate + migrate the **test** database (requires `TEST_DATABASE_URL` distinct from `DATABASE_URL`) |

## Infrastructure

`infra/docker-compose.yml` provides:

| Service | Host port(s) | Purpose |
| --- | --- | --- |
| `postgres` | 5432 | Durable local store |
| `redis` | 6379 | Future rate limiting; readiness probe |
| `mailpit` | 1025 (SMTP), 8025 (UI) | Future local email flows |

Mailpit UI: http://localhost:8025. On first start, the Postgres container also
creates the `orgistry_test` database (`infra/postgres-init/`), so
`pnpm db:reset:test` and the integration tests work without manual DB creation.

## Health & readiness

- `GET /health` — liveness only; never touches dependencies; always `200` when
  the process is up.
- `GET /ready` — checks PostgreSQL and Redis; `200` when both are reachable,
  `503` with a standard error envelope when any dependency is down.

## Documentation

- [`docs/sprint-2-artifact-package.md`](docs/sprint-2-artifact-package.md) —
  **official Sprint 2 completion artifact**: summary, validation evidence,
  security review, invariants, scope control, confidence, and next-sprint
  handoff.
- [`docs/auth-foundation.md`](docs/auth-foundation.md) — **Sprint 2 auth
  reference**: design, contracts/invariants, integration notes, limitations,
  changelog.
- [`docs/sprint-1-artifact-package.md`](docs/sprint-1-artifact-package.md) —
  **official Sprint 1 completion artifact**: capabilities, contracts, validation
  evidence, scope control, and Sprint 2 readiness.
- [`docs/sprint-1-foundation.md`](docs/sprint-1-foundation.md) — full developer
  + architectural reference, contracts/invariants, limitations, changelog.
- [`docs/local-development.md`](docs/local-development.md) — day-to-day workflow.
- [`docs/api-conventions.md`](docs/api-conventions.md) — envelope, error, and
  request-id conventions.
- [`docs/database-foundation.md`](docs/database-foundation.md) — schema,
  migrations, and test reset.
