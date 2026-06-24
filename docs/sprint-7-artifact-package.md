# Sprint 7 Artifact Package

Official completion artifact for Orgistry Sprint 7 — **Entitlements, Plans &
Quotas**. This is the authoritative record of what the sprint delivered, how it
was validated, the contracts and invariants it establishes, what was deliberately
left out, and what the next sprint may build on. It summarizes and indexes; the
full engineering reference lives in
[`entitlements-plans-quotas.md`](entitlements-plans-quotas.md).

Sprint 7 extends the Sprint 5/6 permission-first access chain with plan-derived
capabilities, completing:

```
User → Organization → Membership → Role → Permission → Entitlement → Quota → Organization-Scoped Resource
```

It introduces the separation that prevents the classic SaaS authorization bug:

```
Permission:  what the user may do.
Entitlement: what the organization's plan allows.
Quota:       how much of that capability the organization may use.
```

Plans are **fixed internal demo plans**. Stripe, checkout, billing portal,
subscriptions, invoices, payments, usage billing, real subscription status, API
key lifecycle, an external API, an invitation flow, an audit-log read API, an
audit retention deletion job, custom plans/entitlements, feature flags, custom
roles, ABAC, RLS, workers/queues, and any web plan/quota/project UI all remain
explicitly out of scope.

**Status: COMPLETE.** Every required validation command passed against a properly
provisioned environment: typecheck ✅, unit **342** ✅, lint ✅, web build ✅,
`pnpm db:generate` (no drift) ✅, `git diff --check` ✅, `pnpm db:reset:test` ✅,
and the **full** `pnpm test:integration` suite ✅ — db **12** + api **35** = **47**,
including the Redis-dependent `readiness.integration.test.ts` — run with both
PostgreSQL and Redis up. Environmental note (unchanged from Sprints 5–6): the dev
host's port 5432 was held by an unrelated Postgres with different credentials, so
the integration suites and `db:reset:test` were run against a disposable
project-matching PostgreSQL (+ Redis) on alternate ports (5544 / 6399); this is a
port/credential choice, not a Sprint 7 limitation. No remaining failures.

---

## 1. Implementation Summary

Sprint 7 delivers the *capability model* — plans, entitlements, quotas, and their
enforcement — on top of the Sprint 5 permission-first RBAC layer, with no billing.
The three concepts are kept strictly separate, enforced physically by where the
code lives:

```
Permission:  what the user may do.                    (RBAC; user-level; by permission key)
Entitlement: what the organization's plan allows.     (boolean feature; organization-level)
Quota:       how much of that capability the           (numeric ceiling; organization-level)
             organization may use.
```

**Plan catalog.** `packages/contracts/src/plans.ts` is the single source of truth:
`PLAN_KEYS` (`free`/`pro`/`business`), `DEFAULT_PLAN_KEY` (`free`),
`ENTITLEMENT_KEYS` (the six fixed keys), `entitlementValuesSchema`, the fixed
`PLAN_CATALOG` with deterministic demo values, `entitlementsForPlan`, and all plan
DTOs/error-detail schemas. The catalog is code-defined and typed; there is no
mutable, per-organization, or runtime plan definition.

| Entitlement | Free | Pro | Business | Category |
| --- | --- | --- | --- | --- |
| `max_members` | 3 | 10 | 50 | numeric quota |
| `max_projects` | 3 | 20 | 100 | numeric quota |
| `max_api_keys` | 0 | 5 | 25 | numeric quota |
| `api_keys_access` | `false` | `true` | `true` | boolean feature |
| `audit_log_access` | `false` | `true` | `true` | boolean feature |
| `audit_retention_days` | 0 | 30 | 90 | modeled policy (not enforced by a job) |

**Organization plan state.** New `plans` and `organization_plans` tables
(`packages/db/src/schema/plans.ts`); `PLAN_SEED` is derived from `PLAN_CATALOG`.
Exactly one plan-state row per organization (`uq_organization_plans_organization`),
carrying `plan_key`, `assigned_at` (when the current plan took effect — advances
on a demo change), `updated_at` (last row write), and `changed_by_user_id` (the
actor who last set the plan). Plan state belongs to the organization, not a user,
and is independent of the membership role. Migration `0005_flimsy_patriot.sql`
creates both tables, seeds the catalog idempotently (`ON CONFLICT (key) DO
NOTHING`), and deterministically backfills existing organizations to Free
(`NOT EXISTS` guard, derived id). The shared provisioning seam
`insertOrganizationWithOwnerMembership` inserts default (Free) plan state
atomically, so every new **personal** (registration) and **team** organization has
plan state from creation; seed/test/backfilled organizations get deterministic
Free state.

**Entitlement resolver.** `EntitlementService`
(`apps/api/src/modules/entitlements/entitlement.service.ts`) is organization-level
and role-agnostic: it takes an organization id, reads plan state, and resolves the
plan key to entitlement values from the catalog. It depends on no role,
permission, or client input. If plan state is missing it **fails safe** —
`PLAN_STATE_MISSING` — rather than assuming a plan.

**Quota helpers.** `quota.ts` holds the pure policy primitives:
`evaluateCountQuota(current, limit)` → `{ status, limit, current }` (`current >=
limit` is `exceeded`), `requireQuota(key, evaluation)` → throws `QUOTA_EXCEEDED`
with `{ quota, limit, current }`, and `requireEntitlement(values, key)` → throws
`ENTITLEMENT_REQUIRED` for an ungranted boolean feature. These are decoupled from
persistence and RBAC; the service composes them with repository counts. Quota
policy is service-layer only — repositories count and write, never decide.

**Plan APIs.** Three organization-scoped, Bearer-authenticated endpoints
(`plan.routes.ts` → `plan.service.ts`, which layers `requireMembership` →
`requirePermission` → resolve → DTO):

```
GET   /v1/organizations/:organizationId/plan          (plan.read)
GET   /v1/organizations/:organizationId/entitlements   (plan.read)
PATCH /v1/organizations/:organizationId/plan/demo      (plan.change_demo)
```

**Demo plan switching.** `PATCH …/plan/demo` requires `plan.change_demo`,
validates the target against the fixed plan-key enum, and updates plan state and
records `plan.changed_demo` in **one transaction** (`plan.repo.ts`, with a
`FOR UPDATE` row lock), returning the new plan and resolved entitlements. It calls
no billing provider, creates no subscription, and processes no payment.

**Project quota enforcement.** `project.service.ts` `createProject` now runs, in
order: `requireMembership → requirePermission(projects.create) →
requireQuota(max_projects) → create project → record project.created`. The quota
check runs after the permission check and before the write, so a quota failure
creates no project and records no `project.created`. This is the primary
end-to-end proof of the sprint.

**Member quota boundary.** `EntitlementService.requireMemberAdditionQuota`
enforces `max_members` against active memberships (removed memberships do not
count). It is a reusable boundary tested via service/DB paths; no invitation or
member-add product surface was added, and registration/team-creation still create
the founding Owner membership unimpeded.

**API key / audit readiness.** `api_keys_access`, `max_api_keys`,
`audit_log_access`, and `audit_retention_days` are modeled and resolvable today
(`resolveApiKeyEntitlements` / `resolveAuditEntitlements`) but consumed by nothing
yet — no API key lifecycle, no audit read API, no retention deletion job.

**Action events.** Demo plan changes record `plan.changed_demo` on the existing
internal `security_events` seam, with sanitized metadata carrying `previousPlanKey`
and `newPlanKey` (plus actor membership). No user-facing audit read surface is
created.

**Contracts & error behavior.** New error codes `QUOTA_EXCEEDED` (409,
`{quota,limit,current}`), `ENTITLEMENT_REQUIRED` (403, `{entitlement}`), and
`PLAN_STATE_MISSING` (500, fail-safe); unknown plan key → `VALIDATION_ERROR` (400).
DTO guarantees: no persistence row returned; no `plan_*` id or raw quota columns on
the Plan DTO; no billing/provider field anywhere; no client-controlled entitlement
value accepted (a smuggled `entitlements` field is dropped by the schema). Every
response uses the standard success/error envelope carrying the request id.

**Documentation.** `docs/entitlements-plans-quotas.md` (full A–F reference),
`docs/projects.md` (create-flow note now reflects the quota guard), `README.md`
(intro, endpoint surface, scope), and this artifact — see §2.

**Validation.**

| Command | Result |
| --- | --- |
| `pnpm typecheck` | ✅ all 7 packages pass |
| `pnpm test` (unit) | ✅ **342 passed** (41 files) |
| `pnpm lint` | ✅ placeholder gate (typecheck is the active gate) |
| `pnpm --filter @orgistry/web-demo build` | ✅ vite build succeeds |
| `pnpm db:generate` | ✅ "No schema changes" — no drift |
| `git diff --check` | ✅ clean |
| `pnpm db:reset:test` | ✅ "Test database reset and migrated." |
| `pnpm test:integration` | ✅ **47 passed** — db **12** + api **35** (incl. `readiness.integration.test.ts`) |

There is no root `pnpm build` script (verified in `package.json`); `pnpm validate`
(typecheck + lint + test) is the gate, and the only buildable app is the web demo
(unaffected by this sprint). New test coverage: `plans.test.ts` (contracts, 15),
`quota.test.ts` (8), `entitlement.service.test.ts` (17, incl. `assignedAt`
advancing on a demo change), `schema/plans.test.ts` (DB-free drift guard, 3),
`plan.routes.test.ts` (16), `project-quota.routes.test.ts` (7, incl. the full
`QUOTA_EXCEEDED` envelope + request-id assertion), plus DB integration additions
(`migrate.integration.test.ts`, `entitlement.integration.test.ts`). All prior
auth/session/organization/RBAC/Projects tests pass unchanged.

---

## 2. Documentation Index

| Document | Role — what future engineers should read it for |
| --- | --- |
| [`docs/sprint-7-artifact-package.md`](sprint-7-artifact-package.md) | **This file.** The official Sprint 7 completion record: what shipped, validation evidence, confidence assessment, remaining risks, and what the next sprint can rely on. Start here for the closure summary and the scope boundary. |
| [`docs/entitlements-plans-quotas.md`](entitlements-plans-quotas.md) | **The detailed technical reference (A–F).** Read it to work *in* the entitlements layer: the plan catalog and exact values, the entitlement resolver, the quota/entitlement primitives, the plan API, the enforcement order, the package-boundary decision, the `assignedAt`/`updatedAt`/`changedByUserId` semantics, plan-change atomicity, contracts/invariants, integration notes (incl. how a future Stripe integration maps in), known limitations, and the recipe for adding an entitlement/quota or enforcing one on a new write. |
| [`docs/projects.md`](projects.md) | **The Projects reference.** Read it for the tenant-scoped resource pattern; its create-flow section documents how Sprint 7 fills the quota seam (`requireQuota(max_projects)` after `requirePermission(projects.create)`), making Projects the worked example of permission-then-quota enforcement. |
| [`README.md`](../README.md) | **The project overview.** Read it for the one-paragraph framing of the access chain, the Sprint 7 endpoint surface, the "what is explicitly NOT implemented" scope statement, and the documentation index linking every sprint artifact. |

---

## 3. Confidence Assessment

**What was validated.** The full local gate (typecheck, 342 unit tests, lint, web
build, no-drift `db:generate`, clean `git diff --check`) and the full integration
suite (47 tests: migration-from-scratch + plan seed + backfill, DB provisioning,
transactional demo change + event, `max_projects` against real row counts, and the
Redis-dependent readiness probe) all pass. Behavioral separation is proven, not
asserted: dedicated tests show a Viewer is blocked by *permission* even when quota
has room, an authorized Owner is blocked by *quota* at the ceiling, and a generous
plan does not grant a Viewer *permission* — the three failure modes are distinct
codes (`FORBIDDEN`, `QUOTA_EXCEEDED`, `FORBIDDEN`) at distinct stages.

**Why the architecture is stable.** The layer reuses the exact shape proven in
Sprint 5/6: a fixed catalog in `contracts`, a derived DB seed, an organization-
scoped service over a narrow repository interface, thin routes, and the internal
event seam. Quota policy is pure and service-layer; repositories only count and
write; routes carry no policy. Enforcement order is explicit and tested. There is
one plan-state row per organization, provisioned atomically, with a fail-safe
resolver — so the data model cannot silently produce an org without entitlements.

**Why the package-boundary decision is acceptable.** The catalog lives in
`@orgistry/contracts`, mirroring `PERMISSION_CATALOG`/`ROLE_PERMISSIONS` precisely.
The `db → contracts` dependency already exists; `contracts` depends only on `zod`;
no cycle, no new package. The values are non-secret (the entitlements endpoint
returns them), the catalog is a frozen `const` (not client-controllable), and
`PLAN_KEYS` is single-sourced and re-exported by `db`. A DB-free drift guard test
proves the seed and catalog cannot diverge. The decision is documented in
[`entitlements-plans-quotas.md` §B](entitlements-plans-quotas.md#b-architectural-notes).

**Why permission/entitlement/quota separation is proven.** They are separated
*physically* — `requirePermission` lives in the RBAC access-control module and
checks a permission key; `requireQuota`/`requireEntitlement` live in the
entitlements module and never read a role — and *behaviorally*, by the
cross-failure tests above. Permission never implies plan access; entitlement/quota
never implies user authorization.

**Why future API Keys can build on this.** `api_keys_access` and `max_api_keys`
are already modeled and resolvable via `resolveApiKeyEntitlements`. A future API
key module enforces `requireEntitlement(api_keys_access)` then
`requireQuota(max_api_keys)` with the existing primitives — no plan-model change.

**Why future Invitations can build on this.** The `max_members` boundary
(`requireMemberAdditionQuota`) already exists and counts active memberships
correctly. A future invitation/member-add flow calls it after the permission
check, reusing the helper unchanged.

**Why future Stripe integration can map in without redesign.** `organization_plans`
is billing-agnostic and forward-compatible: a billing integration maps **external**
subscription state onto the internal `plan_key` (and may use `changed_by_user_id` /
the action-event seam for provenance). Nothing in the capability model assumes
billing exists, so adding it later requires no schema or resolver change.

**Production readiness — stated honestly.** The implemented surface is validated
and internally consistent, but the system is **not production-certified**. It is a
demo-plan capability foundation: there is no billing, no real subscription state,
and the v1 quota check has an accepted race window (see §4). This is a solid,
reviewed base to build on — not a shippable billing product.

---

## 4. Remaining Risks

These are known, deliberate limitations — not accidental omissions:

- **Quota race window.** The quota check reads the resource count immediately
  before the write rather than holding a count lock across the whole operation.
  Two highly-concurrent creates against the exact same ceiling could both pass.
  Accepted for v1 scale; a future hardening can serialize per-organization (a
  Postgres advisory lock or a counted constraint).
- **Readiness-only entitlements.** `api_keys_access`, `max_api_keys`,
  `audit_log_access`, and `audit_retention_days` are modeled and resolvable but
  **inert** until their consuming modules exist.
- **`audit_retention_days` is modeled only.** It is returned as a policy value;
  there is **no retention deletion job** and nothing deletes data on a schedule.
- **No billing integration.** No Stripe, checkout, portal, subscription, invoice,
  payment, tax, reconciliation, usage billing, or real subscription status. Plans
  are internal demo plans switched solely via the demo endpoint.
- **No API key lifecycle.** No create/list/revoke surface and no external API.
- **No invitation flow.** `max_members` is enforced and tested but is not wired to
  any member-add product surface yet.
- **No audit read API.** Plan/member/project actions are recorded on the internal
  event seam only; there is no user-facing audit read endpoint or UI.

The complete list is in
[`entitlements-plans-quotas.md` §E](entitlements-plans-quotas.md#e-known-limitations).

---

## 5. Readiness for Next Sprint

**The project is ready for the next sprint.** The entitlements/plans/quotas
foundation is complete, validated, and stable. The next sprint can rely on the
following without revisiting them:

- the fixed **plan catalog** (Free/Pro/Business) and `DEFAULT_PLAN_KEY`;
- **organization plan state** (one row per org, provisioned atomically for personal
  + team, backfilled deterministically);
- the **entitlement resolver** (organization-level, role-agnostic, fail-safe);
- the **quota helper pattern** (`evaluateCountQuota` / `requireQuota` /
  `requireEntitlement`, pure and service-layer);
- **`max_projects`** enforcement on Project create (the worked enforcement order);
- the **`max_members`** reusable boundary;
- **`api_keys_access`** and **`max_api_keys`** (resolvable, ready to enforce);
- **`audit_log_access`** and **`audit_retention_days`** (resolvable, modeled);
- the **plan and entitlement contracts** (DTOs, error codes, error details);
- **demo plan change** behavior (transactional update + `plan.changed_demo` event);
- the proven **permission vs entitlement vs quota** separation.

**Recommended next sprint:**

```
API Keys and External Read-Only Projects API
```

It is the strongest follow-on: `api_keys_access` and `max_api_keys` are already
modeled and resolvable, the quota/entitlement primitives are ready to enforce, and
it turns the readiness values into a real, end-to-end capability (key issuance +
an external authenticated read surface) without touching the plan model.

**Valid alternative:**

```
Invitations Lifecycle
```

The `max_members` boundary is already in place and reusable, so an invitation/
member-add flow would compose it directly. Either is a clean next step; neither is
implemented here.
