# Organization Foundation (Sprint 4)

Orgistry's tenant layer: the `User → Organization → Membership` chain plus the
minimum role baseline needed to assign a membership a role. Sprint 4 makes every
registered user the Owner of an auto-provisioned **personal workspace**, lets
authenticated users create **team** organizations, and lets them list/read only
the organizations where they hold an **active membership**. It also ships a
reusable **organization context resolver** that every future organization-scoped
route will build on.

This sprint is deliberately a foundation. It does **not** implement permissions,
role→permission mapping, effective permissions, member management (list/role
change/removal), Last-Owner protection flows, invitations, entitlements, quotas,
projects, API keys, organization audit logs, or any workspace UI. See
[§E](#e-known-limitations).

> **Superseded in part by Sprint 5.** Permissions, the role→permission mapping,
> effective permissions, member management (list/role-change/removal), and
> transactional **Last Owner** protection are now implemented — see
> [`rbac-permissions.md`](rbac-permissions.md). This document remains the
> reference for the Sprint 4 tenant/membership foundation and the
> `resolveOrganizationContext` resolver that the Sprint 5 `requireMembership`
> helper builds on. The remaining §E limitations (invitations, projects,
> entitlements, quotas, API keys, user-facing audit log, workspace UI) still hold.

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| `roles`, `organizations`, `memberships` tables + partial unique index | `packages/db/src/schema/organizations.ts` |
| Schema migration + idempotent role seed | `packages/db/migrations/0002_fuzzy_betty_ross.sql` |
| Stable role IDs/keys + canonical seed (`ROLE_IDS`, `ROLE_KEYS`, `ROLE_SEED`) | `packages/db/src/schema/organizations.ts` |
| Organization/membership/role DTOs, enums, error codes | `packages/contracts/src/organizations.ts`, `error-codes.ts` |
| Organization provisioning primitives (slug + org+owner insert) | `apps/api/src/modules/organization/organization.provisioning.ts` |
| Organization persistence (team create, find, list) | `apps/api/src/modules/organization/organization.repo.ts` |
| Organization workflows (create/list/read + DTO mapping) | `apps/api/src/modules/organization/organization.service.ts` |
| Reusable organization context resolver | `apps/api/src/modules/organization/organization.context.ts` |
| HTTP routes | `apps/api/src/modules/organization/organization.routes.ts` |
| Transactional registration provisioning | `apps/api/src/modules/auth/auth.repo.ts` (`registerAccount`) |
| Shared request-context/Bearer helpers | `apps/api/src/lib/request-context.ts` |

### Endpoints

```
POST /v1/organizations                     -> 201 { organization, membership }
GET  /v1/organizations                     -> 200 { items, nextCursor, hasMore }
GET  /v1/organizations/:organizationId     -> 200 { organization, membership }
```

All three require `Authorization: Bearer <access token>` and use the standard
success/error envelopes with a request id. `:organizationId` is the authority
boundary — never the slug.

### How organization creation works

`POST /v1/organizations` authenticates the Bearer token through the auth service,
validates the body (`organizationCreateRequestSchema`), and calls
`OrganizationService.createOrganization(userId, input)`. The repository creates,
**in one transaction**, a `team` organization and the creator's **active Owner**
membership (`organization.repo.ts → createTeamOrganization`). The response is an
explicit DTO pair `{ organization, membership }`; no raw row is ever returned and
no entitlement/quota/project/API key/invitation/permission/audit record is
created.

Slug policy (`organization.provisioning.ts`):

- **Explicit slug** (`slug` in the body): honored if free, otherwise rejected
  with `409 ORGANIZATION_SLUG_TAKEN`. It is never silently changed.
- **Derived slug** (no `slug`): `slugify(name)` then auto-resolved to the first
  free `base`, `base-2`, `base-3`, … value.

### How personal workspace creation works during registration

Registration is transactional. `AuthService.register` computes the workspace name
(`"<displayName>'s Workspace"`) and a collision-resistant slug base
(`personalWorkspaceSlugBase`), then calls `AuthRepository.registerAccount`, which
runs a **single database transaction**:

1. insert the `user` (normalized-email unique index is the guard),
2. resolve a unique slug and insert the personal `organization`
   (`type=personal`) + the user's **active Owner** `membership`,
3. insert the `session`,
4. insert the first `refresh_token` of a new family (hash-only).

If any step fails, the whole transaction rolls back — so a registered user can
never exist without a personal workspace. The access token is signed and the
`auth.registration_succeeded` event is written after the transaction commits.

### Where the code lives & how to extend it safely

- **Schema/migrations** live in `@orgistry/db`. New tenant tables go in
  `schema/organizations.ts` and the barrel `schema/index.ts`; regenerate with
  `pnpm db:generate`.
- **Public DTOs** live in `@orgistry/contracts`. Routes return contracts, never
  rows.
- **Provisioning primitives** (`organization.provisioning.ts`) are the single
  source of truth for how an org + owner membership is created. They take a
  `DbExecutor`, so they run standalone (team create) or inside a larger
  transaction (registration). New flows that create organizations should reuse
  them rather than re-implementing the insert/slug rules.
- **The context resolver** (`organization.context.ts`) is the entry point for any
  future organization-scoped route. Build on it; do not re-derive membership
  checks ad hoc.
- **Role assignment** uses the seeded baseline via `ROLE_IDS`. Adding behavior to
  roles (permissions) is a separate, deliberate sprint — see [§E](#e-known-limitations).

## B. Architectural Notes

### Key design decisions

- **Organization ID, not slug, is the authority boundary.** Every read/membership
  check is keyed on `organizations.id`. The slug is a globally-unique, UI-friendly
  label only; it never participates in authorization. This keeps URLs/labels
  reshapeable without touching the security model.
- **Membership-based access, not role-name checks.** List/read access requires an
  **active membership**; the resolver returns the role for display but never
  branches on role *name* to authorize. This is intentionally **not** the future
  `requirePermission` helper.
- **Uniform not-found.** A missing organization, an inactive organization, and a
  missing/removed membership all return the same `404 ORGANIZATION_NOT_FOUND`, so
  a caller cannot distinguish "doesn't exist" from "you're not a member."
- **Active-by-default visibility.** The list endpoint returns only `active`
  organizations with an `active` membership; the read resolver rejects non-active
  organizations. `archived`/`suspended` exist in the enum for forward stability
  but no flow produces them yet.

### Transaction boundaries

- **Registration**: one transaction spanning user + personal organization + Owner
  membership + session + refresh token (`auth.repo.ts → registerAccount`). Token
  signing and the security event happen *after* commit (pure crypto / best-effort
  audit, neither belongs in the write transaction).
- **Team creation**: one transaction spanning slug resolution + organization +
  Owner membership (`organization.repo.ts → createTeamOrganization`).

The auth module composes organization *persistence* (it imports the provisioning
primitives) but not the organization *service/routes*. The dependency points one
way: `auth → organization` (registration is the composition point); the
organization module never imports auth concretely — its routes depend on a small
structural `OrganizationAuthenticator` interface that the auth service satisfies.

### Slug strategy & its tradeoff

`slugify` produces lowercase, hyphen-joined, length-capped slugs matching the
contract pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Personal workspace slugs append a
short random token so the hot registration path is collision-free; team slugs
auto-resolve with a numeric suffix for tidy URLs. Uniqueness is resolved by a
read-then-insert inside the transaction; the **unique index on `slug` is the
authoritative guard** for the small check-then-insert race. The accepted tradeoff:
a concurrent collision on a derived slug surfaces as a rare error rather than a
silent retry across transactions. Explicit-slug conflicts are surfaced
deterministically as `409`.

### Membership uniqueness strategy

A **partial unique index** `uq_memberships_active_user_org (user_id,
organization_id) WHERE status = 'active'` enforces *at most one active membership
per (user, organization)* at the database level, while allowing historical
`removed` rows to accumulate for the same pair (so a future re-join leaves an
audit trail). Application code does a friendly pre-check where useful; the index
is the guarantee.

### Why permissions and member management are deferred

Sprint 4 is the tenant *foundation*. Roles exist only so a membership can carry a
role identity; wiring role→permission semantics now would bake an authorization
model in before its requirements are clear. Member management (list/role
change/removal) and Last-Owner protection are deferred for the same reason — the
schema already carries `invited_by_user_id`, `removed_at`, `removed_by_user_id`,
and the partial index, so those flows can be added without a redesign.

## C. Contracts & Invariants

### DTOs (`@orgistry/contracts`)

- **`Organization`**: `{ id, name, slug, type, status, createdAt, updatedAt }`.
  Omits `createdByUserId` and archive internals.
- **`MembershipSummary`**: `{ id, status, role, joinedAt, createdAt }` — the
  caller's membership context for a future workspace switcher.
- **`RoleSummary`**: `{ id, key, name }` — identity only, **never** permissions.
- **`OrganizationWithMembership`**: `{ organization, membership }` — shared by
  create, read, and each list item.
- **List**: `{ items, nextCursor, hasMore }` — opaque cursor pagination.

### Enums

- `OrganizationType`: `personal | team`.
- `OrganizationStatus`: `active | archived | suspended` (only `active` produced).
- `MembershipStatus`: `active | removed`.

### Error codes

- `ORGANIZATION_NOT_FOUND` (404) — does not exist **or** caller is not an active
  member (indistinguishable).
- `ORGANIZATION_SLUG_TAKEN` (409) — a requested explicit slug is in use.

### Invariants (do not change without a deliberate migration/design review)

1. Every newly registered user has exactly one personal workspace
   (`type=personal`, `status=active`) with an active Owner membership.
2. Every new organization has an active Owner membership for its creator.
3. At most one **active** membership per `(user, organization)` (partial unique
   index).
4. An **active membership** is required to list or read an organization through
   the user-facing API.
5. Organization **ID** is the authority boundary; **slug is never** an
   authorization input.
6. Slug is globally unique.
7. No API response returns a raw database row, a permission field, or a
   persistence-only column.

## D. Integration Notes

- **Registration ↔ organization.** `auth.repo.ts` imports the provisioning
  primitives from the organization module and runs them inside the registration
  transaction. Row-construction rules stay in one place (the organization
  module); atomicity is owned by the registration flow.
- **Authenticated routes ↔ current user.** Organization routes resolve the
  caller via `OrganizationAuthenticator.authenticate(token, ctx)` (the auth
  service), then pass the resolved `userId` into the organization service. The
  organization service is auth-agnostic — it never sees tokens.
- **The context resolver & the next sprint.** `resolveOrganizationContext(repo,
  { userId, organizationId })` verifies existence + active status + active
  membership and returns `{ organization, membership, role }`. Future
  organization-scoped routes (members, projects, settings, …) call it first to
  establish context, then layer their own checks (e.g. permissions) on top. It is
  the seam permissions will plug into without rewriting existing routes.
- **Request IDs.** Unchanged: `request.id` flows into every error envelope's
  `requestId`, so one id correlates an HTTP response with the logs.

## E. Known Limitations

Sprint 4 intentionally does **not** implement:

- Permission catalog, role→permission mapping, effective permissions, permission
  matrix, or any permission-first authorization helper.
- Member listing, member role change, member removal, or Last-Owner protection
  mutation flows.
- Invitations.
- Entitlements, quotas, projects, API keys, an external API, or organization
  audit logs.
- Organization lifecycle mutations (archive/suspend) — `archived`/`suspended`
  exist in the enum/schema only.
- A workspace switcher UI, active-organization persistence in the web demo, or
  any organization settings UI.
- PostgreSQL Row-Level Security.

The schema is shaped so these can be added without redesign (see [§B](#b-architectural-notes)).

## F. Sprint Changelog

A living record of Sprint 4 — see [`sprint-4-artifact-package.md`](sprint-4-artifact-package.md)
for the full iteration summary, validation results, and quality evolution.

### Iteration 1 — Implementation

Tenant schema (roles/organizations/memberships) + migration + idempotent role
seed; organization contracts/DTOs/enums/error codes; the organization module
(provisioning primitives, repo, service, routes, context resolver, errors);
transactional registration provisioning (`registerAccount`); unit + integration
tests; and the documentation set (this reference + the artifact package, plus
updates to the auth/database/api-conventions docs and README).

### Iteration 2 — Hardening

Verification and consistency pass, no architecture change:

- **Documentation consistency.** Removed contradictory present-tense "not
  implemented / registration creates no workspace" claims that had parenthetical
  Sprint-4 annotations. `auth-foundation.md` §E was reframed as a clearly-labeled
  historical Sprint 2 snapshot with current-status annotations; the now-false
  "organization-linked registration remains out of scope" line was corrected.
  `session-lifecycle.md` and the Sprint 3 artifact's out-of-scope sections were
  given clearly-labeled "superseded by Sprint 4" notes instead of false
  present-tense claims.
- **Transaction boundary.** Confirmed the registration transaction spans
  user + organization + Owner membership + session + refresh token; added an
  explicit code comment that the success security event is written **post-commit**
  (best-effort audit, deliberately outside the account invariant). The atomic
  rollback integration test was strengthened to assert the rolled-back account's
  user row is absent, proving a real DB rollback after the org/membership writes.
- **Slug / membership / role / boundary checks.** Verified explicit-slug
  conflicts and check-then-insert races both map to `ORGANIZATION_SLUG_TAKEN`
  (never an unhandled 500), derived collisions resolve deterministically, the
  one-active-membership partial unique index is DB-enforced and DB-tested, no
  route or resolver branches on role name, and the `auth → organization.provisioning`
  dependency is one-way with no cycle.
