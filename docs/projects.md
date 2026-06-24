# Projects — Organization-Scoped Resource (Sprint 6)

Orgistry's first real organization-scoped business resource. Projects prove the
**tenant-scoped resource pattern** end to end: organization-scoped persistence,
permission-first authorization, cursor pagination, soft deletion, safe
cross-tenant failure, and internal action-event recording. They complete the
core chain:

```
User → Organization → Membership → Role → Permission → Organization-Scoped Resource
```

Projects are intentionally **small**. They are not a product domain — they are
the canonical template every future organization-scoped resource copies. Sprint 6
does **not** implement entitlements, quotas, plan enforcement, invitations, API
keys, an external projects API, a web demo Projects page, a workspace switcher, a
full audit-log read API, a generic CRUD framework, custom roles, resource-level
permissions, ABAC/policy engines, PostgreSQL RLS, a project restore endpoint, a
hard-delete endpoint, or bulk operations. See [§E](#e-known-limitations).

---

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Project DTOs, request/response contracts, list query, route params | `packages/contracts/src/projects.ts` |
| `PROJECT_NOT_FOUND` error code | `packages/contracts/src/error-codes.ts` |
| `projects` table (prefixed `prj_` ids, soft-delete columns, indexes) | `packages/db/src/schema/projects.ts` |
| Generated migration (table + indexes) | `packages/db/migrations/0004_great_kid_colt.sql` |
| Tenant-aware project repository (org-scoped CRUD + event writes) | `apps/api/src/modules/projects/project.repo.ts` |
| Project repository boundary + params/types | `apps/api/src/modules/projects/project.types.ts` |
| Project service (membership → permission → query → DTO → event) | `apps/api/src/modules/projects/project.service.ts` |
| Project routes (the five-endpoint surface) | `apps/api/src/modules/projects/project.routes.ts` |
| Project not-found error factory | `apps/api/src/modules/projects/project.errors.ts` |
| Project action-event types (the internal seam) | `apps/api/src/modules/projects/project.events.ts` |
| In-memory project repo + test app builder | `apps/api/src/modules/projects/testing/*` |
| Service wiring (DB repo + access-control repo) | `apps/api/src/server.ts`, `apps/api/src/app.ts` |

### Endpoints

```
GET    /v1/organizations/:organizationId/projects              -> 200 { items: Project[], nextCursor, hasMore }  (projects.read)
POST   /v1/organizations/:organizationId/projects              -> 201 { project }                                (projects.create)
GET    /v1/organizations/:organizationId/projects/:projectId   -> 200 { project }                                (projects.read)
PATCH  /v1/organizations/:organizationId/projects/:projectId   -> 200 { project }                                (projects.update)
DELETE /v1/organizations/:organizationId/projects/:projectId   -> 200 { id, deleted: true }                      (projects.delete)
```

All five require a Bearer access token, an **active membership** in the route
organization, and the mapped **permission key**. The `:organizationId` path
segment is the only source of the tenant id — it is never read from a request
body.

### How the pieces connect

A request flows through four layers, each with one job:

```
project.routes.ts     authenticate (Bearer) → validate body/query (Zod) → call service → envelope
   │
project.service.ts    requireMembership → requirePermission → tenant-scoped repo call → map row → DTO
   │
project.repo.ts       org-scoped SQL (deleted_at IS NULL) + action-event write in one transaction
   │
projects table        prj_ id, organization_id, soft-delete columns, keyset indexes
```

- **Routes** (`project.routes.ts`) stay thin: authenticate via the auth boundary,
  parse the body/query AND the route params through the contracts
  (`projectRouteParamsSchema` for the single-project routes), delegate to the
  service, and wrap the result in the standard success envelope. No authorization
  logic, no raw rows. Route params are validated for **shape only** (non-empty
  strings); their authority is resolved server-side (see §B, route-param
  convention).
- **Service** (`project.service.ts`) composes the existing access-control
  helpers: `requireMembership` resolves the `OrganizationActor` (active membership
  + effective permissions), then `requirePermission(actor, key)` gates the action.
  It passes `actor.organizationId` (never a body value) to the repository and maps
  every persistence row to the public `Project` DTO.
- **Repository** (`project.repo.ts`) owns project SQL. Every query is scoped by
  `organization_id`; every active flow filters `deleted_at IS NULL`. Mutations run
  in a transaction that also writes the action event, so the change and its record
  commit together.
- **Schema** (`projects.ts`) defines the table, the `prj_` id default, the
  soft-delete columns, and the two indexes that back list/pagination and
  tenant-scoped lookup.

The service takes **two** dependencies — an `AccessControlRepository` (satisfied
by the existing organization repository) for `requireMembership`, and a dedicated
`ProjectRepository` for project persistence. This keeps the project repository
thin and tenant-specific rather than folding projects into the organization repo.

### How to add another organization-scoped resource safely

Projects are the template. To add a new resource (e.g. `documents`), copy the
shape exactly:

1. **Contracts** — add DTOs + request/response schemas in
   `packages/contracts/src/<resource>.ts`. Expose a public DTO with stable fields
   only; never include soft-delete or other persistence internals. Export from
   `index.ts`. Add a `<RESOURCE>_NOT_FOUND` error code.
2. **Permissions** — the permission keys must already exist in the fixed catalog
   (`PERMISSION_KEYS` / `ROLE_PERMISSIONS` in `access.ts`). The catalog is fixed in
   v1; adding a key is a reviewed contract change, not part of a normal resource
   slice.
3. **Schema** — add the table in `packages/db/src/schema/<resource>.ts` with a
   prefixed id, a non-null `organization_id` FK, soft-delete columns
   (`deleted_at` + `deleted_by_user_id`), an active partial index on
   `(organization_id, created_at, id) WHERE deleted_at IS NULL`, and a
   `(organization_id, id)` lookup index. Register it in the schema barrel and run
   `pnpm db:generate`.
4. **Repository** — a thin tenant-aware repo: every method takes
   `organizationId`; active flows filter `deleted_at IS NULL`; never look up by id
   alone; record action events inside the mutation transaction.
5. **Service** — compose `requireMembership` → `requirePermission(actor, key)` →
   tenant-scoped repo call → DTO mapping → action event. Take the
   `AccessControlRepository` and your resource repository as separate deps.
6. **Routes** — five thin handlers; the `:organizationId` route segment is the
   only tenant authority.
7. **Wiring** — construct the service in `server.ts`, add an optional
   `<resource>Service` to `BuildAppOptions`, and register the routes in `app.ts`.
8. **Tests** — route-level (in-memory) for CRUD/permissions/tenant-isolation/
   soft-delete/pagination/events, plus a DB-backed integration test for
   migration-from-scratch and real persistence.

### Running validation

```
pnpm typecheck                                   # strict tsc across all packages
pnpm test                                        # unit + route tests (no DB)
pnpm db:generate                                 # drift check — must say "No schema changes"
pnpm infra:up                                    # PostgreSQL + Redis for integration
pnpm -r run test:integration                     # DB-backed migration + persistence tests
pnpm --filter @orgistry/web-demo build           # web build
git diff --check                                 # whitespace
```

---

## B. Architectural Notes

**Why Projects are intentionally small.** Sprint 6 proves a *pattern*, not a
feature. A project is just a name in a tenant. Keeping the resource trivial makes
the security and lifecycle properties — tenant scoping, permission-first
authorization, soft delete, safe cross-tenant failure, action events — the
subject of the slice, so future resources inherit a proven template instead of
re-deriving it.

**Why all project access is organization-scoped.** A project belongs to exactly
one organization, and the organization id is the tenant authority boundary. Every
list/read/update/delete query filters on `organization_id`, taken from the route,
so a project can only be reached by a caller acting within its tenant. This is the
single most important property of a multi-tenant resource and it is enforced in
the repository, not merely at the edge.

**Why authorization uses permissions, not role names.** The service checks a
permission key (`projects.read` / `.create` / `.update` / `.delete`) via
`requirePermission`, which tests the actor's already-resolved effective permission
set. It never branches on the role name. Role identities exist only for structural
invariants (e.g. Last Owner, elsewhere). This keeps authorization declarative and
lets the fixed role→permission mapping — not scattered `if role === …` checks — be
the single source of truth for who can do what.

**Why the repository requires organization id.** No organization-scoped method
looks up a project by project id alone. Requiring `organizationId` on every method
makes cross-tenant access structurally impossible: a project id from another
tenant simply does not match the `(organization_id, id)` predicate, so it is
invisible. The type signatures enforce this — there is no `findById(projectId)` to
misuse.

**Why cross-tenant failures return safe not found.** A project that belongs to
another organization, an unknown id, and a soft-deleted project all return the
identical `PROJECT_NOT_FOUND` 404. A caller can never distinguish "exists but not
yours" from "does not exist", so project existence in other tenants never leaks.
This mirrors the organization module's `ORGANIZATION_NOT_FOUND` convention.

**Why deletion is soft delete.** Delete sets `deleted_at` + `deleted_by_user_id`;
the row is never removed. Active flows filter `deleted_at IS NULL`, so deleted
projects vanish from list/read/update/delete while history is retained for a
future audit/restore feature. There is no hard-delete and no restore endpoint in
Sprint 6 — the columns exist so those flows can be built later without a schema
change.

**Route-param validation convention (why params are not prefix-validated).** Route
params are parsed through `projectRouteParamsSchema`, but only for presence/shape
(non-empty strings) — never for the `prj_`/`org_` opaque-id prefix. This matches
the established organization/member route convention: an id's authority is
resolved **server-side**, so an unknown, malformed, or cross-tenant id surfaces the
same safe not-found (`ORGANIZATION_NOT_FOUND` from `requireMembership`,
`PROJECT_NOT_FOUND` from the tenant-scoped lookup) rather than a structural 400.
Prefix-validating at the edge would (a) create a one-off behavior diverging from
every other route, and (b) leak nothing extra — a well-formed-but-unknown id and a
malformed id are equally non-existent to the caller. The contract is still *used*
(it is the single source of truth for the param shape and types); it just does not
attempt identity validation, which is not its job.

**Index intent (why these two indexes).** `ix_projects_org_id` on
`(organization_id, id)` exists specifically to back the tenant-scoped point lookup
invariant — read/update/delete resolve a project by org **and** id, and this index
makes that the access path (not a scan filtered by id alone).
`ix_projects_org_created_active` on `(organization_id, created_at, id)` is
**partial** (`WHERE deleted_at IS NULL`): it backs the active list and its keyset
pagination in one index while keeping soft-deleted rows out of the scan. The
migration integration test asserts both index *definitions* (columns + the partial
predicate), so a future refactor cannot silently drop tenant-lookup support by
renaming or recolumning an index.

**Why quotas are excluded from this sprint.** Quotas/entitlements/plan enforcement
are a separate concern that attaches *on top of* the permission check (a future
`requireEntitlement`/quota guard would run after `requirePermission` in
`createProject`). Adding them now would conflate "may this actor act?" (Sprint 6)
with "is this tenant allowed more of this resource?" (a later sprint). The seam is
intentionally left untouched — see [§D](#d-integration-notes).

---

## C. Contracts & Invariants

### Project DTO (stable)

```ts
Project = {
  id: string;                 // opaque, prefixed: prj_…
  organizationId: string;     // the owning tenant
  name: string;
  createdByUserId: string;    // the actor that created it
  createdAt: string;          // ISO-8601
  updatedAt: string;          // ISO-8601
}
```

The public DTO **never** carries soft-delete internals (`deletedAt`,
`deletedByUserId`) — deleted projects are simply absent from active responses, so
a client never needs to read deleted metadata. The DTO is the only project shape
that crosses the API boundary; raw database rows are never returned.

### Route surface

```
GET    /v1/organizations/:organizationId/projects
POST   /v1/organizations/:organizationId/projects
GET    /v1/organizations/:organizationId/projects/:projectId
PATCH  /v1/organizations/:organizationId/projects/:projectId
DELETE /v1/organizations/:organizationId/projects/:projectId
```

### Permission mapping

| Operation | Permission key |
| --- | --- |
| list | `projects.read` |
| read | `projects.read` |
| create | `projects.create` |
| update | `projects.update` |
| delete | `projects.delete` |

By the fixed role→permission mapping: Owner/Admin hold all four; Member holds
`read`/`create`/`update`; Viewer holds `read` only.

### Invariants

1. **Tenant-scoped lookup.** Every project list/read/update/delete query is scoped
   by `organization_id`, sourced from the route — never the request body.
2. **Must not look up a project by project id alone.** No organization-scoped
   repository method accepts a bare project id; cross-tenant access is structurally
   impossible.
3. **Safe cross-tenant / deleted failure.** Cross-tenant, unknown, and soft-deleted
   targets all return the identical `PROJECT_NOT_FOUND` 404 (no existence leak).
4. **Soft delete only.** Delete sets `deleted_at` + `deleted_by_user_id`; rows are
   never hard-deleted; there is no restore or hard-delete endpoint. A repeated
   delete of an already-deleted project returns `PROJECT_NOT_FOUND` (fails safely).
5. **Cursor pagination + tie-breaker.** The list is keyset-paginated on
   `(created_at desc, id desc)` with an opaque cursor; offset pagination is never
   used. The cursor predicate is `created_at < c.createdAt OR (created_at =
   c.createdAt AND id < c.id)`, so projects that share a `created_at` are
   disambiguated by the `id` tiebreaker — no duplicates and no skips across pages
   even under timestamp ties (proven by both an in-memory and a DB-backed
   equal-`created_at` test). Default limit is 20, maximum 100 (the platform
   `cursorPageParamsSchema` baseline).
6. **Route-param resolution.** Route params are shape-validated only; identity is
   resolved server-side. A malformed/unknown/cross-tenant `projectId` returns the
   uniform `PROJECT_NOT_FOUND` 404 (with a `requestId` on the error envelope) — it
   is never prefix-validated into a distinct 400 (see §B).
7. **Action events.** `project.created` / `project.updated` / `project.deleted` are
   recorded on the internal action-event seam inside the mutation transaction, with
   sanitized metadata. There is no read API for them.
8. **DTO stability.** The public `Project` DTO exposes only the fields above; no
   persistence internals cross the boundary.

---

## D. Integration Notes

**`requireMembership`.** The service resolves the actor with the Sprint 5
`requireMembership(accessControl, { userId, organizationId, requestId })`, which
verifies the organization exists, is active, and that the user has an **active**
membership — failing with the uniform `ORGANIZATION_NOT_FOUND` 404 otherwise. A
removed membership therefore loses all project access immediately.

**`requirePermission`.** After membership, the service calls
`requirePermission(actor, PERMISSION_KEYS.projects…)`, a pure check against the
actor's effective permission set. Authorization is by key only — the role name is
never consulted.

**Organization actor context.** The `OrganizationActor` returned by
`requireMembership` supplies `organizationId` (the tenant boundary),
`membershipId` (recorded in event metadata), and `userId` (recorded as
`created_by`/`deleted_by` and the event actor). The service builds a
`ProjectActionContext` from it plus the request's id/ip/user-agent.

**Action events use the existing internal seam.** `project.created` /
`.updated` / `.deleted` are organization-scoped **action events** (not security/
authentication events). They are *currently persisted through* the existing
internal event seam — the `security_events` table, which already carries
`organization_id` — exactly like the Sprint 5 member-management actions, written
in the same transaction as the mutation. Reusing that table is an **implementation
detail**: it is the durable sink available today and does **not** decide the future
public audit-log product shape. The table has no dedicated columns for actor
membership / target type / target id, so those live in the **sanitized** JSON
metadata (`sanitizeSecurityMetadata` — never secrets, never full request bodies).
Sprint 6 introduces **no** user-facing audit-log read API; this is only the
internal writer seam a future, permission-gated (`audit_events.read`) feature would
read from.

**How future entitlements/quotas attach without changing Sprint 6 boundaries.** A
quota/entitlement guard is a *new check that runs after* `requirePermission` in the
mutating service methods (e.g. `createProject`): `requireMembership →
requirePermission → [future: requireEntitlement / checkQuota] → repo`. It needs no
change to the project repository, schema, routes, or DTOs — only an added guard in
the service. Sprint 6 deliberately leaves that seam empty (no quota fields, no plan
columns) so the addition is additive.

---

## E. Known Limitations

Deliberately **out of scope** for Sprint 6 (verified absent):

- **No web project UI** — no Projects page and no workspace switcher; backend only.
- **No quotas / entitlements / plan enforcement** — creation is unbounded; the
  guard seam is empty by design (see §D).
- **No invitations / API keys** — memberships are created by registration and team
  creation only; tests seed additional memberships directly.
- **No external projects API** — only the internal `/v1/...` surface exists.
- **No full audit-log read API** — action events are recorded but never surfaced.
- **No project restore and no hard delete** — soft delete is terminal in Sprint 6;
  the columns support a future restore flow without a schema change.
- **No collaboration / comments / files / settings** — a project is a name in a
  tenant; richer fields are a later, reviewed contract change.
- **No bulk operations, no generic CRUD framework** — the repository is a small,
  explicit, project-specific surface, not an abstraction.

---

## F. Sprint Changelog

See [`sprint-6-artifact-package.md`](sprint-6-artifact-package.md) for the full
iteration summary, implementation/documentation/test inventory, validation
evidence, scope-control confirmation, and remaining risks.

**Iteration summary (Sprint 6).**

- **Implementation.** Added the `projects` table (prefixed `prj_` ids, soft-delete
  columns, two keyset/lookup indexes) and migration `0004`; project contracts and
  `PROJECT_NOT_FOUND`; a thin tenant-aware project repository that records action
  events in the mutation transaction; a permission-first project service composing
  the Sprint 5 access-control helpers; and the five-endpoint project route surface,
  wired in `app.ts`/`server.ts`.
- **Documentation.** This reference (`projects.md`), the Sprint 6 artifact, and
  README updates (endpoint list, scope, docs index).
- **Tests.** Contract tests (`projects.test.ts`); 30 route-level tests over the
  in-memory store (CRUD, permission gating per key, tenant isolation, soft-delete
  lifecycle, cursor pagination with default/max limits and the equal-`created_at`
  tie-breaker, route-param resolution, event recording, removed-membership access
  loss); 7 DB-backed integration tests (migration-from-scratch with index
  *definitions*, real persistence, soft-delete markers, cross-tenant safety,
  permission-by-key, pagination incl. an equal-`created_at` SQL tie-breaker); and
  migration-test additions for the new table and index intent.
- **Quality evolution.** No prior-sprint behavior changed. The `projects.*`
  permission keys and role grants already existed in the fixed catalog (reserved in
  Sprint 5), so no RBAC redesign was needed — Sprint 6 only *consumes* them.
- **Known remaining risks.** Action events have no read API yet (by design); the
  quota/entitlement seam is intentionally empty; integration tests require a
  reachable PostgreSQL (skipped with a warning otherwise).

**Hardening pass (Sprint 6).** A surgical pass after the initial implementation,
addressing correctness/invariant clarity without expanding scope:

1. **Route-param contracts.** `projectRouteParamsSchema` was defined but unused; it
   now backs the single-project routes (read/update/delete) as the single source of
   truth for the param shape. It validates presence/shape only — identity stays
   server-resolved (safe not-found), consistent with the org/member convention,
   which is now documented (§B). Added tests: malformed `projectId` →
   `PROJECT_NOT_FOUND` 404 with a `requestId`; valid params still resolve.
2. **Tenant-lookup index intent.** The `(organization_id, id)` lookup index and the
   partial `(organization_id, created_at, id) WHERE deleted_at IS NULL` list index
   already existed; the migration test now asserts their **definitions** (columns +
   partial predicate), not just names, so a refactor cannot silently drop tenant
   lookup support. Documented the index *intent* (§B).
3. **Cursor tie-breaker.** Verified the predicate already handles equal
   `created_at` (`created_at < c OR (created_at = c AND id < c.id)`); added an
   in-memory and a DB-backed equal-`created_at` test proving no duplicates/skips and
   stable id-DESC ordering. Documented the invariant (§C).
4. **Tenant isolation re-audit.** Re-confirmed every repository method is scoped by
   `organization_id` and no organization-scoped flow looks a project up by id alone.
5. **Action-event wording.** Clarified in code and docs that these are
   organization-scoped *action* events currently persisted through the existing
   internal seam (an implementation detail, not a public audit-log commitment), with
   sanitized metadata and no read API.

No schema change, no new endpoint, no behavior change to prior sprints.
