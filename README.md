# Orgistry

A TypeScript, local-first monorepo foundation. Sprint 1 established the technical
foundation; Sprint 2 added the authentication foundation (register/login/
current-user, Argon2id password handling, JWT access tokens, durable security
events); Sprint 3 added the secure browser session lifecycle (refresh-token
rotation, HttpOnly refresh cookie, reuse detection, logout, session
listing/revocation, CSRF enforcement, Redis-backed auth rate limiting);
Sprint 4 added the organization foundation — the `User → Organization →
Membership` tenant layer, an auto-provisioned personal workspace at registration,
and authenticated team-organization create/list/read; Sprint 5 added
permission-first RBAC and member management; Sprint 6 added the Projects vertical
slice — the first organization-scoped business resource, completing the chain
`User → Organization → Membership → Role → Permission → Organization-Scoped
Resource`. **Sprint 7 adds entitlements, plans & quotas** — fixed internal demo
plans (Free/Pro/Business), per-organization plan state, an entitlement resolver,
reusable quota primitives, plan/entitlements read APIs, a demo plan-change API,
and `max_projects` quota enforcement on project create. It extends the chain to
`… → Permission → Entitlement → Quota → Organization-Scoped Resource`, keeping
**permission** (what the user may do), **entitlement** (what the plan allows), and
**quota** (how much may be used) strictly separate. There is no billing.

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
  migration baseline, a guarded test-database reset, and the auth + organization
  tables (incl. the seeded role baseline).
- **`apps/api`** — Fastify app: health + readiness, request-id propagation,
  structured logging, central error handling, consistent envelopes, the
  `/v1/auth/*` module (register, login, current-user, refresh, logout, session
  list/revoke) with the HttpOnly refresh cookie, CSRF guard, and rate limiting,
  and the `/v1/organizations` module (create/list/read with a reusable
  organization context resolver).
- **`apps/web-demo`** — React/Vite shell with a static foundation status page.
- **`infra/`** — Docker Compose for PostgreSQL, Redis, and Mailpit.

## Auth & organizations at Sprint 4

Register/login/current-user (Sprint 2) plus the secure session lifecycle
(Sprint 3):

`POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/auth/me`,
`POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/sessions`,
`DELETE /v1/auth/sessions/:sessionId`.

Passwords are Argon2id hash-only; access tokens are short-lived JWTs; the
refresh token is a high-entropy opaque string stored hash-only and delivered
**only** through an HttpOnly, SameSite=Lax cookie. Refresh rotates
transactionally (one successor per token) with reuse detection that revokes the
whole token family and its session. Cookie-backed mutations require a custom
CSRF header; auth endpoints are rate-limited via Redis (fail-open, never on the
auth-correctness path). All auth activity is written to durable, sanitized
security events.

The organization foundation (Sprint 4):

`POST /v1/organizations`, `GET /v1/organizations`,
`GET /v1/organizations/:organizationId`.

Registration now provisions the user's personal workspace (organization + active
Owner membership) atomically alongside the user/session/refresh token.
Authenticated users can create team organizations and list/read only the
organizations where they hold an active membership. Authorization is
membership-based and keyed on the organization **ID**, never the slug; a reusable
context resolver is the seam future organization-scoped routes build on. See
[`docs/auth-foundation.md`](docs/auth-foundation.md),
[`docs/session-lifecycle.md`](docs/session-lifecycle.md), and
[`docs/organization-foundation.md`](docs/organization-foundation.md).

The permission-first RBAC layer & member management (Sprint 5):

Global static RBAC reference (authenticated; **not** permission-enforced):
`GET /v1/roles`, `GET /v1/permissions`, `GET /v1/permissions/matrix`.

Organization-scoped, permission-enforced reads:
`GET /v1/organizations/:organizationId/roles` (`roles.read`),
`GET /v1/organizations/:organizationId/permissions` (`permissions.read`),
`GET /v1/organizations/:organizationId/permissions/matrix` (`permissions.read`),
`GET /v1/organizations/:organizationId/permissions/effective` (active membership).

Member management:
`GET /v1/organizations/:organizationId/members` (`members.read`),
`PATCH /v1/organizations/:organizationId/members/:membershipId/role` (`members.change_role`),
`DELETE /v1/organizations/:organizationId/members/:membershipId` (`members.remove`).

The Projects vertical slice — first organization-scoped business resource (Sprint 6):

`GET /v1/organizations/:organizationId/projects` (`projects.read`),
`POST /v1/organizations/:organizationId/projects` (`projects.create`),
`GET /v1/organizations/:organizationId/projects/:projectId` (`projects.read`),
`PATCH /v1/organizations/:organizationId/projects/:projectId` (`projects.update`),
`DELETE /v1/organizations/:organizationId/projects/:projectId` (`projects.delete`).

Projects prove the tenant-scoped resource pattern: every query is scoped by the
route **organization ID**, authorization composes `requireMembership` →
`requirePermission(actor, "projects.read")` (never a role-name check), the list is
cursor-paginated, deletion is **soft** (`deleted_at` + `deleted_by_user_id`; no
hard delete, no restore), and cross-tenant or deleted targets return an
indistinguishable `PROJECT_NOT_FOUND` 404 so existence never leaks.
`project.created` / `.updated` / `.deleted` are recorded on the internal action-
event seam (no read API). Projects are intentionally small — the canonical
template for future organization-scoped resources. See
[`docs/projects.md`](docs/projects.md).

Entitlements, plans & quotas (Sprint 7):

`GET /v1/organizations/:organizationId/plan` (`plan.read`),
`GET /v1/organizations/:organizationId/entitlements` (`plan.read`),
`PATCH /v1/organizations/:organizationId/plan/demo` (`plan.change_demo`).

Three fixed internal **demo** plans (Free/Pro/Business) carry the entitlement and
quota values — `max_members`, `max_projects`, `max_api_keys`, `api_keys_access`,
`audit_log_access`, `audit_retention_days`. Every organization gets one
`organization_plans` row (default **Free**) at provisioning; the catalog is
code-defined and the only way to change a plan is the demo endpoint (no billing).
An organization-level **entitlement resolver** maps plan → values (fail-safe if
plan state is missing, independent of user role), and reusable **quota** helpers
(`requireQuota` / `requireEntitlement`) stay separate from `requireMembership` /
`requirePermission`. Project create enforces `max_projects` **after** the
permission check: a Viewer is still blocked by permission, an authorized user is
blocked by `QUOTA_EXCEEDED` at the ceiling (no project, no `project.created`), and
upgrading the plan re-allows creation. `plan.changed_demo` is recorded on the
internal event seam. See
[`docs/entitlements-plans-quotas.md`](docs/entitlements-plans-quotas.md).

The four fixed roles (Owner/Admin/Member/Viewer) map to a fixed, code-defined
permission catalog seeded idempotently into the database. **Permissions are the
authorization primitive**: organization-scoped routes compose
`requireMembership` → `requirePermission(actor, "members.read")`, never a role-name
check. The org-scoped roles/permissions/matrix reads enforce `roles.read` /
`permissions.read` and reflect the seeded mapping (no drift); the global `/v1/*`
catalog is authenticated static reference only and must not be read as a tenant's
authorization state. Member listing, role changes, and soft removal are gated by
`members.read` / `members.change_role` / `members.remove`, and the **Last Owner**
invariant — every active organization keeps at least one active Owner — is
enforced **transactionally** (the sole place a role name is consulted). Removed
memberships never grant access. See
[`docs/rbac-permissions.md`](docs/rbac-permissions.md).

## What is explicitly NOT implemented

Beyond the auth lifecycle, organization foundation, the RBAC/member-management
layer, and the entitlements/plans/quotas layer above, there is no email
verification, password reset, MFA, OAuth, or passkeys; and no **billing of any
kind** (no Stripe, checkout, billing portal, subscription, invoice, payment, or
real subscription status — plans are internal demo plans only, switched solely via
the demo endpoint), no **custom plans or per-organization custom entitlements**
and no feature-flag system, no **custom or organization-defined roles** (the four
system roles are fixed), permission/role mutation APIs, resource-level
permissions, ABAC or policy engine, RLS, invitations, API key lifecycle
(create/list/revoke) or external API, audit retention deletion job, an external
projects API, project restore or hard delete, **user-facing** organization audit
log (member, project, and plan actions are recorded internally on the audit seam
only — no read API), organization lifecycle (archive/suspend) endpoints,
workers/queues, object storage, or product/workspace/members/permission/**projects**/**plan**
UI. The `max_members`, `max_api_keys`, `api_keys_access`, `audit_log_access`, and
`audit_retention_days` entitlements are modeled and resolvable but their consuming
features (invitations, API keys, audit read, retention) are future scope. The web
demo holds **no** auth/organization/projects/plan UI or authenticated shell and
**no** fake auth/org/permission state. The implemented surface is validated, but
the system is **not production-certified**. See
[`docs/rbac-permissions.md`](docs/rbac-permissions.md) (§E),
[`docs/organization-foundation.md`](docs/organization-foundation.md) (§E),
[`docs/session-lifecycle.md`](docs/session-lifecycle.md) (§E),
[`docs/auth-foundation.md`](docs/auth-foundation.md) (§E), and
[`docs/sprint-1-foundation.md`](docs/sprint-1-foundation.md) for the full scope
boundary.

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

- [`docs/sprint-7-artifact-package.md`](docs/sprint-7-artifact-package.md) —
  **official Sprint 7 completion artifact**: entitlements/plans/quotas summary,
  documentation index, validation evidence, the permission-vs-entitlement-vs-quota
  separation proof, confidence assessment, remaining risks, and next-sprint
  readiness.
- [`docs/entitlements-plans-quotas.md`](docs/entitlements-plans-quotas.md) —
  **Sprint 7 entitlements/plans/quotas reference** (A–F): the plan catalog,
  entitlement resolver, quota primitives, plan API, enforcement order, the recipe
  for adding an entitlement/quota or enforcing one on a new write,
  architecture/tradeoffs, contracts/invariants, integration (incl. future Stripe
  mapping), limitations.
- [`docs/sprint-6-artifact-package.md`](docs/sprint-6-artifact-package.md) —
  **official Sprint 6 completion artifact**: Projects vertical slice summary,
  validation evidence, authorization/tenant-isolation proof, invariants, scope
  control, and confidence assessment.
- [`docs/projects.md`](docs/projects.md) — **Sprint 6 Projects reference** (A–F):
  the organization-scoped resource pattern, route/service/repository/contracts/
  database wiring, the recipe for adding the next tenant-scoped resource,
  contracts/invariants, integration, limitations.
- [`docs/sprint-5-artifact-package.md`](docs/sprint-5-artifact-package.md) —
  **official Sprint 5 completion artifact**: permission-first RBAC + member
  management summary, validation evidence, invariants, scope control, and
  next-sprint handoff.
- [`docs/rbac-permissions.md`](docs/rbac-permissions.md) — **Sprint 5 RBAC &
  member-management reference** (A–F): permission catalog, role→permission
  mapping, access-control helpers, member lifecycle, Last Owner protection,
  contracts/invariants, integration, limitations.
- [`docs/sprint-4-artifact-package.md`](docs/sprint-4-artifact-package.md) —
  **official Sprint 4 completion artifact**: organization foundation summary,
  validation evidence, invariants, scope control, confidence, and next-sprint
  handoff.
- [`docs/organization-foundation.md`](docs/organization-foundation.md) —
  **Sprint 4 organization reference** (A–F): tenant model, provisioning, slug and
  membership strategy, context resolver, invariants, integration, limitations.
- [`docs/sprint-3-artifact-package.md`](docs/sprint-3-artifact-package.md) —
  **official Sprint 3 completion artifact** for the secure session lifecycle.
- [`docs/session-lifecycle.md`](docs/session-lifecycle.md) — **Sprint 3 session
  lifecycle reference**: refresh/rotation/reuse/logout/CSRF/rate-limit design.
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
