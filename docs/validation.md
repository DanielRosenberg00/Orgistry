# Validation Matrix

How to validate Orgistry locally and in CI, what each command proves, and how to
read a failure. This is the authoritative, current reference — it matches the
package scripts in `package.json`.

There are two tiers:

- **Offline validation** (`pnpm validate`) — no databases, no network services.
  Runs anywhere, including a fresh clone.
- **Integration validation** (`pnpm validate:integration`) — requires live
  PostgreSQL + Redis.

## Quick reference

| Command | Tier | Proves |
| --- | --- | --- |
| `pnpm typecheck` | offline | Strict `tsc --noEmit` across every package/app — no type errors. |
| `pnpm lint` | offline | ESLint gate (API + packages + web demo) — no lint errors. |
| `pnpm test` | offline | Unit tests (Vitest), no infrastructure. |
| `pnpm test:web` | offline | Web demo component/routing tests (jsdom). |
| `pnpm build:web` | offline | Web demo production build succeeds. |
| `pnpm db:check` | offline | Committed Drizzle migrations match the schema (no drift). |
| `pnpm check:whitespace` | offline | `git diff --check` — no whitespace errors in the working tree. |
| **`pnpm validate`** | **offline** | **All of the above, in order.** |
| `pnpm db:reset:test` | integration | Drops + recreates + migrates the **test** database. |
| `pnpm test:integration` | integration | DB migration-from-scratch + live API readiness/route tests. |
| **`pnpm validate:integration`** | **integration** | **`db:reset:test` then `test:integration`.** |

## Offline validation: `pnpm validate`

```bash
pnpm install
pnpm validate
```

Runs, in order and failing fast on the first non-zero step:

1. `pnpm typecheck` — strict TypeScript across all workspaces.
2. `pnpm lint` — ESLint (see [ESLint gate](#eslint-gate)).
3. `pnpm test` — unit tests.
4. `pnpm test:web` — web demo tests.
5. `pnpm build:web` — web demo production build.
6. `pnpm db:check` — schema drift check.
7. `pnpm check:whitespace` — whitespace check.

Every step exits non-zero on failure, so `pnpm validate` is a reliable gate.
This is what a reviewer should run after `pnpm install`.

### ESLint gate

`pnpm lint` runs `eslint .` against the flat config in `eslint.config.js`. It
covers all hand-written TypeScript — the API, the shared packages, and the web
demo — using the typescript-eslint *recommended* rule set plus React hook
correctness rules for the web demo. It explicitly ignores generated SQL
migrations (`packages/db/migrations`), build outputs (`dist`/`build`),
coverage, and the lockfile. Formatting is intentionally not linted. The gate
fails on errors; a small number of advisory rules (e.g. `no-explicit-any`,
`react-hooks/exhaustive-deps`) are warnings.

### Schema drift check

`pnpm db:check` runs `tooling/check-schema-drift.mjs`: it regenerates Drizzle
migrations from the schema (offline — no database needed) and fails if that
produced any change under `packages/db/migrations`. A clean result means the
committed SQL matches `packages/db/src/schema`. If it fails, you edited the
schema without regenerating: run `pnpm db:generate`, review the new migration,
and commit it.

## Integration validation: `pnpm validate:integration`

Requires live PostgreSQL + Redis (start them with `pnpm infra:up`; see the
[runbook](./runbook.md)). The relevant environment variables must be set
(`DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET`,
`NODE_ENV=test`); `cp .env.example .env` provides working local defaults.

```bash
pnpm infra:up                # PostgreSQL, Redis, Mailpit
pnpm db:reset:test           # (or run the combined command below)
pnpm validate:integration    # db:reset:test + test:integration
```

`pnpm validate:integration` runs:

1. `pnpm db:reset:test` — drops the `public` and `drizzle` schemas in the **test**
   database and re-applies the migration baseline from scratch. Guarded: it
   refuses to run unless `TEST_DATABASE_URL` is set and differs from
   `DATABASE_URL`, so it can never wipe your dev database.
2. `pnpm test:integration` — the DB migration-from-scratch test plus the live API
   readiness and route integration tests against PostgreSQL + Redis.

### What integration validation proves

- Migrations apply cleanly from an empty database and seed the fixed roles,
  permissions, role→permission matrix, and plan catalog exactly (no drift from
  the `@orgistry/contracts` source of truth).
- `/ready` reports healthy only when PostgreSQL **and** Redis are reachable.
- The auth, organization, member, projects, entitlements, and invitations
  routes behave correctly against a real database (transactional invariants,
  tenant isolation, quota enforcement).

### Integration tests skip safely

If `TEST_DATABASE_URL`/`DATABASE_URL` or `REDIS_URL` are unset, the integration
suites **skip with a printed warning** rather than silently passing. A green run
with skips is not a validated run — check the output.

## Mailpit / email

No automated test exercises live SMTP. The invitation mailer is covered by unit
tests; the live delivery path is verified manually through the local Mailpit
container (see the [demo walkthrough](./demo-walkthrough.md)). CI therefore does
not start Mailpit. This is a deliberate, documented limitation
([known limitations](./known-limitations.md)).

## CI

`.github/workflows/ci.yml` mirrors this matrix as two jobs:

- **Validate (offline)** — install, typecheck, lint, unit tests, web tests, web
  build, schema drift check, whitespace check. Equivalent to `pnpm validate`.
- **Integration (PostgreSQL + Redis)** — spins up `postgres:16-alpine` and
  `redis:7-alpine` service containers, creates the test database, applies the
  migration baseline, and runs `pnpm validate:integration`.

Mailpit is intentionally omitted from CI (see above).

## Interpreting failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `typecheck` fails | Type error or unused local/param | Read the `tsc` error; fix the type or prefix an intentionally-unused binding with `_`. |
| `lint` fails | ESLint error | Run `pnpm lint` for the report; `pnpm lint:fix` auto-fixes mechanical issues. |
| `db:check` fails | Schema edited without regenerating migrations | `pnpm db:generate`, review, commit. |
| `check:whitespace` fails | Trailing whitespace / space-before-tab | Strip the offending whitespace shown by `git diff --check`. |
| `test:integration` skipped | Missing `TEST_DATABASE_URL` / `REDIS_URL` | Set env (`cp .env.example .env`) and ensure `pnpm infra:up` is healthy. |
| `db:reset:test` refuses to run | `TEST_DATABASE_URL` unset or equals `DATABASE_URL` | Point `TEST_DATABASE_URL` at a distinct database. |
| Integration tests fail to connect | Port conflict on 5432 / infra down | See [troubleshooting](./troubleshooting.md). |

See the [troubleshooting guide](./troubleshooting.md) for environment-level
failures (Docker not running, port conflicts, stale Drizzle artifacts, CI
service containers).
