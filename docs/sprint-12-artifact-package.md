# Sprint 12 — Maintenance, Hardening & Documentation Polish

**Official Sprint 12 completion artifact.** Sprint 12 was a maintenance,
hardening, validation, and documentation pass. It added **no product
capability** — no backend module, frontend product surface, route, permission,
role, entitlement, quota, billing, OAuth/MFA/password-reset, production email,
worker/queue, RLS, custom role, resource-level permission, audit export, webhook,
SDK, or deployment automation. It consolidates and hardens what Sprints 1–11
already built so the system is easier to run, validate, review, demo, and trust.

This artifact reflects the **final verified state** after the implementation pass
and the subsequent verification audit.

---

## 1. Implementation Summary

### Validation command structure

A single offline entry point and a single live-service entry point now exist:

- **`pnpm validate`** (offline, no services): `typecheck → lint → test →
  test:web → build:web → db:check → check:whitespace`, failing non-zero on the
  first problem. Runs anywhere, including a fresh clone.
- **`pnpm validate:integration`** (live): `db:reset:test → test:integration` —
  the DB migration-from-scratch suite plus the live API readiness/route suites
  against PostgreSQL + Redis.

Supporting scripts added: `lint`, `lint:fix`, `test:web`, `build:web`,
`db:check`, `check:whitespace`, `demo:seed`.

### Real lint gate

The Sprint-1 `tooling/lint-placeholder.mjs` (a no-op that exited 0) was deleted
and replaced by a real **ESLint 9 flat config** (`eslint.config.js`) over the
API, all packages, and the web demo, using the typescript-eslint *recommended*
rule set plus React hook rules for the web demo. Generated SQL migrations, build
outputs, coverage, `node_modules`, and the lockfile are explicitly ignored.
Formatting is intentionally not linted. The gate fails on errors; a few advisory
rules are warnings.

### Schema drift check

`pnpm db:check` (`tooling/check-schema-drift.mjs`) regenerates Drizzle migrations
offline (no database needed) and fails if that produces any change under
`packages/db/migrations`. It is wired into `pnpm validate` and CI and leaves the
working tree clean when the schema and migrations are already in sync.

### CI strategy

`.github/workflows/ci.yml` was rebuilt as two jobs that mirror the local matrix:

- **Validate (offline)** — install, typecheck, lint, unit tests, web tests, web
  build, schema-drift check, whitespace check (equivalent to `pnpm validate`).
- **Integration (PostgreSQL + Redis)** — `postgres:16-alpine` + `redis:7-alpine`
  service containers, create the test database, apply the migration baseline, and
  run `pnpm validate:integration`.

Mailpit is intentionally omitted from CI and documented as such.

### Local setup / runbook improvements

A new [`docs/runbook.md`](./runbook.md) documents the local services (PostgreSQL,
Redis, Mailpit), their ports and env, start/stop/reset flows, Mailpit inspection,
how to run integration tests, and **practical port-conflict handling** — including
the alternate-port strategy for the common case where PostgreSQL 5432 is already
occupied.

### Environment documentation

`.env.example` now documents the web demo's `VITE_API_BASE_URL`,
`VITE_CSRF_HEADER_NAME`, and `VITE_MAILPIT_URL` (previously discoverable only in
`apps/web-demo/src/config.ts`) and clarifies the web demo port. Every variable in
the `packages/config` schema is represented.

### README / architecture / security / API documentation

- **README.md** rewritten as a concise, current, engineering-first review entry
  point with an authoritative-vs-historical documentation index.
- New [`docs/architecture.md`](./architecture.md), [`docs/security-model.md`](./security-model.md),
  and [`docs/api-surface.md`](./api-surface.md) (full route index by domain).

### Known limitations / troubleshooting

- New [`docs/known-limitations.md`](./known-limitations.md) — honest, consolidated
  scope boundary.
- New [`docs/troubleshooting.md`](./troubleshooting.md) — symptom-driven fixes for
  install, Docker, port conflicts, migrations, CORS/cookies, integration env,
  stale Drizzle artifacts, and CI service containers.

### Demo seed and walkthrough

- New `tooling/demo-seed.mjs` (`pnpm demo:seed`) drives the **real public HTTP
  API** to build a presentable, idempotent demo state: a registered owner with an
  auto-provisioned personal workspace, a team org on the Pro plan, three projects,
  a pending invitation (delivered to Mailpit), and an API key whose one-time
  secret is printed with a ready-to-run external-API `curl`.
- New [`docs/demo-walkthrough.md`](./demo-walkthrough.md) — an executable reviewer
  flow (automated bootstrap and manual path) requiring no hidden setup.

### Documentation consistency audit

Stale current-state claims were corrected: the README no longer claims the web
demo holds no admin UI; `infra/docker-compose.yml` and
`packages/config/src/schema.ts` no longer describe Redis rate limiting / Mailpit
email as "future"; `docs/local-development.md` reflects the real ESLint gate. The
per-sprint artifacts are retained as historical records and labeled as such.

### Portfolio-readiness polish

The README reads engineering-first (not a sprint log, not marketing). Docs are
indexed and cross-linked, all internal links resolve, no real secrets or
generated junk are committed, and no production-readiness claims were introduced.

**This was not a feature sprint.** No new product capability was added.

---

## 2. Documentation Index

### Current authoritative docs

| Document | Purpose |
| --- | --- |
| [`README.md`](../README.md) | External review entry point: what Orgistry is, capabilities, architecture at a glance, run/validate, docs index, limitations. |
| [`docs/architecture.md`](./architecture.md) | Current system shape: monorepo structure, responsibilities, data/auth/RBAC/entitlement/resource models, design decisions. |
| [`docs/security-model.md`](./security-model.md) | Consolidated security posture: credentials, sessions, CSRF, rate limits, tenancy, authorization, API keys, invitations, audit, non-production caveats. |
| [`docs/api-surface.md`](./api-surface.md) | Consolidated route index by domain, with auth type, permission, and entitlement per route. |
| [`docs/validation.md`](./validation.md) | The validation matrix: offline vs integration, what each command proves, failure interpretation, CI mapping. |
| [`docs/runbook.md`](./runbook.md) | Local infrastructure operations: services, ports, env, resets, Mailpit, port-conflict handling. |
| [`docs/troubleshooting.md`](./troubleshooting.md) | Symptom-driven fixes for local and CI failures. |
| [`docs/known-limitations.md`](./known-limitations.md) | Honest, consolidated scope boundary and accepted compromises. |
| [`docs/demo-walkthrough.md`](./demo-walkthrough.md) | Executable reviewer flow (automated `demo:seed` + manual path). |
| [`docs/local-development.md`](./local-development.md) | Day-to-day developer workflow and quality gates. |
| [`docs/api-conventions.md`](./api-conventions.md) | Response envelopes, error codes, request-id conventions. |

### Subsystem references

[`docs/auth-foundation.md`](./auth-foundation.md) ·
[`docs/session-lifecycle.md`](./session-lifecycle.md) ·
[`docs/organization-foundation.md`](./organization-foundation.md) ·
[`docs/rbac-permissions.md`](./rbac-permissions.md) ·
[`docs/projects.md`](./projects.md) ·
[`docs/entitlements-plans-quotas.md`](./entitlements-plans-quotas.md) ·
[`docs/api-keys-external-api.md`](./api-keys-external-api.md) ·
[`docs/invitations.md`](./invitations.md) ·
[`docs/audit-log.md`](./audit-log.md) ·
[`docs/database-foundation.md`](./database-foundation.md) ·
[`docs/web-demo.md`](./web-demo.md).

### Historical artifacts

The per-sprint completion artifacts (`docs/sprint-1-artifact-package.md` …
`docs/sprint-11-artifact-package.md`, plus `docs/sprint-1-foundation.md`) and this
Sprint 12 artifact are **historical records** describing the system at the time
each sprint shipped. For current behavior, the authoritative docs above take
precedence; the historical artifacts must not be read as the current state.

---

## 3. Confidence Assessment

Confidence is **high** for the maintenance/hardening goals, based on the
following evidence (all re-run during the final completion pass):

| Check | Result |
| --- | --- |
| `pnpm lint` | **Pass** — exit 0, ESLint over API + packages + web demo, 0 errors / 0 warnings. |
| `pnpm db:check` | **Pass** — exit 0; working tree left **clean** (no generated migration noise). |
| `pnpm validate` | **Pass** — exit 0; typecheck, lint, **489 unit tests** (53 files), **19 web tests** (5 files), web build, schema-drift, whitespace. |
| `pnpm validate:integration` | **Pass** — exit 0; **13 DB integration tests** + **38 API integration tests**; test DB reset + migrated from scratch. Run non-destructively against a throwaway PostgreSQL on host port **55432** (local 5432 occupied), using the existing Redis; throwaway container removed afterward; the user's services were untouched. |
| API route index verification | **Pass** — 40 documented routes in `docs/api-surface.md` exactly match 40 source route registrations (zero fictional, zero undocumented); permission/entitlement columns spot-checked against actual service-layer guards. |
| Markdown link verification | **Pass** — all internal links in README + `docs/*.md` resolve. |
| Environment variable coverage | **Pass** — all 33 config-schema variables present in `.env.example`; extras are only the expected `VITE_*`, `POSTGRES_*` (compose), and `TEST_DATABASE_URL`. |
| Stale-claim scan | **Pass** — no stale current-state claims in authoritative docs/current code (remaining "placeholder" hits are legitimate). |
| Secret / generated-junk hygiene | **Pass** — no real secrets committed (only a clearly-labeled fake example in a historical doc); `apps/web-demo/dist/` is gitignored and not tracked. |
| Demo seed safety | **Pass** — drives the public API only, preserves registration→personal-workspace provisioning, idempotent, local-only labeled credentials, one-time secret printed to stdout only, clear failure when the API is unreachable. |

Confidence is scoped to the implemented surface and the developer/reviewer
experience. **The system is not production-certified** (see §4).

---

## 4. Remaining Risks

Only real, documented risks remain:

- **Integration validation depends on live services and local port
  availability.** The offline gate is fully portable; the integration gate needs
  PostgreSQL + Redis and is sensitive to port conflicts (PostgreSQL 5432 most
  often). Mitigated by the runbook's alternate-port guidance and the
  troubleshooting guide.
- **Mailpit/SMTP is not fully automated in CI.** The invitation mailer has unit
  coverage; the live SMTP delivery path is exercised manually via `demo:seed` /
  the walkthrough. Documented in known limitations.
- **No full browser end-to-end tests yet.** The web demo is covered by jsdom
  component/routing tests, not a real-browser E2E harness.
- **Web demo is demo-quality UI** — a thin, official API consumer for reviewing
  backend behavior, not a polished product surface. Permission-aware UI is a hint;
  the backend remains authoritative.
- **Not production-certified.** No billing, OAuth/MFA/password reset, production
  email, workers, RLS, custom roles, resource-level permissions, audit
  retention/export, or deployment automation (intentional scope boundary).
- **Local infrastructure assumptions** — defaults assume Postgres 5432, Redis
  6379, Mailpit 1025/8025, API 3000, web demo 5173 on localhost.
- **Rate limiting fails open** — a Redis outage allows requests rather than
  blocking them, so auth is never broken, at the cost of no limiting during the
  outage.
- **Accepted quota race windows** — quota checks read-then-write without a global
  lock; under adversarial concurrency two requests could both pass at the ceiling.
  An accepted demo-scale trade-off.

No resolved implementation item is listed here as an open risk.

---

## 5. Readiness for Next Sprint

Sprint 12 is **ready for completion**, and the project is ready to move on.

The next sprint should be **either**:

- **Final Review and Portfolio Packaging**, or
- **Web Demo UX Refinement**, if visual polish becomes the chosen priority.

The next sprint **should not** revisit the validation command structure, the lint
baseline, the CI validation strategy, the local setup docs, the README structure,
the architecture overview, the security model, the API index, the known
limitations, the troubleshooting guide, or the demo walkthrough — **unless a real
defect is found** in one of them. These are now stable, verified deliverables; reopening
them without cause would be churn.

---

## 6. Scope Control

Explicitly confirmed for Sprint 12:

- **No new backend product module** was introduced.
- **No new frontend product surface** was introduced beyond maintenance/demo
  polish supporting already-implemented behavior.
- **No new API route** was introduced (40 routes before and after).
- **No new permission, role, entitlement, or quota** was introduced.
- **No billing, OAuth, MFA, password reset, or production email** was introduced.
- **No production deployment automation** was introduced.
- **No real secrets** were added (`.env.example` and `demo:seed` use local-only,
  clearly-labeled, non-secret development values).
- **No unsupported production-readiness claim** was added.

The web demo remains a thin official API consumer; the backend remains the sole
source of truth for authorization, entitlements, quotas, and tenancy.

---

## 7. Final Reviewer Commands

```bash
pnpm install               # install workspace dependencies
pnpm validate              # offline gate — no services required

pnpm infra:up              # start PostgreSQL, Redis, Mailpit
pnpm validate:integration  # live gate — needs PostgreSQL + Redis

pnpm db:migrate            # apply the migration baseline (dev database)
pnpm dev                   # run API (:3000) + web demo (:5173)
pnpm demo:seed             # populate a presentable demo state (API must be running)
```

If **PostgreSQL port 5432 is already occupied** locally (the most common setup
failure), follow the alternate-port guidance in
[`docs/runbook.md`](./runbook.md#handling-port-conflicts) before
`pnpm validate:integration`. `pnpm demo:seed` requires the API to be running
(`pnpm dev:api` or `pnpm dev`).

---

## 8. Git State Note

At the time of writing, the repository has **unstaged** changes (modified +
untracked files); **nothing is staged**, and **no commit or push was made**. The
exact `git status --short` is reproduced in the accompanying completion report.

This artifact was produced as a documentation pass only. The maintainer should
review and commit the Sprint 12 changes when ready.
