# Sprint 5 Artifact Package

Official completion artifact for Orgistry Sprint 5 — **Roles, Permissions,
Membership Management, and Access-Control Helpers**. This is the authoritative
record of what the sprint delivered, how it was validated, the contracts and
invariants it establishes, what was deliberately left out, and what the next
sprint may rely on. It summarizes and indexes; the full engineering reference
lives in [`rbac-permissions.md`](rbac-permissions.md).

Sprint 5 builds the **permission-first** access-control layer on top of the
Sprint 4 organization/membership foundation, completing the identity chain
`User → Organization → Membership → Role → Permission`. Custom roles, role/permission
mutation APIs, invitations, projects, entitlements, quotas, API keys, a
user-facing audit log, ABAC/policy engines, and RLS remain explicitly out of
scope.

**Status: complete (incl. hardening pass) — ready to review.** Every runnable
validation command in §3 passed. A post-implementation **hardening pass** (§9)
addressed RBAC read-surface enforcement, the package dependency-direction review,
the role-identity audit, Last Owner edge-case coverage, and DTO/error-shape
verification. The one environmental caveat: the project's standard Postgres port
(5432) was occupied by an unrelated container in the dev environment, so
integration suites were run against a disposable PostgreSQL on an alternate port;
they pass in full (see §3).

---

## 1. Implementation Summary

**Database / schema / seed.** New `permissions` and `role_permissions` tables
(`packages/db/src/schema/permissions.ts`) with prefixed opaque permission ids
(`perm_…`), a unique `permissions.key` index, and a composite
`role_permissions (role_id, permission_id)` primary key. The generated migration
`0003_puzzling_titania.sql` creates both tables and ships an **idempotent** seed
(`INSERT … ON CONFLICT DO NOTHING`) of 23 permissions and 56 role→permission
grants. The seed rows are **derived** from the canonical catalog/mapping in
`@orgistry/contracts` (via `PERMISSION_SEED` / `ROLE_PERMISSION_SEED` with stable
ids), so the database, the typed authorization helpers, and the read-only RBAC
endpoints cannot drift. `@orgistry/db` now depends on `@orgistry/contracts`.

**Contracts.** `packages/contracts/src/access.ts` is the single source of truth:
`ROLE_KEYS`/`roleKeySchema`, `PERMISSION_KEYS`/`permissionKeySchema`, the 23-entry
`PERMISSION_CATALOG`, and the canonical `ROLE_PERMISSIONS` mapping — plus the
public DTOs (Role, Permission, PermissionMatrix, EffectivePermissions, Member,
member list/role-change/removal). `error-codes.ts` adds `MEMBER_NOT_FOUND` and
`LAST_OWNER_REQUIRED`.

**Access-control helpers.** `access-control.ts` adds the server-derived
`OrganizationActor`, `requireMembership` (resolves active membership + effective
permissions on top of the Sprint 4 `resolveOrganizationContext`), and the pure
`requirePermission` / `actorHasPermission` checks. Authorization is by permission
key; the actor's role name is never consulted for authorization.

**API surfaces.** Ten endpoints across three groups. (1) Global static RBAC
reference (authenticated, not permission-enforced): `GET /v1/roles`,
`GET /v1/permissions`, `GET /v1/permissions/matrix` — in a `modules/rbac/` module.
(2) Org-scoped, permission-enforced reads:
`GET /v1/organizations/:id/roles` (`roles.read`),
`…/permissions` and `…/permissions/matrix` (`permissions.read`), and
`…/permissions/effective` (active membership only) — in
`modules/organization/org-rbac.{service,routes}.ts`. (3) Member management:
`GET …/members` (`members.read`), `PATCH …/members/:membershipId/role`
(`members.change_role`), `DELETE …/members/:membershipId` (`members.remove`) — in
`modules/organization/member.{service,routes}.ts`.

**Last Owner protection.** Implemented as a transactional repository invariant:
`changeMemberRole` and `removeMember` lock the organization's active-Owner set
`FOR UPDATE` (deterministic order → concurrent owner-affecting mutations
serialize), validate the target, and reject any change that would drop the active
Owner count to zero with `LAST_OWNER_REQUIRED` — covering removal, demotion,
self-demotion, and self-removal. Removal is a soft delete (status + `removed_at` +
`removed_by_user_id`); rows are never hard-deleted; repeat removal is idempotent.

**Audit seam.** Member role changes and removals are recorded as durable,
organization-scoped rows in `security_events` (which already has `organization_id`)
inside the mutation transaction, with sanitized metadata. Event types live in
`member.events.ts`. No read API is exposed. The metadata sanitizer moved to
`apps/api/src/lib/security-metadata.ts` (re-exported from the auth module).

**Documentation.** New `rbac-permissions.md` (A–F engineering reference) and this
artifact; README and `organization-foundation.md` updated.

---

## 2. Files Changed

**Database / schema / seeds**
- `packages/db/src/schema/permissions.ts` (new) — tables + stable-id seed constants.
- `packages/db/src/schema/index.ts`, `packages/db/src/index.ts` (mod) — exports.
- `packages/db/migrations/0003_puzzling_titania.sql` (new) — DDL + idempotent seed.
- `packages/db/migrations/meta/0003_snapshot.json`, `meta/_journal.json` (generated).
- `packages/db/package.json` (mod) — add `@orgistry/contracts` dependency.
- `packages/db/src/migrate.integration.test.ts` (mod) — new tables/seed assertions.

**Contracts**
- `packages/contracts/src/access.ts` (new) — catalog, mapping, DTOs, enums.
- `packages/contracts/src/access.test.ts` (new).
- `packages/contracts/src/error-codes.ts`, `index.ts` (mod).

**API — access control, member management, RBAC**
- `apps/api/src/modules/organization/access-control.ts` (new).
- `apps/api/src/modules/organization/member.errors.ts` (new).
- `apps/api/src/modules/organization/member.events.ts` (new).
- `apps/api/src/modules/organization/member.service.ts` (new).
- `apps/api/src/modules/organization/member.routes.ts` (new).
- `apps/api/src/modules/organization/organization.types.ts` (mod) — access-control + member repo surface.
- `apps/api/src/modules/organization/organization.repo.ts` (mod) — effective-permission + member methods.
- `apps/api/src/modules/rbac/{rbac.types,rbac.repo,rbac.service,rbac.routes}.ts` (new) — global static catalog.
- `apps/api/src/modules/organization/org-rbac.{service,routes}.ts` (new, hardening) — org-scoped permission-enforced RBAC reads.
- `apps/api/src/lib/security-metadata.ts` (new) — shared sanitizer.
- `apps/api/src/modules/auth/security-events.ts` (mod) — re-export sanitizer.
- `apps/api/src/app.ts`, `apps/api/src/server.ts` (mod) — wire member + org-RBAC + global-RBAC services.

**Tests**
- `apps/api/src/modules/organization/access-control.test.ts` (new).
- `apps/api/src/modules/organization/member.routes.test.ts` (new).
- `apps/api/src/modules/organization/org-rbac.routes.test.ts` (new, hardening) — enforcement positive/negative paths.
- `apps/api/src/modules/organization/dto-shape.test.ts` (new, hardening) — DTO/envelope/no-leak.
- `apps/api/src/modules/organization/member.integration.test.ts` (new).
- `apps/api/src/modules/rbac/rbac.routes.test.ts` (new).
- `packages/db/src/schema/permissions.test.ts` (new, hardening) — pure seed-vs-catalog drift guard.
- `apps/api/src/modules/organization/testing/{in-memory-org-store,in-memory-organization-repo,build-organization-test-app}.ts` (mod).
- `apps/api/src/modules/rbac/testing/in-memory-rbac-repo.ts` (new).
- `apps/api/src/modules/auth/testing/in-memory-auth-repo.ts` (mod) — shared user table.

**Documentation**
- `docs/rbac-permissions.md` (new), `docs/sprint-5-artifact-package.md` (new).
- `README.md`, `docs/organization-foundation.md` (mod).

---

## 3. Validation Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm -r run typecheck` | ✅ Pass | Strict `tsc --noEmit` across all 7 packages/apps. |
| `pnpm test` (unit) | ✅ Pass | 236 tests, 33 files. |
| `pnpm --filter @orgistry/db test:integration` | ✅ Pass | 9 tests (migration-from-scratch + seed idempotency + new tables/mapping). |
| `pnpm --filter @orgistry/api test:integration` | ✅ Pass | 25 tests, 5 files (incl. member-management + Last Owner concurrency race + removed-no-access on all org-scoped surfaces). |
| `pnpm db:reset:test` (migration from scratch) | ✅ Pass | Fresh schema + full seed (23 perms / 56 grants) applied cleanly. |
| `pnpm db:generate` (drift check) | ✅ Pass | "No schema changes" — schema and migrations agree. |
| `pnpm --filter @orgistry/web-demo build` | ✅ Pass | Vite production build. |
| `git diff --check` | ✅ Pass | No whitespace errors. |
| role-name audit (grep) | ✅ Pass | No role-name authorization in production code (see §9). |
| `pnpm lint` | ⚠️ No-op | Sprint-1 placeholder (exits 0); `typecheck` is the active gate — reported as such, not counted as lint coverage. |

**Infrastructure note.** The dev host's port 5432 was held by an unrelated
container, so integration suites were run against a disposable PostgreSQL on an
alternate port (with a matching Redis); they pass in full. In a standard
`pnpm infra:up` environment they run unchanged against the default ports.

---

## 4. Confidence Assessment

**Overall: high.** The permission-first model is implemented end-to-end and every
layer of it is mechanically verified, not just asserted in prose.

- **Proven by unit tests (236).** The permission catalog, role→permission mapping,
  and DTO schemas (`access.test.ts`); the access-control helpers — `requireMembership`
  resolves only active memberships, `requirePermission` checks the resolved set and
  never the role name (`access-control.test.ts`); member listing / role change /
  removal HTTP behavior incl. Last Owner and cross-org isolation
  (`member.routes.test.ts`); global + org-scoped RBAC reads with positive and
  negative permission paths (`rbac.routes.test.ts`, `org-rbac.routes.test.ts`); and
  DTO/envelope shape with no secret leakage and no cross-org existence leak
  (`dto-shape.test.ts`).
- **Proven by integration tests (API 25, DB 9).** Against live PostgreSQL: Last
  Owner protection holds **transactionally**, including a concurrency race where two
  simultaneous owner demotions serialize and exactly one Owner survives; soft-removal
  writes the lifecycle markers and never hard-deletes; a removed membership loses
  access to **every** org-scoped surface (effective permissions, member listing, and
  the org-scoped RBAC reads); and member-management actions write organization-scoped
  audit rows.
- **Proven by migration-from-scratch.** `db:reset:test` drops and rebuilds the
  schema and applies the idempotent seed cleanly; `migrate.integration.test`
  re-applies the baseline twice (idempotent) and asserts the seeded rows equal the
  canonical seed constants — 23 permissions, 56 grants (Owner 23 / Admin 22 /
  Member 8 / Viewer 3).
- **Proven by drift checks.** `db:generate` reports no schema changes (schema ↔
  migrations agree). Three layers prevent catalog/seed/enforcement divergence: a
  pure unit test (`permissions.test.ts`) ties `PERMISSION_SEED` /
  `ROLE_PERMISSION_SEED` to `PERMISSION_CATALOG` / `ROLE_PERMISSIONS` and checks the
  role keys agree across packages; the migration integration test ties the SQL to
  those constants; and the matrix endpoint is built from the seeded rows.
- **Proven by review.** The role-name authorization grep returns no matches — every
  role-identity reference is structural (Last Owner, provisioning, seed). Endpoint
  paths in the docs match the registered routes exactly (10 routes verified).
- **Intentionally deferred (not gaps).** Invitations (so multi-member flows are not
  yet user-facing — tests seed memberships directly); a user-facing audit-log read
  API; target-user session revocation on removal (sessions stay user-scoped per
  Sprint 3); and ESLint (the `lint` script is a Sprint-1 placeholder; `tsc` is the
  active static gate).

---

## 5. Scope Control Confirmation

Implemented exactly the Sprint 5 surface and **nothing** out of scope. Not
implemented (verified absent): invitations / invitation tokens; projects;
entitlements; quotas; API keys; any external API; user-facing organization audit
log (member actions are recorded on the internal audit seam only — no read API);
members/workspace/permission-matrix UI or web demo switcher; custom or
organization-defined roles; role/permission creation/edit/deletion APIs;
resource-level permissions; ABAC; policy engine; PostgreSQL RLS; OAuth; MFA;
password reset; Stripe; workers/queues; deployment automation; npm publishing.

Authorization model: ordinary business authorization checks permission keys; the
only role-name check is the structural **Last Owner** invariant. Removed
memberships never grant access. Cross-organization access fails safely with an
indistinguishable 404. Target-user session revocation was intentionally **not**
added — sessions remain user-scoped (Sprint 3).

---

## 6. Documentation Index

- [`rbac-permissions.md`](rbac-permissions.md) — full RBAC & member-management
  reference (A. developer docs, B. architecture, C. contracts/invariants, D.
  integration, E. limitations, F. changelog).
- [`sprint-5-artifact-package.md`](sprint-5-artifact-package.md) — this artifact.
- [`organization-foundation.md`](organization-foundation.md) — Sprint 4 reference,
  updated with a forward note to Sprint 5.
- [`README.md`](../README.md) — endpoint list and scope boundary updated.

---

## 7. Remaining Risks / Known Limitations

- **Two RBAC read surfaces by design.** The global `/v1/roles`, `/v1/permissions`,
  `/v1/permissions/matrix` are authenticated **static reference** (not
  permission-enforced); the permission-enforced reads are the org-scoped
  equivalents. This split is intentional and documented — the risk is only that a
  reader assumes the globals are authorization surfaces, which the docs explicitly
  refute.
- **No invitation path to add external members yet.** Memberships are created only
  by registration (personal workspace) and team creation; adding *other* users is
  intended for the future Invitations module. Tests seed memberships directly to
  exercise multi-member flows. (Scope-correct, but worth stating.)
- **Removed member retains valid access tokens** until expiry for
  organization-independent surfaces; organization access is revoked immediately
  (membership inactive). Session revocation on removal is deliberately deferred.
- **Audit events have no read API.** They are recorded for the future audit-log
  feature; nothing surfaces them yet (by design).
- **`pnpm lint` is a placeholder.** Static linting beyond `tsc` is still deferred
  to a later sprint.

---

## 8. Readiness Assessment

**Sprint 5 is ready for review against the Definition of Done — hardening pass
included.** The permission-first model is implemented end-to-end (catalog → seed →
effective permissions → `requireMembership`/`requirePermission` → member
management); RBAC reference reads are permission-enforced at the organization scope
(with the global catalog documented as static reference); the Last Owner invariant
is enforced transactionally and proven under concurrency; cross-organization
mutations do not leak target existence; contracts expose DTOs only (no raw rows /
no auth internals, asserted by a shape test); the catalog/seed/enforcement cannot
drift (guarded at three layers); documentation matches the implementation; and
every runnable validation command passes.

**The Projects vertical slice may start.** It can build directly on the following,
all of which are stable and require no revisiting:

- the **permission catalog** (`projects.*` keys already exist) and the
  **role→permission mapping** (already grants project permissions per role);
- **effective-permission resolution** and the **`OrganizationActor`** context;
- **`requireMembership`** and **`requirePermission`** (compose
  `requirePermission(actor, "projects.create")` — no role-name checks);
- **member list/mutation semantics**, **Last Owner protection**, and the
  **membership lifecycle** (active/removed) behavior;
- the **fixed role-identity model** (Owner/Admin/Member/Viewer);
- the **public role/permission/member contracts** and the standard
  success/error envelopes.

A Projects module is "add schema + repo + service + routes that compose
`requireMembership` → `requirePermission` and attach to the existing audit seam" —
no RBAC redesign. Nothing in the list above is unstable.

---

## 9. Hardening Pass

A surgical pass after the initial implementation, addressing the Definition-of-Done
risk areas without expanding scope.

**1. RBAC read-surface enforcement.** Added organization-scoped, permission-enforced
reference reads: `GET …/roles` (`roles.read`), `GET …/permissions` and
`…/permissions/matrix` (`permissions.read`). The caller's effective permissions
moved to `GET …/permissions/effective` (active membership only). The global
`/v1/roles`, `/v1/permissions`, `/v1/permissions/matrix` are **kept and explicitly
documented** as authenticated static reference (not permission-enforced). To give a
real negative authorization path, `roles.read` / `permissions.read` were removed
from **Viewer** (Viewer → 3 grants; total 56), so a Viewer is correctly forbidden
(403 `FORBIDDEN`) from the org-scoped reference reads while Owner/Admin/Member are
allowed. Positive and negative paths, plus unauthenticated/removed/cross-org, are
tested in `org-rbac.routes.test.ts`.

**2. Package dependency direction.** Reviewed `@orgistry/db → @orgistry/contracts`.
Decision: **keep it.** The permission catalog and role keys are genuine public
contract (they are the body of `GET /v1/permissions` and appear in API responses),
`@orgistry/contracts` is the lowest domain layer (pure types + zod), the edge is
acyclic (contracts imports nothing from db — verified), and no better neutral home
exists (`shared` is domain-agnostic; `auth-core` is authentication). Added a pure
unit drift test (`packages/db/src/schema/permissions.test.ts`) asserting the seed
equals the catalog/mapping and the role keys agree across packages.

**3. Role-identity usage audit.** `grep` for role-name authorization in production
code returned **no matches**. Every `ROLE_IDS.owner` reference is structural (Last
Owner invariant, owner provisioning, seed/catalog); role-key→id mapping in
`member.service.ts` is a lookup, not a branch. Recorded in `rbac-permissions.md` §B.

**4. Last Owner edge cases.** DB-backed integration coverage confirms: last-Owner
demotion blocked, last-Owner removal (self-removal) blocked, demotion/removal
allowed when another active Owner exists, concurrent owner demotions serialize so
exactly one Owner survives, soft-removal markers set, and a removed membership loses
access to **every** org-scoped surface (effective permissions, member listing, and
the org-scoped RBAC reads).

**5. DTO / error shape.** `dto-shape.test.ts` asserts the Member DTO exposes only
public fields (forbidden-substring scan for password hash, normalized email,
verification/soft-delete markers, session/refresh internals), the Permission DTO
exposes the key (no `perm_` id), the Role DTO exposes exactly
`{id,key,name,description}`, the standard success/error envelopes are used with a
`requestId` on errors, and a cross-organization member mutation returns the same
`MEMBER_NOT_FOUND` as a nonexistent membership (no existence leak).
