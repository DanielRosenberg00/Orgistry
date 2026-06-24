# Sprint 4 Artifact Package

Official completion artifact for Orgistry Sprint 4 — **Organization Foundation &
Personal Workspace Creation**. This is the authoritative record of what the
sprint delivered, how it was validated, the contracts and invariants it
establishes, what was deliberately left out, and what the next sprint may rely
on. It summarizes and indexes; the full engineering reference lives in
[`organization-foundation.md`](organization-foundation.md).

Sprint 4 introduces the SaaS tenant layer — the `User → Organization →
Membership` chain — on top of the Sprint 2/3 authentication and session
foundation. Permissions, member management, invitations, entitlements, quotas,
projects, API keys, organization audit logs, and any workspace UI remain
explicitly out of scope.

**Status: complete — ready to close.** Implementation and a hardening pass are
done; every validation command in §5 was re-run in this final packaging pass
against a disposable local PostgreSQL + Redis and completed successfully. The
only non-passing entry is `pnpm lint`, a no-op Sprint-1 placeholder, reported as
such (not counted as lint coverage).

---

## 1. Implementation Summary

**Database / schema / migrations / seeds.** New `roles`, `organizations`, and
`memberships` tables (`packages/db/src/schema/organizations.ts`) with: prefixed
opaque IDs (`role_`/`org_`/`mem_`); a global unique index on `organizations.slug`;
a **partial unique index** `uq_memberships_active_user_org … WHERE status =
'active'` enforcing one active membership per (user, organization); and
created-by/status/user/org/role lookup indexes. The generated migration
(`0002_…sql`) creates all three tables and ships an **idempotent role seed**
(`INSERT … ON CONFLICT (key) DO NOTHING`) for the v1 baseline roles
(Owner/Admin/Member/Viewer) with stable IDs (`ROLE_IDS`). A `DbExecutor` type was
added to `@orgistry/db` so persistence helpers run both standalone and inside a
transaction.

**Contracts.** `packages/contracts/src/organizations.ts` adds the organization,
membership-summary, and role-summary DTOs; the `OrganizationType`,
`OrganizationStatus`, and `MembershipStatus` enums; the create request/response,
list response, and read response; and the `ORGANIZATION_NOT_FOUND` /
`ORGANIZATION_SLUG_TAKEN` error codes. No permission fields, no raw rows.

**API / domain module.** New `apps/api/src/modules/organization/` with:
provisioning primitives (slug derivation + org+owner-membership insert),
Drizzle repository (transactional team create, find-by-id, active-membership
join, cursor-paginated list), service (create/list/read + DTO mapping), a
reusable **organization context resolver**, error factories, routes, and
in-memory test doubles over a shared store. Three endpoints: `POST/GET
/v1/organizations` and `GET /v1/organizations/:organizationId`, all
Bearer-authenticated.

**Registration integration.** `AuthRepository.registerAccount` provisions the
account in **one transaction** — user + personal workspace (organization + active
Owner membership) + session + first refresh token — so a registered user always
has a personal workspace, or the whole registration rolls back. The
`auth.registration_succeeded` **security event is written after the transaction
commits** — it is a best-effort audit record, deliberately outside the account
invariant, so it can never roll back a durable registration (consistent with the
login/refresh/logout event strategy). The auth module composes the organization
provisioning primitives without depending on the organization service/routes.
Bearer/request-context parsing was extracted to a shared `lib/request-context.ts`
used by both modules (behavior-preserving).

**Tests.** Organization route suite (15), provisioning unit suite (6),
organization DB integration suite (7), and additions to the migration-from-scratch
suite (tables, partial unique index, role seed). Auth/session integration
truncation now spans the new tables while preserving the seeded roles.

**Documentation.** New [`organization-foundation.md`](organization-foundation.md)
(A–F engineering reference) and this artifact. Updated `auth-foundation.md`
(registration now provisions a workspace; §E reframed as a labeled historical
Sprint 2 snapshot), `session-lifecycle.md` (Sprint 3 out-of-scope note marked
superseded by Sprint 4), `database-foundation.md`, `api-conventions.md`, and
`README.md`. No new environment variables were required this sprint.

## 2. API Surface

```
POST /v1/organizations                  Bearer  201 { organization, membership }
GET  /v1/organizations                  Bearer  200 { items, nextCursor, hasMore }
GET  /v1/organizations/:organizationId  Bearer  200 { organization, membership }
```

- Authority boundary is `:organizationId`, never slug.
- List returns only `active` organizations where the caller has an `active`
  membership, newest membership first, opaque-cursor paginated.
- Read requires an active membership; non-member and non-existent both return an
  indistinguishable `404 ORGANIZATION_NOT_FOUND`.
- Create assigns the caller as active Owner; explicit-slug conflict → `409
  ORGANIZATION_SLUG_TAKEN`; derived-slug collision auto-resolves (`base-2`, …).

## 3. Invariants

1. Every newly registered user has exactly one personal workspace
   (`type=personal`, `status=active`) with an active Owner membership.
2. Every new organization has an active Owner membership for its creator.
3. At most one **active** membership per `(user, organization)` — partial unique
   index `uq_memberships_active_user_org`.
4. Active membership is required to list/read an organization. A **removed**
   membership grants no access — removed memberships never appear in the list
   response and never satisfy a read.
5. Organization ID is the authority boundary; slug is never an authorization
   input; slug is globally unique and UI-friendly only.
6. Registration provisioning is atomic; a partial failure leaves no user without
   a workspace. The success security event is post-commit and is **not** part of
   this invariant.
7. The role baseline is **identity-only** — a role carries `id`/`key`/`name`, no
   permissions; no route or resolver branches on role name to authorize.
8. No API response returns a raw row, a permission field, or a persistence-only
   column.

## 4. Contracts

`@orgistry/contracts` adds `organizationSchema`, `membershipSummarySchema`,
`roleSummarySchema`, `organizationWithMembershipSchema`,
`organizationCreateRequestSchema`, `organizationCreateResponseSchema`,
`organizationListResponseSchema`, `organizationReadResponseSchema`, the three
enums, and the two error codes. The success/error envelopes, request-id behavior,
and cursor-pagination shape are unchanged and reused.

## 5. Validation

Every command below was **re-run in the final packaging pass** against a
disposable local PostgreSQL + Redis; results reflect that run.

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | ✅ pass | All 7 workspace projects. |
| `pnpm test` | ✅ pass | 168 unit tests, 26 files (15 organization routes, 6 provisioning, all Sprint 1–3 auth/session/contract/config tests preserved). |
| `pnpm --filter @orgistry/db reset:test` | ✅ pass | Test DB drop+recreate+migrate, including organization/membership tables and the role seed. |
| `pnpm --filter @orgistry/db test:integration` | ✅ pass | 7 migration-from-scratch tests incl. org tables, partial unique index, idempotent role seed, one-active-membership. |
| `pnpm --filter @orgistry/api test:integration` | ✅ pass | 19 tests vs live PostgreSQL + Redis: 7 organization (personal-workspace provisioning, atomic DB rollback, team create, membership uniqueness, list/read scoping, removed-membership, slug conflict) + auth/session/readiness. |
| `pnpm --filter @orgistry/web-demo build` | ✅ pass | Vite production build. |
| `pnpm db:generate` | ✅ pass | "No schema changes, nothing to migrate" — the committed migration/snapshot match the schema (no drift). |
| `git diff --check` | ✅ pass | No whitespace/conflict errors. |
| `pnpm lint` | ⚠️ placeholder | Sprint-1 no-op that exits 0; `pnpm typecheck` is the active gate. **Not counted as lint coverage.** |

Environment note: the local host's port 5432 is held by an unrelated project, so
the integration runs used a disposable PostgreSQL on host port 5434 plus a
disposable Redis on 6379 (`TEST_DATABASE_URL`/`DATABASE_URL`/`REDIS_URL`
overridden for the run). The integration suites otherwise skip cleanly when no
database/Redis is reachable.

## 6. Out of Scope (deliberately not implemented)

Permission catalog, role→permission mapping, effective permissions, permission
matrix, permission-first authorization helpers; member listing, member role
change, member removal, Last-Owner protection mutation flows; invitations;
entitlements, quotas, projects, API keys, external API, organization audit logs;
organization archive/suspend endpoints; workspace switcher UI, active-org
persistence in the web demo, organization settings UI; email-verification changes,
password reset, MFA, OAuth, passkeys, billing, workers/queues, PostgreSQL RLS,
production deployment automation, public npm packages.

The schema reserves the columns/indexes (`invited_by_user_id`, `removed_at`,
`removed_by_user_id`, `is_system`, the partial unique index, lifecycle statuses)
that these flows will need, so they can be added without redesign.

## 7. Documentation Index

| Document | Purpose |
| --- | --- |
| [`README.md`](../README.md) | Project overview, what is implemented through Sprint 4, scope boundary, local setup. |
| [`docs/organization-foundation.md`](organization-foundation.md) | **Authoritative Sprint 4 engineering reference** (A–F): tenant model, provisioning, slug/membership strategy, resolver, invariants, integration, limitations. |
| [`docs/auth-foundation.md`](auth-foundation.md) | Sprint 2 reference; annotated where Sprint 4 made registration provision a personal workspace. |
| [`docs/session-lifecycle.md`](session-lifecycle.md) | Sprint 3 secure session lifecycle reference (unchanged). |
| [`docs/api-conventions.md`](api-conventions.md) | Shared HTTP conventions; now includes the organization endpoint table and error codes. |
| [`docs/database-foundation.md`](database-foundation.md) | Schema/migration reference; now records the organization/membership/role tables and the role seed. |
| [`docs/sprint-4-artifact-package.md`](sprint-4-artifact-package.md) | This file — the Sprint 4 completion record and index. |
| [`.env.example`](../.env.example) | Canonical environment variables (no new variables required this sprint). |

## 8. Key Design Decisions

Summarized here; the full rationale and rejected alternatives are in
[`organization-foundation.md`](organization-foundation.md) §B.

- **Transaction boundary.** Registration is one DB transaction across user +
  organization + Owner membership + session + first refresh token. Access-token
  signing and the success security event run **after** commit (pure crypto /
  best-effort audit — neither belongs in the write transaction).
- **Authority boundary.** Authorization is keyed on organization **ID**, never
  slug; the slug is a globally-unique, UI-friendly label only.
- **Slug strategy.** `slugify` + auto-resolved numeric suffixes for team orgs; a
  random-suffixed base for personal workspaces. The `slug` unique index is the
  authoritative guard for the check-then-insert race.
- **Membership uniqueness.** A partial unique index enforces one **active**
  membership per `(user, organization)` while retaining `removed` history.
- **Role baseline.** Identity-only `roles` lookup, seeded idempotently with
  stable IDs — deliberately not an authorization system.
- **Module boundary.** `auth` composes organization provisioning primitives
  (one-way `auth → organization.provisioning`, no cycle); the organization
  service/routes never depend on auth concretely.

## 9. Confidence Assessment

Confidence is **high for the implemented scope**, grounded in commands re-run in
this packaging pass (§5): typecheck across all projects, 168 unit tests, 19 API +
7 DB integration tests against live infrastructure, a clean migration-from-scratch
with the role seed, and the web build. The invariants in §3 are each exercised by
a test — atomic registration rollback and the active-membership partial unique
index are proven at the database level, and read/list non-leakage is proven
through the HTTP layer. No blocking issues remain.

## 10. Remaining Risks

Only real, bounded risks (deferred-scope absence is covered in §6, not here):

- **Uncommitted working tree (process/Git risk, not an implementation blocker).**
  The accumulated Sprint 2–4 work is still uncommitted on `main` (last commit is
  the Sprint 2 foundation). The Sprint 4 files and the Sprint 3 baseline
  (cookies, rate limiting, session lifecycle) share one uncommitted tree;
  migration metadata (`0002_fuzzy_betty_ross.sql`, `meta/0002_snapshot.json`,
  `meta/_journal.json`) is present and internally consistent (`db:generate`
  reports no drift). This is resolved by the commit strategy, not by code.
- **Personal-workspace slug race (theoretical, correctness-safe).** Personal
  slugs use a random-suffixed base resolved inside the registration transaction.
  On an astronomically unlikely random collision, the `slug` unique index would
  reject the insert and registration would surface a generic error rather than a
  mapped one — but **correctness is never compromised** (no duplicate slug, no
  partial account). The team-organization slug paths (explicit and derived
  races) are mapped correctly to `ORGANIZATION_SLUG_TAKEN`.

## 11. Readiness for Next Sprint

Sprint 4 is a stable foundation. **Sprint 5 may build directly on**, without
revisiting these:

- the stable `organizations` schema;
- the stable `memberships` schema, including the lifecycle fields prepared for
  future member management (`invited_by_user_id`, `removed_at`,
  `removed_by_user_id`) and the one-active-membership partial unique index;
- the idempotent role baseline (`roles` + `ROLE_IDS`/`ROLE_KEYS`/`ROLE_SEED`);
- registration-time personal-workspace provisioning and the active Owner
  membership model;
- organization list/read scoping by active membership;
- the `resolveOrganizationContext` resolver (the seam for organization-scoped
  routes);
- the public DTO contracts (organization, membership summary, role summary).

**Sprint 5 should implement roles → permissions, member management
(list/role-change/removal), Last-Owner protection, and access-control helpers
that layer ON TOP of the context resolver** — it should not need to revisit the
Sprint 4 foundations unless review uncovers a defect. Adding permissions requires
no change to the create/list/read contracts already shipped.
