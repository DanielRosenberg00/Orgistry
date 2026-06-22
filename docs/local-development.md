# Local Development

Day-to-day workflow for the Orgistry foundation.

## First-time setup

```bash
pnpm install
cp .env.example .env
pnpm infra:up        # PostgreSQL, Redis, Mailpit
pnpm db:migrate      # apply migration baseline
```

## Running

```bash
pnpm dev             # API + web demo together
pnpm dev:api         # API only  -> http://localhost:3000
pnpm dev:web         # web only  -> http://localhost:5173
```

The API boots even if PostgreSQL or Redis is down — the connection is lazy and
`/ready` reports the outage. Use this to confirm health vs. readiness behavior:

```bash
curl -i http://localhost:3000/health   # 200 always (process up)
curl -i http://localhost:3000/ready    # 200 if deps reachable, else 503
```

## Quality gates

```bash
pnpm typecheck       # strict tsc across all packages/apps
pnpm test            # unit tests (no infrastructure required)
pnpm lint            # placeholder, exits 0 (see sprint-1-foundation.md)
pnpm validate        # typecheck + lint + test
```

## Database

```bash
pnpm db:generate         # regenerate SQL after editing schema
pnpm db:migrate          # apply baseline to DATABASE_URL
pnpm db:reset:test       # drop + recreate + migrate the TEST database
pnpm test:integration    # migration-from-scratch + live API readiness (needs PostgreSQL + Redis)
```

`db:reset:test` is guarded: it requires an explicit `TEST_DATABASE_URL` that
**differs from `DATABASE_URL`**, so it can never drop your dev/prod database.
(This replaces an earlier `NODE_ENV=test` guard that broke the clean-clone flow,
since the default `.env` sets `NODE_ENV=development`.) The `orgistry_test`
database is created automatically by the Postgres container on first start
(`infra/postgres-init/`).

All these commands rely on the workspace-root `.env`, loaded explicitly by the
entry points and integration tests via `loadWorkspaceEnv()` from
`@orgistry/shared/node` (`dotenv`-backed, works across the whole supported Node
range) — `cp .env.example .env` is enough; no manual `export` required. The
loader is Node-only and kept off the general `@orgistry/shared` entrypoint.

## Infrastructure

```bash
pnpm infra:up        # start (detached)
pnpm infra:down      # stop
pnpm infra:reset     # stop and delete volumes (wipes local data)
```

| Service | Port(s) | Notes |
| --- | --- | --- |
| PostgreSQL | 5432 | durable store |
| Redis | 6379 | readiness probe; future rate limiting |
| Mailpit | 1025 / 8025 | SMTP / web UI (http://localhost:8025) |

## Notes

- Internal `@orgistry/*` packages are consumed as TypeScript source — no build
  step. Edits are picked up directly by `tsx`, Vite, Vitest, and `tsc`.
- Logs are structured JSON and include a `requestId` per request. Send an
  `x-request-id` header to correlate a client request through the logs and the
  response.
