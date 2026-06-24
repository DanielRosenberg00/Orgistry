# Sprint 6 Artifact Package

Official completion artifact for Orgistry Sprint 6 — **Projects Vertical Slice**.
This is the authoritative record of what the sprint delivered, how it was
validated, the contracts and invariants it establishes, what was deliberately
left out, and what the next sprint may rely on. It summarizes and indexes; the
full engineering reference lives in [`projects.md`](projects.md).

Sprint 6 adds Orgistry's **first real organization-scoped business resource** on
top of the Sprint 5 permission-first RBAC layer, completing the core access chain:

```
User → Organization → Membership → Role → Permission → Organization-Scoped Resource
```

Projects are intentionally small — a vehicle to prove tenant-scoped resource
access, permission-first authorization, cursor pagination, soft deletion, safe
cross-tenant failure, and internal action-event recording. Entitlements, quotas,
plan enforcement, invitations, API keys, an external projects API, a web Projects
page, a workspace switcher, a full audit-log read API, a generic CRUD framework,
custom roles, resource-level permissions, ABAC/policy engines, RLS, project
restore, and hard delete all remain explicitly out of scope.

**Status: COMPLETE — ready to close.** Implementation and hardening passes are
done; this is the final artifact. Every runnable validation command in §3 passed
(re-run at finalization: typecheck ✅, unit 276 ✅, DB integration 10 ✅, API
integration 32 ✅, drift ✅, web build ✅, `git diff --check` ✅). The one
environmental caveat (unchanged from Sprint 5): the dev host's standard Postgres
port (5432) was held by an unrelated container, so integration suites were run
against a disposable PostgreSQL on an alternate port (with a matching Redis); they
pass in full (see §3).

---

## 1. Implementation Summary

**Database / schema.** New `projects` table
(`packages/db/src/schema/projects.ts`) with prefixed opaque ids (`prj_`), a
non-null `organization_id` FK (the tenant authority boundary), `name`,
`created_by_user_id`, soft-delete columns (`deleted_at` + `deleted_by_user_id`),
and audit timestamps. Two indexes back the access paths: a partial active index
`ix_projects_org_created_active` on `(organization_id, created_at, id) WHERE
deleted_at IS NULL` (list + keyset pagination + active filtering) and
`ix_projects_org_id` on `(organization_id, id)` (tenant-scoped lookup). The
generated migration `0004_great_kid_colt.sql` creates the table and indexes; it
applies cleanly from scratch and `db:generate` reports no drift.

**Contracts.** `packages/contracts/src/projects.ts` defines the public `Project`
DTO (id, organizationId, name, createdByUserId, createdAt, updatedAt — no
soft-delete internals), the create/update requests, the create/read/update/list/
delete responses, the list query (the platform cursor baseline, re-exported as
`projectListQuerySchema`), and the route-param contract. `error-codes.ts` adds
`PROJECT_NOT_FOUND`.

**Repository.** `apps/api/src/modules/projects/project.repo.ts` is a thin
tenant-aware boundary: `listActiveProjects`, `createProject`, `findActiveProject`,
`updateProject`, `softDeleteProject`. Every method takes `organizationId`; no
method looks up a project by id alone; active flows filter `deleted_at IS NULL`.
Mutations run in a transaction that also writes the action event, so the change
and its record commit together. It is not a generic CRUD abstraction.

**Service.** `apps/api/src/modules/projects/project.service.ts` composes the
existing Sprint 5 helpers for every flow: `requireMembership` →
`requirePermission(actor, projects.*)` → tenant-scoped repository call → map the
row to the public DTO → record an action event for mutations. Authorization is by
permission key, never role name. The organization id comes from the
`OrganizationActor` (route-derived), never a request body. The service takes two
deps — the `AccessControlRepository` (the organization repo) and the
`ProjectRepository` — keeping the project repo thin.

**API surface.** Five endpoints, all Bearer-authenticated, active-membership- and
permission-gated:

```
GET    /v1/organizations/:organizationId/projects              (projects.read)
POST   /v1/organizations/:organizationId/projects              (projects.create)
GET    /v1/organizations/:organizationId/projects/:projectId   (projects.read)
PATCH  /v1/organizations/:organizationId/projects/:projectId   (projects.update)
DELETE /v1/organizations/:organizationId/projects/:projectId   (projects.delete)
```

**Soft delete & cross-tenant safety.** Delete sets `deleted_at` +
`deleted_by_user_id`; rows are never hard-deleted; there is no restore or
hard-delete endpoint. Cross-tenant, unknown, and soft-deleted targets all return
the identical `PROJECT_NOT_FOUND` 404, so existence never leaks. A repeated delete
of an already-deleted project returns `PROJECT_NOT_FOUND` (fails safely — it is
not a silent idempotent 200).

**Action-event seam.** `project.created` / `project.updated` / `project.deleted`
are recorded as organization-scoped rows in the existing `security_events` table
(which already carries `organization_id`), inside the mutation transaction, with
sanitized metadata carrying actor membership id, target type, and target project
id. No read API is exposed — this is the internal writer seam only.

**Documentation.** New `projects.md` (A–F engineering reference) and this
artifact; README updated (endpoint list, scope boundary, docs index).

---

## 2. Files Changed

**Database / schema / migrations**
- `packages/db/src/schema/projects.ts` (new) — `projects` table + indexes + types.
- `packages/db/src/schema/index.ts`, `packages/db/src/index.ts` (mod) — exports.
- `packages/db/migrations/0004_great_kid_colt.sql` (new) — table + index DDL.
- `packages/db/migrations/meta/0004_snapshot.json`, `meta/_journal.json` (generated).
- `packages/db/src/migrate.integration.test.ts` (mod) — `projects` table + index assertions.

**Contracts**
- `packages/contracts/src/projects.ts` (new) — DTOs, requests, responses, list query, route params.
- `packages/contracts/src/projects.test.ts` (new).
- `packages/contracts/src/error-codes.ts`, `index.ts` (mod) — `PROJECT_NOT_FOUND` + exports.

**API — projects module**
- `apps/api/src/modules/projects/project.errors.ts` (new).
- `apps/api/src/modules/projects/project.events.ts` (new).
- `apps/api/src/modules/projects/project.types.ts` (new) — repository boundary + params.
- `apps/api/src/modules/projects/project.repo.ts` (new) — DB repository.
- `apps/api/src/modules/projects/project.service.ts` (new).
- `apps/api/src/modules/projects/project.routes.ts` (new).
- `apps/api/src/app.ts`, `apps/api/src/server.ts` (mod) — wire the project service.

**Tests**
- `apps/api/src/modules/projects/project.routes.test.ts` (new) — 30 route-level tests.
- `apps/api/src/modules/projects/project.integration.test.ts` (new) — 7 DB-backed tests.
- `apps/api/src/modules/projects/testing/in-memory-project-repo.ts` (new).
- `apps/api/src/modules/projects/testing/build-projects-test-app.ts` (new).
- `apps/api/src/modules/organization/testing/in-memory-org-store.ts` (mod) — `projects` array.

**Documentation**
- `docs/projects.md` (new), `docs/sprint-6-artifact-package.md` (new).
- `README.md` (mod) — endpoints, scope, docs index.

---

## 3. Validation Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm -r run typecheck` | ✅ Pass | Strict `tsc --noEmit` across all packages/apps. |
| `pnpm test` (unit) | ✅ Pass | 276 tests, 35 files (was 236 — adds 10 contract + 30 route project tests). |
| `pnpm --filter @orgistry/db test:integration` | ✅ Pass | 10 tests (migration-from-scratch asserts the `projects` table + both index *definitions*). |
| `pnpm --filter @orgistry/api test:integration` | ✅ Pass | 32 tests, 6 files (was 25 — adds 7 project integration tests). |
| `pnpm db:generate` (drift check) | ✅ Pass | "No schema changes" — schema and migrations agree. |
| `pnpm --filter @orgistry/web-demo build` | ✅ Pass | Vite production build (unchanged; no web Projects UI). |
| `git diff --check` | ✅ Pass | No whitespace errors. |
| `pnpm lint` | ⚠️ No-op | Sprint-1 placeholder (exits 0); `typecheck` is the active static gate. |

**Infrastructure note.** Port 5432 on the dev host was held by an unrelated
container, so integration suites were run against a disposable PostgreSQL on an
alternate port (with a matching Redis); they pass in full. In a standard
`pnpm infra:up` environment they run unchanged against the default ports. The API
has no separate `build` script (it runs via `tsx`); `tsc --noEmit` is its build
gate, and the web build is the only bundling step.

---

## 4. Authorization & Tenant Isolation

Every endpoint enforces the same backend pipeline — proven by tests, not UI
hiding:

- **Authentication.** A missing/empty Bearer token → 401 `UNAUTHORIZED`.
- **Active membership.** `requireMembership` resolves only active memberships in
  active organizations; a non-member, a removed member, or a cross-org caller all
  get the uniform `ORGANIZATION_NOT_FOUND` 404. (Tested: a member who is then
  removed loses list/create access.)
- **Permission by key.** `requirePermission(actor, projects.*)` checks the actor's
  effective permission set — never the role name. Tested per operation: a Viewer
  (read-only) can list/read but is forbidden (403) from create/update/delete; a
  Member is forbidden from delete; Owner/Admin hold all four.
- **Tenant-scoped queries.** Every repository method is scoped by
  `organization_id` from the route; a project id from another tenant never matches
  the `(organization_id, id)` predicate, so it is invisible. Cross-tenant read,
  update, and delete all return `PROJECT_NOT_FOUND` and leave the foreign project
  untouched.
- **No body-supplied tenant id.** A create body smuggling `organizationId` is
  ignored — the project is created under the route organization (tested).

---

## 5. Soft Delete & Pagination

**Soft delete.** Delete sets `deleted_at` + `deleted_by_user_id` and records
`project.deleted`; the row remains (verified in the DB integration test — not
hard-deleted). Deleted projects are omitted from list, return `PROJECT_NOT_FOUND`
on read/update, and a repeated delete returns `PROJECT_NOT_FOUND`. There is no
restore or hard-delete endpoint.

**Pagination.** The list is keyset-paginated on `(created_at desc, id desc)` with
an opaque cursor (offset pagination is never used). The default limit is 20 and
the maximum is 100 (the platform `cursorPageParamsSchema` baseline); a limit above
100 is a `VALIDATION_ERROR`, and a malformed cursor is `BAD_REQUEST`. Tested:
two consecutive pages do not overlap, a 25-project org returns 20 with
`hasMore: true` by default, and the partial active index excludes soft-deleted
rows from the keyset scan.

---

## 6. Action Events

`project.created`, `project.updated`, and `project.deleted` are recorded on the
existing organization-scoped `security_events` seam, inside the same transaction
as the mutation, with sanitized metadata (actor membership id, target type,
target project id, plus the new name on create/update). Metadata never contains
secrets or full request bodies (passed through `sanitizeSecurityMetadata`). No
user-facing audit-log read API is introduced — this is the internal writer seam a
future, permission-gated audit feature would read from. Verified by both the
route-level tests (events present with correct org/actor/target) and the DB
integration test (rows written for create/update/delete).

---

## 7. Scope Control Confirmation

Implemented exactly the Sprint 6 surface and **nothing** out of scope. Not
implemented (verified absent): entitlements; quotas; plan enforcement;
invitations; API keys; any external projects API; a web demo Projects page or
workspace switcher UI; a full audit-log read API; a generic CRUD framework; custom
or organization-defined roles; resource-level permissions; ABAC; a policy engine;
PostgreSQL RLS; a project restore endpoint; a hard-delete endpoint; bulk
operations; workers; queues; billing; OAuth/MFA/password-reset/passkeys; and
deployment automation.

The `projects.*` permission keys and role grants already existed in the fixed
Sprint 5 catalog (reserved there), so Sprint 6 only *consumes* them — no RBAC
redesign, no catalog change. No prior-sprint behavior was modified.

---

## 8. Documentation Index

- [`projects.md`](projects.md) — full Projects reference (A. developer docs,
  B. architecture, C. contracts/invariants, D. integration, E. limitations,
  F. changelog), including a step-by-step recipe for adding the next
  organization-scoped resource safely.
- [`sprint-6-artifact-package.md`](sprint-6-artifact-package.md) — this artifact.
- [`rbac-permissions.md`](rbac-permissions.md) — Sprint 5 RBAC & member management
  (the access-control helpers Projects compose).
- [`README.md`](../README.md) — endpoint list and scope boundary updated.

---

## 9. Confidence Assessment

**Overall: high.** The tenant-scoped resource pattern is implemented end-to-end
and every property is mechanically verified, not just asserted.

- **Proven by unit/route tests (276 total; 40 new).** Contract shape including the
  no-soft-delete-internals guarantee (`projects.test.ts`); and the full HTTP
  behavior (`project.routes.test.ts`): authentication, active-membership gating,
  per-key permission gating (Viewer/Member negative paths, Owner positive),
  cross-tenant read/update/delete returning safe not-found, soft-delete lifecycle
  and omission from list, repeated-delete safety, cursor pagination with default/
  max limits, malformed-cursor handling, the equal-`created_at` tie-breaker,
  route-param resolution (malformed id → safe 404 with `requestId`), action-event
  recording, and removed-membership access loss.
- **Proven by integration tests (API 7, DB migration +3 assertions).** Against
  live PostgreSQL: the `projects` table and both index *definitions* migrate from
  scratch; real create/read/list/update persistence with events written; soft
  delete writes the lifecycle markers and never hard-deletes; cross-tenant access is
  a safe 404 that leaves the foreign project untouched; permissions enforce by key;
  and pagination is stable across pages, including a worst-case equal-`created_at`
  SQL tie-breaker that proves no duplicates or skips.
- **Proven by drift check.** `db:generate` reports no schema changes — schema and
  the generated migration agree.
- **Intentionally deferred (not gaps).** No web UI, quotas, entitlements,
  invitations, API keys, external API, audit-log read API, restore, or hard delete
  — all out of Sprint 6 scope and documented.

**Sprint 6 is ready to close against the Definition of Done.** The Projects
slice composes the existing auth/membership/permission foundations without
modifying them, proves tenant isolation and safe cross-tenant failure at the
backend, records action events on the internal seam, and is documented to serve as
the canonical template for future organization-scoped resources.

---

## 10. Remaining Risks

Only items that bear on Sprint 6 correctness or operability — deferred
future-sprint features are scope decisions, not risks.

- **Action events have no read API (by design).** `project.created` / `.updated` /
  `.deleted` are recorded on the internal seam for a future, permission-gated
  (`audit_events.read`) feature; nothing surfaces them yet. This is intentional and
  documented — not a Sprint 6 correctness gap.
- **Integration tests require reachable PostgreSQL/Redis.** The DB and API
  integration suites skip with a clear warning when no database is reachable; they
  must be run with `pnpm infra:up` (or equivalent infrastructure) to exercise the
  migration-from-scratch, real-persistence, tenant-isolation, and SQL tie-breaker
  proofs. Unit/route coverage runs without infrastructure.
- **Future entitlements/quotas must attach as an additive guard.** The Sprint 7
  guard must run AFTER `requirePermission` in the mutating service methods (see §11)
  — it must not be folded into the repository, the schema, or the permission check.
  This is a forward constraint, not a current defect; the seam is deliberately empty
  today (no quota fields, no plan columns).
- **Action-event metadata discipline is by convention + sanitizer.** Metadata is
  sanitized (`sanitizeSecurityMetadata`) and intentionally small; future additions
  to the metadata payload must continue to avoid secrets and full request bodies.

No open correctness, tenant-isolation, or authorization risks remain.

---

## 11. Readiness for Next Sprint (Entitlements, Plans & Quotas)

Sprint 7 (Entitlements / Plans / Quotas) can build directly on Projects **without
revisiting** any part of this slice. The seam is already in place and proven.

- **Project table design — frozen.** `projects` (prefixed `prj_` id,
  `organization_id` FK, `name`, `created_by_user_id`, soft-delete columns, audit
  timestamps) needs no new column for entitlements/quotas. A quota counter or plan
  reference lives on the **organization/plan** side, not the project row.
- **Organization scoping — frozen.** Every project query is scoped by
  `organization_id`. A quota check is "how many active projects does THIS
  organization have?" — answered by the existing org-scoped active filter, with no
  change to the scoping model.
- **Permission enforcement — frozen.** Authorization is permission-key-based
  (`projects.*` via `requireMembership` → `requirePermission`). An entitlement/quota
  guard is a **separate, additive** check that runs *after* the permission check:
  `requireMembership → requirePermission → [Sprint 7: requireEntitlement / checkQuota]
  → repo`. It does not replace or modify permission enforcement.
- **Repository boundaries — frozen.** The `ProjectRepository` surface
  (`listActiveProjects`, `createProject`, `findActiveProject`, `updateProject`,
  `softDeleteProject`) is sufficient. A quota check reads the existing active-project
  count; it needs no new repository method and no generic CRUD layer.
- **Soft-delete lifecycle — frozen.** `deleted_at` + `deleted_by_user_id` already
  define "active". A quota that counts active projects automatically excludes
  soft-deleted rows via the existing partial index and `deleted_at IS NULL` filter.
- **List pagination — frozen.** Cursor pagination (keyset on `created_at, id` with
  the equal-timestamp tiebreaker) is stable and needs no change to surface
  plan/quota state alongside a project list.
- **Action-event pattern — frozen.** The internal action-event seam
  (`project.*` on `security_events`, written in the mutation transaction with
  sanitized metadata) is the template Sprint 7 reuses for plan/quota events; no new
  audit infrastructure is required.
- **Safe cross-tenant not-found — frozen.** The uniform `PROJECT_NOT_FOUND` for
  unknown/cross-tenant/deleted targets is unaffected by entitlement logic; a quota
  guard runs only after the actor is confirmed a permitted member of the tenant.
- **Project contracts — frozen.** The public `Project` DTO and request/response
  schemas are stable. Plan/quota state belongs in new organization/plan contracts,
  not in the Project DTO — adding a field there would be a separate, reviewed change.

In short, Sprint 7 is "add an entitlement/quota guard in the service layer plus a
plan/quota model on the organization side" — additive, with **zero** required edits
to the Projects table, scoping, permissions, repository, lifecycle, pagination,
events, or contracts.

---

## 12. Hardening Pass

A surgical pass after the initial implementation, addressing correctness and
invariant clarity without expanding scope. No schema change, no new endpoint, no
behavior change to prior sprints.

1. **Route-param contracts now used.** `projectRouteParamsSchema` was defined but
   unused; it now backs the single-project routes (read/update/delete) as the
   single source of truth for the param shape. It validates presence/shape only —
   identity remains server-resolved, so a malformed/unknown/cross-tenant id surfaces
   the uniform `PROJECT_NOT_FOUND` 404 (with `requestId`) rather than a structural
   400, consistent with the org/member route convention (now documented in
   `projects.md` §B). Tests added: malformed `projectId` on read/update/delete →
   safe 404; valid params still resolve.
2. **Tenant-lookup index intent asserted.** The `(organization_id, id)` lookup index
   and the partial `(organization_id, created_at, id) WHERE deleted_at IS NULL` list
   index already satisfied the invariant; the migration test now asserts their
   **definitions** (columns + partial predicate), not just names, so a refactor
   cannot silently drop tenant-lookup support. Index *intent* documented (§B).
3. **Cursor tie-breaker verified + tested.** The predicate already handled equal
   `created_at` (`created_at < c OR (created_at = c AND id < c.id)`); added an
   in-memory and a DB-backed equal-`created_at` test proving no duplicates/skips and
   stable id-DESC ordering. Invariant documented (§C).
4. **Tenant isolation re-audited.** Re-confirmed (by signature + `WHERE`-clause
   grep) that every repository method is scoped by `organization_id` and no
   organization-scoped flow looks a project up by id alone.
5. **Action-event wording clarified.** Code and docs now state these are
   organization-scoped *action* events currently persisted through the existing
   internal seam (an implementation detail, not a public audit-log commitment), with
   sanitized metadata and no read API.

**Post-hardening validation** (all re-run): `typecheck` ✅; unit `pnpm test` ✅
276; `@orgistry/db test:integration` ✅ 10; `@orgistry/api test:integration` ✅ 32;
`db:generate` ✅ no drift; web build ✅; `git diff --check` ✅. The environmental
caveat is unchanged (disposable PostgreSQL/Redis on alternate ports because 5432
was occupied).
