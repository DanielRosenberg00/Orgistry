# Permissions, Roles & Member Management (Sprint 5)

Orgistry's permission-first access-control layer: the fixed v1 permission
catalog, the fixed role→permission mapping, reusable organization-scoped
access-control helpers, server-derived actor context, and the member-management
lifecycle (listing, role change, soft removal) protected by a transactional
**Last Owner** invariant. This completes the identity chain begun in Sprint 4:

```
User → Organization → Membership → Role → Permission
```

Sprint 5 is deliberately a permission **foundation**. It does **not** implement
custom/organization-defined roles, any role/permission mutation API, invitations,
projects, entitlements, quotas, API keys, a user-facing audit log, ABAC, a policy
engine, resource-level permissions, or PostgreSQL RLS. See [§E](#e-known-limitations).

---

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Fixed permission catalog + role keys (single source of truth) | `packages/contracts/src/access.ts` |
| Canonical role→permission mapping (`ROLE_PERMISSIONS`) | `packages/contracts/src/access.ts` |
| Role/Permission/Member/Matrix/EffectivePermissions DTOs | `packages/contracts/src/access.ts` |
| `MEMBER_NOT_FOUND`, `LAST_OWNER_REQUIRED` error codes | `packages/contracts/src/error-codes.ts` |
| `permissions`, `role_permissions` tables | `packages/db/src/schema/permissions.ts` |
| Idempotent permission + role-permission seed (derived from the catalog) | `packages/db/migrations/0003_puzzling_titania.sql` |
| Stable seed constants (`PERMISSION_SEED`, `ROLE_PERMISSION_SEED`) | `packages/db/src/schema/permissions.ts` |
| Access-control helpers (`requireMembership`, `requirePermission`, actor) | `apps/api/src/modules/organization/access-control.ts` |
| Effective-permission resolution (`findPermissionKeysForRole`) | `apps/api/src/modules/organization/organization.repo.ts` |
| Member-management persistence (list / role change / removal) | `apps/api/src/modules/organization/organization.repo.ts` |
| Member-management workflows + DTO mapping | `apps/api/src/modules/organization/member.service.ts` |
| Member routes (list / role change / removal) | `apps/api/src/modules/organization/member.routes.ts` |
| Org-scoped RBAC reads (roles/permissions/matrix/effective, permission-enforced) | `apps/api/src/modules/organization/org-rbac.{service,routes}.ts` |
| Global static RBAC reference reads (authenticated catalog) | `apps/api/src/modules/rbac/*` |
| Member-management audit seam (event types + writer) | `apps/api/src/modules/organization/member.events.ts`, `organization.repo.ts` |
| Shared metadata sanitizer | `apps/api/src/lib/security-metadata.ts` |

### Endpoints

```
# Global static RBAC reference (authenticated; NOT permission-enforced)
GET    /v1/roles                                                 -> 200 { items: Role[] }
GET    /v1/permissions                                           -> 200 { items: Permission[] }
GET    /v1/permissions/matrix                                    -> 200 { roles, permissions, matrix }

# Organization-scoped RBAC reads (permission-enforced)
GET    /v1/organizations/:organizationId/roles                   -> 200 { items: Role[] }            (roles.read)
GET    /v1/organizations/:organizationId/permissions             -> 200 { items: Permission[] }      (permissions.read)
GET    /v1/organizations/:organizationId/permissions/matrix      -> 200 { roles, permissions, matrix }(permissions.read)
GET    /v1/organizations/:organizationId/permissions/effective   -> 200 { organizationId, role, permissions }  (active membership only)

# Member management (permission-enforced)
GET    /v1/organizations/:organizationId/members                 -> 200 { items: Member[], nextCursor, hasMore }  (members.read)
PATCH  /v1/organizations/:organizationId/members/:membershipId/role -> 200 { member }                (members.change_role)
DELETE /v1/organizations/:organizationId/members/:membershipId   -> 200 { member }                   (members.remove)
```

All require `Authorization: Bearer <access token>` and use the standard
success/error envelopes with a request id. `:organizationId` is the authority
boundary — never the slug.

**Two RBAC read surfaces — the distinction is deliberate.**

- The **global** `/v1/roles`, `/v1/permissions`, `/v1/permissions/matrix` are an
  **authenticated static catalog**: they describe the platform's fixed RBAC model
  (the same for every tenant) and require only a valid Bearer token. They are
  **not** permission-enforced and must not be read as a tenant's authorization
  state. They exist so a signed-in client can discover the fixed model without an
  organization context.
- The **organization-scoped** `…/roles`, `…/permissions`, `…/permissions/matrix`
  are the **permission-enforced** equivalents: they require an active membership
  **and** `roles.read` (for roles) or `permissions.read` (for the permission
  catalog and matrix). `…/permissions/effective` returns the caller's **own**
  effective permissions and requires active membership only (no extra gate — it is
  their own set). Everything else under `/v1/organizations/:organizationId/*`
  requires an active membership plus the listed permission.

### How an organization-scoped route is authorized

Every organization-scoped route composes the same pipeline, top to bottom:

```
authenticate (Bearer)                         // who is the user?      auth boundary
  -> requireMembership(repo, { userId, organizationId })   // active member?  OrganizationActor
       -> requirePermission(actor, "members.read")          // may they do this?
            -> repository workflow (transactional where it mutates)
                 -> map persistence rows to DTOs (never raw rows)
```

`requireMembership` (`access-control.ts`) resolves the organization context
(existence + active status + **active** membership, via the Sprint 4
`resolveOrganizationContext`), then derives the membership role's effective
permissions through the role→permission mapping and returns a complete
`OrganizationActor`. `requirePermission` is a pure check against that
already-resolved permission set. A missing organization, an inactive
organization, and a missing/removed membership all surface the **same**
`ORGANIZATION_NOT_FOUND` 404 — cross-organization access is indistinguishable
from non-existence.

### Where things live

- **Catalog & mapping (source of truth):** `packages/contracts/src/access.ts`.
- **Seed (derived from the catalog):** `packages/db/src/schema/permissions.ts`
  builds `PERMISSION_SEED` / `ROLE_PERMISSION_SEED`; the migration inserts those
  rows idempotently.
- **Access-control helpers:** `apps/api/src/modules/organization/access-control.ts`.
- **Member workflows/routes:** `member.service.ts`, `member.routes.ts`.
- **Org-scoped RBAC reads (permission-enforced):** `org-rbac.service.ts`, `org-rbac.routes.ts`.
- **Global static RBAC reference reads:** `apps/api/src/modules/rbac/`.

### How future modules should use the foundation

A future organization-scoped module (Projects, Invitations, API Keys, …) does
**not** re-implement authorization. It:

1. Authenticates the Bearer token via the auth boundary (as the routes already do).
2. Calls `requireMembership(orgRepo, { userId, organizationId, requestId })` to
   get an `OrganizationActor`.
3. Calls `requirePermission(actor, PERMISSION_KEYS.projectsCreate)` (or the
   relevant key) — never a role-name check.
4. Performs its workflow and maps rows to DTOs.

The permission keys for these modules already exist in the catalog (e.g.
`projects.*`, `invitations.*`, `api_keys.*`, `audit_events.read`) and are already
mapped to roles — so wiring a new module is "add routes + service", not "redesign
RBAC". A key existing does **not** mean the owning module exists yet.

### How to extend the model safely

- **Add a permission:** add the key to `PERMISSION_KEYS` + an entry to
  `PERMISSION_CATALOG`, assign it in `ROLE_PERMISSIONS`, regenerate the seed into
  a **new** migration (do not edit a released one), and update tests. The matrix
  endpoint and `requirePermission` pick it up automatically.
- **Do not** add custom roles, role/permission mutation endpoints, or per-org
  permission overrides — those are explicitly out of v1 scope ([§E](#e-known-limitations)).

---

## B. Architectural Notes

### Fixed role model

Four system roles, fixed in v1: **Owner**, **Admin**, **Member**, **Viewer**
(`ROLE_KEYS` in both `@orgistry/contracts` and `@orgistry/db`; the API asserts the
two agree). Roles are seeded with stable ids (`role_owner`, …). There is no role
creation/update/deletion and no per-organization custom role.

### Fixed permission catalog

23 code-defined, typed, stable permission keys (`PERMISSION_KEYS` /
`PERMISSION_CATALOG`). Permissions are read-only in v1 — no create/edit/delete
API. Some keys (`invitations.*`, `projects.*`, `api_keys.*`, `audit_events.read`,
`plan.*`) are **reserved** for modules not built this sprint; they exist so the
catalog and mapping are stable, not because the owning feature exists.

### Role → permission mapping

The canonical mapping is `ROLE_PERMISSIONS` in `@orgistry/contracts`:

| Role | Permissions | Count |
| --- | --- | --- |
| **Owner** | the entire catalog | 23 |
| **Admin** | everything **except** `plan.change_demo` | 22 |
| **Member** | `org.read`, `members.read`, `roles.read`, `permissions.read`, `projects.read/create/update`, `plan.read` | 8 |
| **Viewer** | `org.read`, `projects.read`, `plan.read` | 3 |

Semantics: Owner is strictly more capable than Admin (the single Owner-only
capability is `plan.change_demo`, standing in for billing/plan ownership). Member
can read the organization, view its RBAC reference data (`roles.read` /
`permissions.read`), and contribute to projects, but cannot manage members or
administrative surfaces. Viewer has read-only visibility of the organization and
its first-class resources only — it is withheld `members.read` (no member roster)
**and** `roles.read` / `permissions.read` (RBAC introspection is treated as an
administrative/contributor concern), giving a clean privilege gradient. (A Viewer
can still discover the platform's fixed model through the global static catalog,
and can always read its **own** effective permissions via `…/permissions/effective`.)

This object **is** the matrix: `PERMISSION_SEED` / `ROLE_PERMISSION_SEED` are
generated from it, the migration inserts exactly those rows, and the matrix
endpoint returns the **seeded** rows — so the catalog, the database, the typed
`requirePermission` helper, and the read-only endpoints can never drift. The
`migrate.integration.test` asserts the seeded rows equal the canonical seed.

### Why routes check permissions, not role names

Permissions are the authorization primitive so that:

- capabilities can be reasoned about and tested per-action (`members.change_role`)
  rather than per-persona;
- a future change to what a role can do is a single edit to `ROLE_PERMISSIONS` +
  seed, with **no** route changes;
- new modules compose the same `requirePermission` and inherit consistent
  behavior.

`requirePermission` consults the actor's resolved permission **set**, never the
role name — an actor whose role is named "owner" but whose permission set is empty
is denied (proven by a unit test).

### Role identity usage audit

A grep audit confirms there is **no** role-name authorization in production code.
Search:

```
grep -rnE "=== ?['\"](owner|admin|member|viewer)['\"]|['\"](owner|admin|member|viewer)['\"] ?===|role ?===|roleKey ?===" \
  --include='*.ts' apps/api/src packages \
  | grep -vE '\.test\.ts|/testing/|/access\.ts|/organizations\.ts|/permissions\.ts'
```

Result: no matches. Every reference to the Owner role identity (`ROLE_IDS.owner`)
is structural and lives in exactly three sanctioned places:

- the Last Owner invariant in `organization.repo.ts` (`lockActiveOwners`, the
  demotion/removal checks);
- owner-membership provisioning in `organization.provisioning.ts`;
- the seed/canonical catalog (`schema/organizations.ts`, `schema/permissions.ts`).

Role-key→id mapping in `member.service.ts` (`ROLE_IDS[input.newRole]`) is a lookup,
not an authorization branch. Ordinary authorization everywhere else goes through
`requirePermission`.

### Package & source-of-truth decision (the catalog lives in contracts)

The fixed permission catalog, role keys, and role→permission mapping are defined
**once** in `@orgistry/contracts` (`access.ts`). `@orgistry/db` depends on
`@orgistry/contracts` and **derives** its seed rows (`PERMISSION_SEED`,
`ROLE_PERMISSION_SEED`) from them.

This direction is correct, not a violation:

- **It is genuinely public contract.** Permission keys and role keys appear in API
  responses (effective permissions, the matrix), clients branch on them, and the
  catalog `{ key, name, description }` is literally the body of `GET /v1/permissions`.
  They belong in the contracts package alongside the DTO schemas that reference them.
- **The dependency points the right way.** `@orgistry/contracts` is the lowest
  domain layer (pure types + zod, zero runtime deps beyond zod). Persistence
  depending on the contract it implements is standard layering — analogous to db
  already consuming shared types. The reverse (contracts → db) does **not** exist.
- **No cycle.** `@orgistry/contracts` imports nothing from `@orgistry/db`
  (verified by grep); the graph is acyclic.
- **No better neutral home.** `@orgistry/shared` is deliberately domain-agnostic
  utilities (ids, cursors, env); `@orgistry/auth-core` is authentication
  primitives. A domain RBAC catalog fits neither, and the workspace has no
  pre-existing access-control package. Creating one for four role keys and a
  permission list would be over-engineering.

**Drift protection.** Three layers guarantee the catalog, the seed, and
enforcement cannot diverge: a pure unit test
(`packages/db/src/schema/permissions.test.ts`) asserts `PERMISSION_SEED` /
`ROLE_PERMISSION_SEED` equal `PERMISSION_CATALOG` / `ROLE_PERMISSIONS` and that the
role keys agree across packages; the DB-backed `migrate.integration.test` asserts
the migration SQL matches those seed constants; and the matrix endpoint is built
from the **seeded rows**, so what it shows is what `requirePermission` enforces.

### Why Last Owner protection is the role-check exception

The structural invariant — *every active organization has at least one active
Owner* — is about **role identity itself**, not a capability. "Owner" is the
protected domain concept, so the check necessarily references the Owner role. This
is the one sanctioned role-name check, and it lives in the repository transaction,
not in route authorization.

### Transactional Last Owner protection

The invariant is enforced inside the mutation's database transaction, not as a
read-before-write pre-check (which would race). Both `changeMemberRole` and
`removeMember`:

1. lock the organization's active-Owner membership rows `FOR UPDATE` in a
   deterministic order (so concurrent owner-affecting mutations serialize);
2. lock and validate the target membership;
3. if the change would drop the active-Owner count to zero, throw
   `LAST_OWNER_REQUIRED`;
4. apply the change and write the audit event — all in the same transaction.

A DB integration test fires two concurrent Owner demotions and asserts exactly one
succeeds and one active Owner survives — the behavior a pre-check cannot guarantee.

### Tradeoffs & rejected alternatives

- **Custom/organization-defined roles** — rejected for v1: large surface,
  unnecessary for the foundation. The schema reserves `roles.is_system` but no
  custom-role path is implemented.
- **Resource-level permissions / ABAC / policy engine** — rejected: the model is
  role→permission at the organization scope. Per-resource and attribute-based
  authorization are out of scope.
- **PostgreSQL RLS** — rejected: authorization is enforced in the application
  layer through `requireMembership`/`requirePermission`; RLS is not used.
- **Role-editor APIs** — rejected: roles and permissions are fixed and read-only.
- **Matrix as a hardcoded presentation** — rejected: the matrix is read from the
  seeded rows so it cannot drift from enforcement.

---

## C. Contracts & Invariants

### Stable role keys

`owner`, `admin`, `member`, `viewer` (`roleKeySchema`). Clients/code may branch on
these **only** for structural role-identity invariants (Last Owner) — never for
ordinary authorization.

### Stable permission keys

The 23 dotted `<resource>.<action>` keys in `PERMISSION_KEYS` (`permissionKeySchema`).
Stable strings; clients may branch on them. **Permissions are not entitlements**
(a permission says *may this actor perform this action*, not *is this capability
included in the plan*) and **quotas are not permissions** (limits are not modeled
here).

### DTOs (never raw rows; no secrets)

- **Role** `{ id, key, name, description }`
- **Permission** `{ key, name, description }` — the stable identifier is the key;
  the internal `perm_…` id is not exposed.
- **PermissionMatrix** `{ roles: Role[], permissions: Permission[], matrix: Record<roleKey, permissionKey[]> }`
- **EffectivePermissions** `{ organizationId, role, permissions: permissionKey[] }`
- **Member** `{ id, user: { id, email, displayName }, role, status, joinedAt, createdAt, removedAt }`
- **MemberList** `{ items: Member[], nextCursor, hasMore }` (opaque cursor pagination)
- **MemberRoleChangeRequest** `{ role: roleKey }`; responses return `{ member }`.

Member DTOs expose only `id`, `email`, `displayName` for the user — never password
hashes, normalized email, verification state, soft-delete markers, or any
auth/session internal. These guarantees are enforced by `dto-shape.test.ts`
(exact-key assertions + a forbidden-substring scan of the raw response).

### Invariants

- **Active membership required.** Every access-control path requires an **active**
  membership in an **active** organization. Removed/inactive memberships never
  authorize anything (the row is retained for history but ignored).
- **Organization ID is the tenant boundary.** All member operations validate
  organization id + membership ownership; the slug is never an authorization input.
- **Last Owner.** Every active organization keeps ≥1 active Owner; enforced
  transactionally for role change, removal, self-demotion, and self-removal.
- **No custom roles in v1.** The four system roles are the only roles.
- **No drift.** The matrix and effective permissions are sourced from the seeded
  mapping that `requirePermission` enforces (guarded by a unit test and the
  migration integration test).
- **Soft removal.** Member rows are never hard-deleted; removal sets `status =
  'removed'`, `removed_at`, and `removed_by_user_id`. Removal is idempotent.
- **No existence leak on mutation.** A member role-change/removal targeting a
  membership that belongs to another organization returns the **same**
  `MEMBER_NOT_FOUND` as a wholly nonexistent membership id (proven by a test), so
  the caller cannot probe cross-organization membership existence.
- **Reference reads are permission-gated per org.** The org-scoped role/permission
  catalog and matrix require `roles.read` / `permissions.read`; the global static
  catalog is authenticated reference only and is **not** an authorization surface.

---

## D. Integration Notes

### Composing an organization-scoped route

```ts
const user = await authenticator.authenticate(token, ctx);          // auth boundary
const actor = await requireMembership(orgRepo, {                    // active membership + effective perms
  userId: user.id,
  organizationId,
  requestId: ctx.requestId,
});
requirePermission(actor, PERMISSION_KEYS.projectsCreate);          // permission check (not role name)
// ... workflow, then map rows -> DTOs
```

### Future modules

- **Projects** — gate reads/writes with `projects.read` / `projects.create` /
  `projects.update` / `projects.delete`. The keys and role mappings already exist.
- **Invitations** — `invitations.read` / `invitations.create` / `invitations.revoke`
  (Owner/Admin). Member addition currently happens only via registration
  (personal workspace) and team creation; invitations are the intended path to add
  others and should reuse `requireMembership`/`requirePermission`.
- **API Keys** — `api_keys.read` / `api_keys.create` / `api_keys.revoke`.
- **Audit** — `audit_events.read`. See the audit seam below.
- **Entitlements / Plan** — `plan.read` / `plan.change_demo`. Entitlements are a
  separate concern layered **above** permissions; do not encode plan limits as
  permissions.

### Member-management audit seam

Member role changes and removals are recorded as durable, organization-scoped rows
in the existing `security_events` table (which already carries `organization_id`),
written **inside the same transaction** as the mutation. Event types live in
`member.events.ts` (`org.member_role_changed`, `org.member_removed`); metadata is
passed through the shared sanitizer (`lib/security-metadata.ts`) and never contains
secrets. There is **no** read API for these events. A future organization
audit-log feature attaches here: it would read these (and future) organization
events and expose them through a dedicated surface gated by `audit_events.read`.

---

## E. Known Limitations

Sprint 5 does **not** implement:

- invitations or invitation tokens;
- projects, entitlements, quotas, API keys;
- any external API;
- a user-facing organization audit log (member actions are recorded on the audit
  seam only — no read endpoint);
- workspace/member UI, permission-matrix UI, or any web demo switcher;
- custom roles or organization-defined roles;
- role/permission creation/edit/deletion (everything RBAC is read-only);
- resource-level permissions, ABAC, a policy engine, or PostgreSQL RLS;
- OAuth, MFA, password reset, Stripe, workers/queues, or production deployment
  automation.

The global `/v1/roles`, `/v1/permissions`, `/v1/permissions/matrix` endpoints
remain as an **authenticated static reference catalog** (not permission-enforced
and not organization-scoped) for client discovery of the fixed model. The
permission-enforced reference surfaces are the org-scoped equivalents
(`/v1/organizations/:id/roles`, `…/permissions`, `…/permissions/matrix`). This
split is intentional and documented; the global endpoints must not be treated as a
tenant's authorization state.

Target-user **session revocation on member removal is intentionally not done** —
sessions remain user-scoped (Sprint 3). A removed member loses organization access
immediately (membership is inactive), but their existing access tokens remain
valid for the organization-independent surfaces until they expire.

---

## F. Sprint 5 Changelog

**Implementation summary.** Added the permission-first RBAC layer on top of the
Sprint 4 organization/membership foundation: a fixed permission catalog and
role→permission mapping (single source of truth in `@orgistry/contracts`),
idempotent persistence + seed, reusable `requireMembership`/`requirePermission`
helpers with a server-derived `OrganizationActor`, read-only roles/permissions/
matrix surfaces, an effective-permissions endpoint, and the member-management
lifecycle (list/role-change/soft-removal) with transactional Last Owner protection
and an organization-scoped audit seam.

**Schema / seed changes.** New `permissions` and `role_permissions` tables
(`0003_puzzling_titania.sql`) with `uq_permissions_key` and the composite
`role_permissions` primary key. Idempotent seed of 23 permissions and 56
role→permission grants, **derived** from the canonical catalog so it cannot drift.

**API / contract changes.** New `access.ts` contracts (role/permission/member/
matrix/effective-permission DTOs, role + permission key enums, the
`ROLE_PERMISSIONS` mapping); `MEMBER_NOT_FOUND` and `LAST_OWNER_REQUIRED` error
codes; the global static catalog (`/v1/roles`, `/v1/permissions`,
`/v1/permissions/matrix`); the org-scoped permission-enforced reads
(`…/roles`, `…/permissions`, `…/permissions/matrix`, `…/permissions/effective`);
and member management (`…/members`, role change, removal). The metadata sanitizer
moved to `lib/security-metadata.ts` (re-exported from the auth module for existing
call sites).

**Test coverage added.** Contract tests for the catalog/mapping/DTOs; access-control
unit tests (membership/permission gating, no role-name authorization); global +
org-scoped RBAC route tests (read-only roles/permissions/matrix consistency,
roles.read/permissions.read enforcement with positive and negative paths); member
route tests (listing, role change, removal, Last Owner, cross-org isolation); a
DTO/envelope-shape test; a pure seed-vs-catalog drift test; DB integration tests
(transactional Last Owner including a concurrency race, soft-removal markers, audit
events, removed-membership loses access to members/effective/roles surfaces);
extended migration-from-scratch assertions for the new tables/seed.

### Sprint 5 hardening pass

A focused hardening pass after the initial implementation:

- **RBAC read-surface enforcement.** Added org-scoped, permission-enforced
  `…/roles` (roles.read), `…/permissions` and `…/permissions/matrix`
  (permissions.read); moved the caller's effective permissions to
  `…/permissions/effective` (membership only). The global `/v1/*` catalog is kept
  and documented as authenticated static reference (not permission-enforced).
- **Viewer mapping tightened.** `roles.read` / `permissions.read` were removed from
  Viewer (3 grants; total 56) so Viewer is denied the org-scoped reference reads —
  a real negative authorization path, not a test-only fixture.
- **Dependency direction reviewed.** `@orgistry/db → @orgistry/contracts` confirmed
  correct (acyclic; persistence derives from public contract) and documented above,
  with a pure drift test added.
- **Role-identity audit** recorded (grep + conclusion: no role-name authorization).
- **DTO/error-shape and cross-org no-leak** tests added.

**Documentation updates.** This reference (`docs/rbac-permissions.md`), the Sprint
5 artifact package, README updates (endpoints + scope), and a forward-reference
note added to `docs/organization-foundation.md`.

**Known limitations.** See [§E](#e-known-limitations).

**Readiness for the next Projects vertical slice.** The permission keys
(`projects.*`) and role mappings already exist; a Projects module composes
`requireMembership` → `requirePermission` and reuses the organization context and
audit seam with no RBAC redesign.
