# Sprint 11 Artifact Package

**Sprint:** 11 — Web Demo Admin Surfaces
**Status:** Implementation complete; **Definition of Done met**. The full
validation matrix passes: workspace typecheck, the root unit suite (489 tests),
the web jsdom smoke suite (19 tests), the web production build, `pnpm db:generate`
(no schema drift), `git diff --check`, the DB-package integration suite (13
tests), and the API integration suite (38 tests, including the live-PostgreSQL
readiness test). The backend was not modified (see §4). Integration validation was
run against an isolated Orgistry PostgreSQL on an alternate host port because the
default port was occupied by an unrelated container — see §3 for the exact setup
and how to reproduce.
**Scope:** Turn `apps/web-demo` from a static foundation page into a coherent
authenticated admin interface that consumes the existing Orgistry APIs across the
operator journey — login, organization selection, overview, members, invitations,
projects, plan & entitlements, API keys, and audit log — with one central API
client, memory-only access tokens, refresh-cookie session restore, permission-
aware UX hints, consistent error/loading/empty states, and smoke tests.

This file is the authoritative Sprint 11 artifact and handoff record. The
developer / architecture / contract / integration reference lives in
[`docs/web-demo.md`](./web-demo.md).

> The web demo is a thin official consumer of Orgistry APIs.
>
> The backend remains authoritative for all authorization, entitlement, quota,
> and tenant-isolation decisions.

---

## 1. Implementation Summary

A single React/Vite app (`apps/web-demo`) now demonstrates:

```
/auth/login  /auth/register
/app/overview  /app/members  /app/invitations  /app/projects
/app/plan  /app/api-keys  /app/audit
```

Major areas implemented:

- **Bootstrap & routing** — `main.tsx` provider tree (BrowserRouter →
  QueryClientProvider → AuthProvider → OrganizationProvider), `App.tsx` route
  table, `ProtectedRoute` guard, `AppShell` layout with navigation, current-user
  display, organization switcher, and logout.
- **Central API client** (`src/api/`) — envelope unwrapping, typed `ApiError`
  (code/message/requestId/status/details), in-memory bearer injection,
  `credentials: include` + CSRF header on cookie-backed auth flows, single-flight
  refresh-on-401 retry, and a safe unexpected-error fallback.
- **Auth state** (`src/auth/`) — memory-only access token, refresh-cookie session
  restore at boot, login/register/logout, session-expiry reset.
- **Organization state** (`src/organization/`) — org list, persisted selection
  with graceful recovery, team-org creation, selected id as client context only.
- **Domain hooks** (`src/hooks/`) — effective permissions, members, invitations,
  projects, plan + entitlements, API keys, audit, on a shared `useCursorQuery`
  load-more wrapper.
- **Shared UI states** (`src/components/`) — `QueryBoundary` (loading/error),
  `EmptyState`, `LoadMore`, `ErrorBanner` (message + requestId + quota/entitlement
  details), `PermissionNote`.
- **Pages** (`src/pages/`) — Login, Register, Overview, Members, Invitations,
  Projects, Plan, ApiKeys, Audit, NotFound.
- **Tests** (`src/**/*.test.tsx`, `src/test/`) — API client envelope unit tests,
  error-banner rendering, auth/routing guard, org switcher, projects,
  one-time-secret display, audit DTO rendering, permission-disabled action.

No backend product domain, route, or schema was added or changed.

---

## 2. Security & Scope Verification

- **Access token storage:** held only in a module-scoped variable inside
  `src/api/client.ts`. It is never written to `localStorage`/`sessionStorage` and
  never placed in React state. A reload drops it; the session is restored from the
  HttpOnly refresh cookie. (`grep -R "localStorage\|sessionStorage" src` shows the
  token is never stored; only the **selected organization id** is persisted.)
- **Backend authority preserved:** all authorization, entitlement, quota,
  tenant-isolation, Last-Owner, invitation-validity, API-key, and audit-visibility
  decisions remain server-side. Client permission checks are UX hints; every page
  still renders the backend `FORBIDDEN` / `ENTITLEMENT_REQUIRED` / `QUOTA_EXCEEDED`
  / `LAST_OWNER_REQUIRED` / `CONFLICT` response.
- **API key secret handling:** the raw secret exists only in short-lived component
  state in `ApiKeysPage` immediately after creation, behind a "won't be shown
  again" warning, and is cleared on dismiss. It is never cached or persisted. No
  rotation and no secret-reveal surface were built.
- **Invitation tokens:** never displayed; the invitations page points operators to
  Mailpit for out-of-band delivery.
- **No forbidden scope introduced:** no billing/Stripe UI, no production email, no
  audit/CSV export, no API key rotation/reveal, no custom roles, no ABAC/RLS,
  workers, queues, deployment automation, or package publishing.

### Contract & security self-audit (refinement pass)

A focused audit of the web code against the existing backend routes/contracts:

- **API paths & methods — pass.** Every hook/provider call matches an existing
  route file exactly: auth register/login/me/refresh/logout; organizations
  list/create; `…/permissions/effective`; members list (GET) / role change
  (PATCH) / remove (DELETE); invitations list (GET) / create (POST) / revoke
  (DELETE); projects list/create (POST) / update (PATCH) / delete (DELETE); plan
  (GET) / entitlements (GET) / `plan/demo` (PATCH); api-keys list (GET) / create
  (POST) / revoke (DELETE); audit-events (GET, filters + cursor). No path or verb
  mismatch was found.
- **Envelopes — pass (one hardening).** The client unwraps `{ ok: true, data }`
  and maps `{ ok: false, error }` to a typed `ApiError`
  (code/message/requestId/details). Audit `meta` (`auditRetentionDays`) is part of
  the `data` payload (the envelope has no top-level `meta`), read from the first
  page. Hardening: the client now also recovers `requestId` from the backend's
  `x-request-id` echo header on the non-JSON/unrecognized fallback path, where no
  body envelope is available.
- **Auth & CSRF — pass.** Refresh (`POST /v1/auth/refresh`) and logout
  (`POST /v1/auth/logout`) paths are correct and use `credentials: include`. The
  backend's CSRF guard is presence-only (it checks the custom header exists; the
  real protection is `SameSite=Lax` + the CORS allow-list — see the backend
  `requireCsrfHeader`), so the client correctly sends the configured header with a
  non-empty value; it is **not** a real-token scheme, so no token is fabricated.
  Refresh-on-401 cannot loop: it fires only for authenticated, non-cookie requests
  that have not already retried, and refresh/login/register are all cookie-auth
  flows excluded from that path; the single-flight refresh plus the `retried`
  guard bound it to one retry. A regression test asserts a failed refresh retries
  at most once and surfaces the original 401.
- **Access-token storage — pass.** `accessToken` is handled only inside
  `src/api/client.ts` (a module closure) and handed to its setter from
  `AuthProvider`; the `Authorization` header is built only in the client. No
  `localStorage`/`sessionStorage` token writes. Only the selected organization id
  is persisted.
- **Raw API key secret — pass (one hardening).** Shown only immediately after
  create, held in short-lived component state, dismissable, never logged, never in
  storage, not documented as retrievable. Hardening: dismissing now also calls
  `createApiKey.reset()` so the secret is dropped from the mutation observer's
  retained result, leaving it nowhere after dismissal. A test asserts it never
  reaches web storage.
- **Permission-aware UX — pass.** Effective permissions only hide/disable actions;
  every mutating page still calls the API and renders the backend
  `FORBIDDEN`/`ENTITLEMENT_REQUIRED`/`QUOTA_EXCEEDED`/`LAST_OWNER_REQUIRED`
  response through `ErrorBanner`.
- **Direct fetch — pass.** The only `fetch(` in `src` (outside the client and test
  harness) is `query.refetch()` (TanStack Query, not a network call). All network
  traffic goes through the centralized client.

---

## 3. Tests & Validation

| Command | Result |
| --- | --- |
| `pnpm typecheck` (workspace, incl. web-demo) | **pass** |
| `pnpm test` (root unit suite, 489 tests) | **pass** |
| `pnpm --filter @orgistry/web-demo test` (19 jsdom smoke tests) | **pass** |
| `pnpm --filter @orgistry/web-demo build` (Vite production build) | **pass** |
| `pnpm db:generate` (schema drift) | **pass** — "No schema changes" |
| `git diff --check` | **pass** — no whitespace/conflict errors |
| `pnpm db:reset:test` (drop/recreate + migrate test DB) | **pass** |
| `pnpm --filter @orgistry/db test:integration` (13 tests) | **pass** |
| `pnpm --filter @orgistry/api test:integration` (38 tests, 8 files) | **pass** — incl. the live-PostgreSQL `readiness.integration.test.ts` (no longer skipped) |
| `pnpm lint` | placeholder (exits 0 by design; typecheck is the active gate) |

**Integration infrastructure note (reproducibility).** The repo's default
`pnpm infra:up` binds PostgreSQL to host port `5432`. In this environment that
port — and `5433` — were already held by unrelated projects' containers, so the
managed `orgistry-postgres-1` container could not publish its port (and the host
`localhost:5432` answered an unrelated database, failing `orgistry` auth with
`28P01`). Rather than disrupt another project's running database, the integration
suites were validated against a dedicated, isolated Orgistry PostgreSQL on a free
host port, with no source changes — the integration tests read the DB URL from the
environment (`TEST_DATABASE_URL` / `DATABASE_URL`), and `testConfig()` is only used
for secrets/probes, not the live connection:

```bash
docker run -d --name orgistry-pg-validate \
  -e POSTGRES_USER=orgistry -e POSTGRES_PASSWORD=orgistry -e POSTGRES_DB=orgistry \
  -p 55432:5432 \
  -v "$PWD/infra/postgres-init:/docker-entrypoint-initdb.d:ro" \
  postgres:16-alpine
export DATABASE_URL="postgres://orgistry:orgistry@localhost:55432/orgistry"
export TEST_DATABASE_URL="postgres://orgistry:orgistry@localhost:55432/orgistry_test"
export REDIS_URL="redis://localhost:6379"   # orgistry-redis-1 already up
pnpm db:reset:test
pnpm --filter @orgistry/db test:integration
pnpm --filter @orgistry/api test:integration
docker rm -f orgistry-pg-validate
```

On a machine where host port `5432` is free, the canonical
`pnpm infra:up && pnpm db:migrate && pnpm test:integration` flow validates the same
suites with no overrides. The throwaway container was removed after the run.

Smoke coverage (jsdom + mocked API through the real provider tree): login screen
renders; unauthenticated user is redirected from a protected route; authenticated
shell restores and renders; organization switcher lists organizations; projects
page renders the list and create affordance; API keys page shows and then clears
the one-time secret; audit page renders events from DTOs (with request id); a
permission-missing action is disabled with an explanatory note; the standard error
envelope renders with its request id; and the API client's envelope handling
(success, error, details, non-JSON fallback, bearer injection, refresh-on-401,
refresh-loop prevention, and `x-request-id` header recovery) is unit-tested. The
one-time-secret test also asserts the secret never reaches web storage.

---

## 4. Files Changed

**Web app (new):** `src/config.ts`, `src/queryClient.ts`, `src/api/{client,errors}.ts`,
`src/auth/{auth-context,AuthProvider,useAuth}.*`,
`src/organization/{org-context,OrganizationProvider,useOrganization}.*`,
`src/hooks/{useCursorQuery,useEffectivePermissions,useMembers,useInvitations,useProjects,usePlan,useApiKeys,useAudit}.ts`,
`src/components/{AppShell,ProtectedRoute,OrganizationSwitcher,ErrorBanner,QueryStates,PermissionNote}.tsx`,
`src/pages/{Login,Register,Overview,Members,Invitations,Projects,Plan,ApiKeys,Audit}Page.tsx`,
`src/lib/format.ts`, `src/styles.css`, `vitest.config.ts`,
`src/test/{setup,fixtures,harness}.*`, and `*.test.ts(x)` suites.

**Web app (modified):** `package.json` (added `react-router-dom`,
`@tanstack/react-query`, and test deps), `src/main.tsx`, `src/App.tsx`,
`src/pages/NotFoundPage.tsx`, `tsconfig.node.json`.

**Web app (refinement pass):** `src/api/errors.ts` + `src/api/client.ts`
(`x-request-id` header fallback for non-JSON errors), `src/pages/ApiKeysPage.tsx`
(`createApiKey.reset()` on secret dismiss), and the corresponding tests in
`src/api/client.test.ts` and `src/test/api-keys-secret.test.tsx`.

**Web app (removed):** `src/routes.ts`, `src/pages/FoundationStatusPage.tsx` (the
Sprint 1 static shell).

**Docs:** `docs/web-demo.md` (new), `docs/sprint-11-artifact-package.md` (new),
`README.md` and `docs/local-development.md` (web-demo references).

**Backend:** unchanged.

---

## 5. Readiness Assessment

Sprint 11 meets its Definition of Done: the full admin journey is implemented
against the existing APIs, the security model (memory-only token, HttpOnly refresh
cookie, one-time secret, no raw invitation tokens, backend-authoritative
everything) is upheld, and the complete validation matrix passes — workspace
typecheck, root unit suite (489), web smoke suite (19), web build, no schema drift,
clean `git diff --check`, and both the DB (13) and API (38) integration suites
against live PostgreSQL + Redis (§3). Documentation is synchronized with the
implementation.

Refinement opportunities for a later pass (not DoD blockers): full browser E2E
(Playwright) against the live backend; an invitation-acceptance/onboarding screen
using the existing `inspect`/`accept` endpoints; richer audit metadata rendering;
and responsive/accessibility polish.

---

## 6. Documentation Index

| Document | What it covers |
| --- | --- |
| [`docs/sprint-11-artifact-package.md`](./sprint-11-artifact-package.md) | This file — the official Sprint 11 completion artifact: implementation summary, security/scope verification, contract/security self-audit, full validation matrix with reproduction steps, files changed, confidence, remaining risks, readiness for the next sprint, and the living changelog. |
| [`docs/web-demo.md`](./web-demo.md) | The web demo reference (A–F): developer guide (where pieces live, how to run/validate/extend), architecture notes (thin-consumer rationale, envelope handling, memory-only tokens, refresh-cookie bootstrap, organization selection, permission-aware UX, tradeoffs, rejected alternatives), contracts & invariants, integration notes (page→API map), and known limitations. |
| [`README.md`](../README.md) | Top-level project README — the `apps/web-demo` description now reflects the admin UI, the local-setup steps boot it, and the documentation index links the Sprint 11 docs. |
| [`docs/local-development.md`](./local-development.md) | Day-to-day workflow — running the web demo, registering/creating an org, Mailpit for invitations, the CORS requirement for cookie flows, and web validation commands. |

No other docs were touched. Backend domain docs (auth, rbac, projects, plans,
api-keys, invitations, audit) remain accurate and unchanged — Sprint 11 added no
backend behavior.

---

## 7. Confidence Assessment

**Confidence: high. Sprint 11 is ready to close.**

Why it is ready:

- **Validation evidence.** The full matrix passes (§3): workspace typecheck; root
  unit suite (489); web jsdom smoke suite (19); web production build; `db:generate`
  no-drift; clean `git diff --check`; `db:reset:test`; DB-package integration (13);
  and the API integration suite (38 across 8 files), including the live-PostgreSQL
  `readiness.integration.test.ts`. Integration ran against live PostgreSQL + Redis.
- **Contract/security audit evidence (§2).** Every web API call matches an existing
  route and method; envelope/error handling is centralized and tested; auth/CSRF
  behavior matches the backend's presence-only guard; refresh-on-401 is provably
  non-looping (tested); access tokens are memory-only; the raw API key secret is
  shown once, dismissable, and never cached/persisted/logged (tested); raw
  invitation tokens are never exposed; permission checks are UX hints with backend
  errors always rendered; no ad hoc `fetch` exists outside the client.
- **Backend authority still holds.** The frontend issues no authorization,
  entitlement, quota, tenant-isolation, Last-Owner, invitation-validity, API-key, or
  audit-visibility decision. It renders state the backend owns and surfaces the
  backend's `FORBIDDEN` / `ENTITLEMENT_REQUIRED` / `QUOTA_EXCEEDED` /
  `LAST_OWNER_REQUIRED` / `CONFLICT` responses verbatim. The selected organization
  id is client context only; the backend re-resolves membership per request. No
  backend source file was modified (§4), and there is no schema drift.

---

## 8. Remaining Risks

These are real but **none is a Sprint 11 DoD blocker**:

- **No full browser E2E yet.** Coverage is jsdom component/route smoke tests with a
  mocked API through the real provider tree — strong on the integration seams, but
  not a real browser, real cookies, or the live backend end to end.
- **Demo-quality UI polish.** A single hand-written stylesheet; desktop-oriented;
  limited responsive/accessibility refinement beyond semantic markup and labels.
- **No invitation acceptance/onboarding screen.** The backend `inspect`/`accept`
  endpoints exist; the admin demo intentionally does not build a redemption flow.
- **Local infra port conflict.** When host port `5432` is occupied (as in the
  validation environment), integration runs need the documented alternate-port
  setup (§3). This is an environment constraint, not a code defect.

---

## 9. Readiness for Next Sprint

The next sprint can proceed without reopening any Sprint 11 surface. The following
are stable, documented contracts:

- **Frontend auth model** — memory-only access token + HttpOnly refresh cookie +
  boot-time refresh restore + single-flight refresh-on-401.
- **API client envelope handling** — one client, `{ ok, data }` / `{ ok, error }`
  parsing to a typed `ApiError`, request-id from body and header fallback.
- **Route protection** — `ProtectedRoute` guard over `/app/*`; public auth routes.
- **Organization switcher** — list, persisted selection, graceful recovery, team
  creation; selected id is client context only.
- **Permission-aware UX principle** — hints only; backend stays authoritative.
- **Admin page boundaries** — overview, members, invitations, projects, plan, API
  keys, audit; each maps to existing endpoints (page→API map in `web-demo.md` §D).
- **API key secret display** — one-time, short-lived state, reset on dismiss.
- **Audit UI data model** — renders the sanitized backend DTO; filters + load-more.
- **Error handling pattern** — `ErrorBanner` + `QueryBoundary`/`EmptyState`/`LoadMore`.
- **Validation approach** — the documented matrix, including the alternate-port
  integration runbook.

**Recommended next sprint: Maintenance, Hardening, and Documentation Polish.**
A non-feature, no-new-backend-module sprint to bring the repo to portfolio
readiness. Suggested focus (all additive/quality, no product scope):

- validation-matrix cleanup and a single `pnpm validate`-style entry point;
- replace the placeholder `pnpm lint` with a real ESLint gate (it currently exits 0);
- README polish and a concise architecture overview;
- local-setup verification + a Docker Compose runbook (incl. the port-conflict path);
- CI verification of the full matrix;
- seed-data improvements and a demo walkthrough script;
- a consolidated known-limitations page, security-model summary, API-surface index,
  and troubleshooting guide;
- a final portfolio-readiness pass.

No new backend product modules are recommended.

---

## 10. Sprint Changelog (living)

### Iteration 1 — initial implementation

- **Implementation:** added bootstrap/routing/providers, the central API client,
  auth + organization state, domain hooks, shared UI states, all nine pages, and
  the app shell; removed the Sprint 1 static status shell.
- **Documentation:** authored `docs/web-demo.md` (A–F) and this artifact package;
  referenced the web demo from `README.md` and `docs/local-development.md`.
- **Validation:** workspace typecheck, root unit suite (489), web smoke suite
  (17), and the Vite production build all pass; `db:generate` reports no drift;
  `git diff --check` clean. The backend integration suite was not yet run (no live
  PostgreSQL provisioned at the time).
- **Quality:** small named modules with explicit boundaries (pages → hooks → API
  client → fetch); no duplicated request logic; consistent error/loading/empty
  states; permission checks are UX-only with backend errors always rendered.
- **Remaining limitations:** see §5 and `docs/web-demo.md` §E (demo-quality UI,
  jsdom smoke tests rather than browser E2E, no acceptance/onboarding screen).

### Iteration 2 — validation + security/contract self-audit

- **Validation closed the DoD gap:** brought up an isolated Orgistry PostgreSQL
  (Redis already running) and ran the previously-unrun suites — `pnpm db:reset:test`,
  the DB integration suite (13), and the API integration suite (38, incl. the live
  readiness test). All pass. See §3 for the exact (port-conflict-avoiding) setup.
  The unrelated `vocab_postgres` container was left untouched.
- **Contract/security audit (§2):** API paths/methods, envelope handling, auth/CSRF
  behavior, token storage, raw-secret handling, permission-as-hint, and direct-fetch
  usage all audited — all pass, no contract mismatch found.
- **Two hardenings (no behavior regression):** the API client now recovers
  `requestId` from the `x-request-id` response header when an error body is
  missing/non-JSON; dismissing a created API key now also resets the create
  mutation so the raw secret is retained nowhere. Added regression tests for both,
  for refresh-loop prevention, and for secret non-persistence to web storage (web
  smoke suite 17 → 19).
- **Documentation:** corrected this artifact's status and §3 from "integration
  pending" to "integration passed" with reproduction steps; updated counts.
- **Remaining limitations:** unchanged and honest — no full browser E2E (jsdom
  smoke only), no invitation acceptance/onboarding screen, demo-quality UI. None
  are DoD blockers.
