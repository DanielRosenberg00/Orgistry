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

`pnpm db:check` runs `tooling/check-schema-drift.mjs`: it snapshots the
content of `packages/db/migrations`, regenerates Drizzle migrations from the
schema (offline — no database needed), and fails if regeneration changed
anything. The comparison is **content before-vs-after generation, not git
status** — a correctly generated migration that is not yet committed is in
sync and passes; anything generation adds, rewrites, or removes is drift. CI
runs on a clean checkout, so a schema change committed without its migration
still fails there. If it fails locally, you edited the schema without
regenerating: run `pnpm db:generate`, review the new migration, and include
it with the schema change. The snapshot/diff helpers are unit-tested
(`tooling/check-schema-drift.test.ts`).

## Integration validation: `pnpm validate:integration`

Requires live PostgreSQL + Redis (start them with `pnpm infra:up`; see the
[runbook](./runbook.md)). Redis is MANDATORY for a valid integration pass:
the real-Redis limiter suite
(`apps/api/src/lib/rate-limit.redis.integration.test.ts`) fails hard — it
never skips — so `pnpm validate:integration` exits non-zero when Redis is
unreachable rather than reporting a green run that silently omitted the
Redis evidence. (The DB-backed suites are separately gated by
`db:reset:test`, which refuses to run without a reachable test database.) The relevant environment variables must be set
(`DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
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
- The auth, registration, organization, member, projects, entitlements, and
  invitations routes behave correctly against a real database (transactional
  invariants, tenant isolation, quota enforcement).
- The credential lifecycle (Sprint 17) holds at the SQL layer: hash-only reset
  tokens, `FOR UPDATE`-serialized reset completion (two concurrent completions
  can never both succeed), session + refresh-token revocation in the same
  transaction as the password swap, the keep-current-session password-change
  policy, and the email-change verification reset
  (`password-recovery.integration.test.ts`).
- The verification-first registration lifecycle (Sprint 18) holds at the SQL
  layer: advisory-lock-serialized issuance leaving exactly one usable pending
  generation per email, `FOR UPDATE`-serialized completion (exactly one of any
  set of concurrent completions succeeds), the one-transaction creation of the
  email-verified user + personal workspace + session, and the savepoint-scoped
  invitation re-check (`registration.integration.test.ts`; the route-level
  suite is `registration.routes.test.ts`, the invitation-state public
  equality matrix lives in `invitation.routes.test.ts`, and the web demo's
  registration flows — plain and invitation-aware — are covered by
  `registration.test.tsx` and `invitation-registration.test.tsx`).
- The Sprint 19 edge hardening holds: a failed-auth **storm** integration test
  proves the per-IP durable-write bound on external API-key auth failures
  (writes stop at the allowance while the uniform 401 contract holds). The
  rest of the edge-security surface is covered by unit/route suites in the
  offline tier: `TRUST_PROXY` parsing and client-IP resolution, the security
  headers on every response class, the global per-IP limiter and the
  mutation/invitation throttles (429 envelopes, fail-open/fail-closed
  behavior), request-id sanitization, and pino logger redaction.

### Integration tests skip safely

If `TEST_DATABASE_URL`/`DATABASE_URL` or `REDIS_URL` are unset, the integration
suites **skip with a printed warning** rather than silently passing. A green run
with skips is not a validated run — check the output.

## Mailpit / email

The SMTP conversation is exercised by automated tests against an **in-process
fake SMTP server** (`apps/api/src/modules/mail/*.test.ts`) — including the
production driver's real implicit-TLS handshake and authentication exchange
(the protocol implementation is nodemailer since the Sprint 16 refinement),
header-injection rejection, and the email-verification lifecycle end to end
(unit + DB-backed integration suites, using the in-memory mailer). What is NOT automated: delivery to the
**live Mailpit container** (verified manually via the
[demo walkthrough](./demo-walkthrough.md); CI does not start Mailpit) and
delivery through a **real external provider** (never performed — no
credentials; see [known limitations](./known-limitations.md) and
[email-and-verification.md](./email-and-verification.md)).

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
