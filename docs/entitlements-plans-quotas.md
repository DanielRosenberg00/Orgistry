# Entitlements, Plans & Quotas (Sprint 7)

Orgistry's plan-and-entitlement foundation. Sprint 7 extends the validated access
chain from permission-first RBAC to plan-derived capabilities, completing:

```
User → Organization → Membership → Role → Permission → Entitlement → Quota → Organization-Scoped Resource
```

The three concepts this layer keeps **strictly separate**:

```
Permission:  what the USER may do.                       (RBAC; per user, by permission key)
Entitlement: what the ORGANIZATION'S PLAN allows.        (boolean feature access; per organization)
Quota:       how much of a capability the ORGANIZATION may use.  (a numeric ceiling; per organization)
```

Plans are **fixed, code-defined, internal demo plans**. There is **no** Stripe,
checkout, billing portal, subscription, invoice, payment, usage-billing engine,
or real subscription status anywhere in this sprint. The demo plan-change
endpoint switches internal plan state and nothing else. See
[§E](#e-known-limitations).

---

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Plan keys, entitlement keys, plan catalog, entitlement values, DTOs, error details | `packages/contracts/src/plans.ts` |
| `QUOTA_EXCEEDED`, `ENTITLEMENT_REQUIRED`, `PLAN_STATE_MISSING` error codes | `packages/contracts/src/error-codes.ts` |
| `plans` + `organization_plans` tables, `PLAN_SEED`, stable ids | `packages/db/src/schema/plans.ts` |
| Generated migration + plan catalog seed + org-plan backfill | `packages/db/migrations/0005_flimsy_patriot.sql` |
| Default plan state at org provisioning (personal + team) | `apps/api/src/modules/organization/organization.provisioning.ts` |
| Entitlement repository boundary + internal types | `apps/api/src/modules/entitlements/entitlement.types.ts` |
| Entitlement/quota/plan service (org-level, role-agnostic) | `apps/api/src/modules/entitlements/entitlement.service.ts` |
| Pure quota/entitlement policy primitives | `apps/api/src/modules/entitlements/quota.ts` |
| Plan HTTP service (membership → permission → resolve → DTO) | `apps/api/src/modules/entitlements/plan.service.ts` |
| DB entitlement repository (plan state, counts, plan change + event) | `apps/api/src/modules/entitlements/plan.repo.ts` |
| Plan routes (read plan / read entitlements / change demo plan) | `apps/api/src/modules/entitlements/plan.routes.ts` |
| `plan.changed_demo` action-event type | `apps/api/src/modules/entitlements/plan.events.ts` |
| Entitlement/quota error factories | `apps/api/src/modules/entitlements/entitlement.errors.ts` |
| Project-create `max_projects` quota enforcement | `apps/api/src/modules/projects/project.service.ts` |
| In-memory entitlement repo + test app builder | `apps/api/src/modules/entitlements/testing/*` |
| Service wiring | `apps/api/src/server.ts`, `apps/api/src/app.ts` |

### How it works

**Plan catalog (the source of truth).** `PLAN_CATALOG` in
`@orgistry/contracts` is the single, fixed definition of the three v1 demo plans
and the entitlement values each grants. Everything else derives from it:

- the database `plans` rows are seeded from `PLAN_SEED`, which is built from
  `PLAN_CATALOG` with stable ids (`planRowId`, e.g. `plan_pro`);
- the entitlement resolver maps a plan key to `PLAN_CATALOG[key].entitlements`;
- the plan/entitlements endpoints return values resolved the same way.

Because the database seed, the typed resolver, and the API surface all originate
in one constant, they cannot drift.

**Plan state.** `organization_plans` holds exactly one row per organization
(`uq_organization_plans_organization`): the current `plan_key`, an `assigned_at`
timestamp, and `changed_by_user_id` (who last set it). Plan state belongs to the
**organization**, not to any user, and is independent of the membership role.

**Provisioning.** `insertOrganizationWithOwnerMembership` — the single seam used
by **both** registration (personal workspace) and team-organization creation —
inserts the organization, its Owner membership, and its default (`free`) plan
state in one executor (atomic inside the registration/team transaction). Every
new organization therefore has plan state from the moment it exists. Existing
organizations are deterministically backfilled to Free by the migration.

**Entitlement resolution (org-level, role-agnostic).** `EntitlementService`
(`entitlement.service.ts`) takes an organization id, reads its plan state, and
resolves the plan key to entitlement values. It depends on **no** role,
permission, or client state — entitlements are a property of the organization's
plan. If plan state is missing it **fails safe**: it throws `PLAN_STATE_MISSING`
rather than assuming a plan. Future API key and audit modules consume
`resolveApiKeyEntitlements` / `resolveAuditEntitlements` through this same service
without touching the plan model.

**Quota policy (pure).** `quota.ts` holds the policy primitives:

- `evaluateCountQuota(current, limit)` → `{ status: 'allowed' | 'exceeded', limit, current }`
  (`current >= limit` is `exceeded` — the next unit would not fit);
- `requireQuota(key, evaluation)` throws `QUOTA_EXCEEDED` (with the quota key,
  limit, and current usage in `details`) when exceeded;
- `requireEntitlement(values, key)` throws `ENTITLEMENT_REQUIRED` when a boolean
  feature is not granted.

These are pure functions: no IO, no RBAC. The service composes them with the
counts it reads from the repository.

**Enforcement order.** For an organization-scoped resource write the pipeline is:

```
requireMembership → requirePermission → [requireEntitlement] → [requireQuota] → tenant-scoped write
```

Project create is the worked example:

```
requireMembership
  → requirePermission(projects.create)
    → requireQuota(max_projects)        // EntitlementService.requireProjectCreationQuota
      → create project
        → record project.created
```

The quota check runs **after** the permission check and **before** the write, so
a quota failure creates no project and records no `project.created` event.

**Demo plan change.** `PATCH …/plan/demo` requires `plan.change_demo`, validates
the target key against the fixed enum, updates plan state inside a transaction
that also records `plan.changed_demo`, and returns the new plan and resolved
entitlements. It calls no billing provider.

### HTTP surface

| Method & path | Permission | Returns |
| --- | --- | --- |
| `GET /v1/organizations/:organizationId/plan` | `plan.read` | current plan + assignment timestamps |
| `GET /v1/organizations/:organizationId/entitlements` | `plan.read` | resolved entitlement/quota values |
| `PATCH /v1/organizations/:organizationId/plan/demo` | `plan.change_demo` | updated plan + entitlements |

All three require Bearer authentication and active membership. The
`:organizationId` path segment is the tenant authority boundary — never the
request body. A non-member receives the uniform `ORGANIZATION_NOT_FOUND` 404, so
existence cannot be probed.

### How to extend it safely

- **Add an entitlement/quota key.** Add it to `ENTITLEMENT_KEYS` and
  `entitlementValuesSchema`, give every plan a value in `PLAN_CATALOG`, add the
  column to the `plans`/`PLAN_SEED` schema, regenerate the migration, and append
  the new column to the seed `INSERT`. The resolver and DTOs pick it up
  automatically.
- **Enforce a new quota on a write.** Add a `requireXxxQuota` method to
  `EntitlementService` (resolve entitlements → count via the repository →
  `requireQuota`) and call it after the permission check in that resource's
  service. Never put the count→limit comparison in a repository.
- **Add a plan.** Extend `PLAN_KEYS`/`planKeySchema` and `PLAN_CATALOG`, add the
  seed row. Reconsider the demo default only with a documented reason.
- **Consume an entitlement from a future module (API keys, audit).** Call
  `EntitlementService.resolveApiKeyEntitlements` / `resolveAuditEntitlements` —
  do not re-read plan state directly.

---

## B. Architectural Notes

**Package boundary: why the fixed plan catalog lives in `@orgistry/contracts`.**
The catalog (`PLAN_KEYS`, `DEFAULT_PLAN_KEY`, `ENTITLEMENT_KEYS`, `PLAN_CATALOG`,
the entitlement values) and the plan DTO schemas are colocated in
`packages/contracts`. This is a deliberate decision, consistent with the existing
monorepo conventions:

- It **mirrors the Sprint 5 RBAC precedent exactly.** `PERMISSION_CATALOG` and
  `ROLE_PERMISSIONS` — also fixed authorization policy — already live in
  `packages/contracts/src/access.ts`, and `packages/db` already derives its
  permission/role-mapping seed from them. The plan catalog follows the same shape:
  one constant, the DB seed (`PLAN_SEED`) derived from it.
- **The dependency direction stays clean.** `packages/db` already depends on
  `packages/contracts` (`workspace:*`); `packages/contracts` depends only on
  `zod`. There is no cycle and no new package.
- **The values are not secret.** Entitlement values are returned verbatim by the
  `…/entitlements` endpoint, so colocating them with the public DTOs exposes
  nothing that the API does not already publish.
- **It is the single source of truth, so it cannot drift.** `PLAN_KEYS` is defined
  once and re-exported by `@orgistry/db` (`schema/plans.ts`); `PLAN_SEED` is built
  from `PLAN_CATALOG`. A pure unit test (`packages/db/src/schema/plans.test.ts`)
  proves the seed matches the catalog, and the migration integration test proves
  the migration SQL matches the seed.

This is *not* client-controlled authority: the catalog is a frozen `const`,
clients cannot mutate it, and the demo-change request accepts only a `planKey`
enum (any smuggled `entitlements` field is dropped by the schema — there is a test
for that). Moving the catalog into `packages/db` or a new package would diverge
from the established RBAC pattern, complicate the seed's source of truth, and buy
nothing — so it stays in `contracts`.

**Why plans are internal demo plans, and why this is not billing.** Sprint 7
delivers the *capability model* — plans, entitlements, quotas, and enforcement —
without coupling it to any payment system. The plan catalog is a code constant
and the only way to change an organization's plan is the explicit demo endpoint.
This lets the entire access chain be built, tested, and reviewed in isolation. A
real billing integration is a later concern that maps **external** subscription
state onto the **internal** `plan_key`; nothing in this layer assumes it exists.
Modeling billing now would have pulled in webhooks, reconciliation, and provider
state that the capability model does not need and the sprint explicitly forbids.

**Why entitlements are not generic feature flags.** A feature-flag system implies
arbitrary, independently-toggled, often per-environment or per-cohort switches.
Entitlements here are the opposite: a **fixed, plan-derived** capability set with
no per-organization overrides and no runtime toggling. An organization's
entitlements are a pure function of its plan key. This keeps the model small,
auditable, and impossible to drift — and keeps "what a plan includes" a reviewed
change to one constant, not a runtime configuration surface.

**Why permission stays user-level and entitlement/quota stay organization-level.**
Conflating them is the classic SaaS authorization bug. A user who *may* create a
project (permission) must still be blocked when the organization's plan is *out
of room* (quota); an organization whose plan *includes* a feature must not
thereby grant a Viewer the *permission* to use it. Keeping the two axes
orthogonal — RBAC answers "who", plans answer "how much/what" — means each can be
reasoned about and changed independently. The code enforces the separation
physically: `requirePermission` lives in the RBAC access-control module and
checks a permission key; `requireQuota`/`requireEntitlement` live in the
entitlements module and never read a role.

**Why quota policy is service-layer, never in repositories.** Repositories may
count rows and write rows — both pure data operations. The *decision* (compare a
count to a plan limit, choose allowed/exceeded, map to `QUOTA_EXCEEDED`) is
policy and lives in `quota.ts` + `EntitlementService`. Embedding the limit in a
generic repository would scatter policy, couple persistence to the plan catalog,
and make the rule untestable in isolation.

**Rejected alternatives.**
- *Default an org with no plan state to Free in the resolver.* Rejected: it would
  mask a data-integrity failure. Provisioning guarantees plan state; a missing
  row is a bug, so the resolver fails safe with `PLAN_STATE_MISSING` instead.
- *Store resolved entitlement values on the organization row.* Rejected: values
  would drift from the catalog the moment the catalog changed. Resolve from the
  plan key on read instead.
- *Enforce quota inside the project repository's transaction body.* Rejected:
  that puts plan policy in persistence. The service checks quota immediately
  before the write; for v1 scale this is safe (see [§E](#e-known-limitations)).
- *A separate "billing" table now.* Rejected as out of scope. `organization_plans`
  is billing-agnostic and forward-compatible without any billing fields.

---

## C. Contracts & Invariants

### Stable interfaces

**Plan keys** (`PLAN_KEYS`, `planKeySchema`): `free`, `pro`, `business`. Stable
machine strings; clients may branch on them. Default for every new organization
is `free` (`DEFAULT_PLAN_KEY`).

**Entitlement / quota keys** (`ENTITLEMENT_KEYS`):

| Key | Category | Meaning |
| --- | --- | --- |
| `max_members` | numeric quota | inclusive ceiling on active memberships |
| `max_projects` | numeric quota | inclusive ceiling on active projects |
| `max_api_keys` | numeric quota | inclusive ceiling on API keys (future module) |
| `api_keys_access` | boolean feature | plan grants API key access |
| `audit_log_access` | boolean feature | plan grants audit log access |
| `audit_retention_days` | modeled policy | retention window; **returned, not enforced** by a deletion job in v1 |

**Fixed v1 plan catalog values** (deterministic, documented demo progression):

| Entitlement | Free | Pro | Business |
| --- | --- | --- | --- |
| `max_members` | 3 | 10 | 50 |
| `max_projects` | 3 | 20 | 100 |
| `api_keys_access` | `false` | `true` | `true` |
| `max_api_keys` | 0 | 5 | 25 |
| `audit_log_access` | `false` | `true` | `true` |
| `audit_retention_days` | 0 | 30 | 90 |

Free is the least-capable plan on every axis; premium features unlock at Pro and
above; numeric quotas increase strictly Free < Pro < Business. These values are
part of the migration/seed contract — changing them is a reviewed change.

### DTO guarantees

- The public **Plan** DTO is `{ key, name, description }` only — never the
  internal `plan_*` row id and never the raw quota columns.
- The **organization plan** response is `{ organizationId, plan, assignedAt,
  updatedAt }` — plan STATE, with **no** provider, subscription status, period,
  or price field.
- The **entitlements** response is `{ organizationId, planKey, entitlements }`
  where `entitlements` carries all six keys, resolved server-side.
- No persistence row is ever returned directly; no client-controlled entitlement
  value is ever accepted (a smuggled `entitlements` field on the demo-change
  request is dropped by the schema).
- Every error response is the standard error envelope carrying the request id.

### Plan-state timestamps & provenance (exact meaning)

`organization_plans` carries three time/actor fields with precise, fixed
semantics:

- **`assignedAt`** — when the **current** plan took effect. Set at provisioning
  (org creation) and **moved forward** on every demo plan change. It is *not* a
  row-creation timestamp; it answers "since when has this organization been on
  this plan?".
- **`updatedAt`** — when the plan-state **row** was last written. Advances with
  every mutation, including a demo plan change (so on a change `assignedAt` and
  `updatedAt` advance together).
- **`changedByUserId`** — the actor who last set the plan: the founder at
  provisioning, or the demo-change actor afterward. Nullable so a
  system/backfilled assignment is representable (the migration backfill leaves it
  as the org's creator).

A demo plan change updates `plan_key`, `assigned_at`, `updated_at`, and
`changed_by_user_id` consistently in one write. Tests assert `assignedAt` advances
on a demo change.

### Atomicity of the demo plan change

The plan-state update and the `plan.changed_demo` action event are written in a
**single database transaction** (`db.transaction` in `plan.repo.ts`, which also
locks the plan-state row `FOR UPDATE`). Either both commit or neither does — the
event can never record a transition that did not persist, and vice versa. The
in-memory test repository mirrors this with a synchronous read-classify-write (no
`await` between the mutation and the event push), matching the transactional
guarantee under Node's single-threaded loop. Event metadata carries
`previousPlanKey` and `newPlanKey` (plus the actor membership) and is passed
through `sanitizeSecurityMetadata`; no secrets or raw request bodies are recorded,
and no user-facing audit read surface is created.

### Readiness-only entitlements

`api_keys_access`, `max_api_keys`, `audit_log_access`, and `audit_retention_days`
are **modeled and resolvable today but consumed by nothing yet**. They are
returned by the entitlements endpoint and resolvable via
`EntitlementService.resolveApiKeyEntitlements` / `resolveAuditEntitlements`, so a
future API key or audit module can enforce them without any plan-model change. In
Sprint 7 they have no behavioral effect: there is no API key lifecycle, no audit
read API, and — for `audit_retention_days` — **no retention deletion job**; it is
a returned policy value only.

### Error behavior

| Code | Status | When |
| --- | --- | --- |
| `QUOTA_EXCEEDED` | 409 | a numeric quota is reached; `details = { quota, limit, current }` |
| `ENTITLEMENT_REQUIRED` | 403 | a boolean feature is not granted; `details = { entitlement }` |
| `PLAN_STATE_MISSING` | 500 | an organization has no plan state (data-integrity failure; fail-safe) |
| `VALIDATION_ERROR` | 400 | an unknown target plan key (rejected by the fixed enum) |
| `FORBIDDEN` | 403 | the caller lacks the required permission (RBAC, distinct from the above) |
| `ORGANIZATION_NOT_FOUND` | 404 | unauthenticated-equivalent: not a member (no existence probe) |

### Behavioral guarantees (must not change)

- Permission, entitlement, and quota are checked **separately and in that order**.
  A permission check never implies plan access; an entitlement/quota check never
  implies user authorization.
- A quota failure on project create writes **no** project and records **no**
  `project.created` event.
- Every active organization has exactly one plan-state row; new personal and team
  organizations receive the default plan; existing organizations are backfilled.
- The plan catalog is fixed in v1: there is **no** public API to create, update,
  or delete plan definitions.
- The demo plan change records `plan.changed_demo` and triggers no billing.

---

## D. Integration Notes

**Organizations & memberships.** Plan state is provisioned by the shared
`insertOrganizationWithOwnerMembership` seam, so personal (registration) and team
organizations both receive default plan state atomically. The `max_members`
quota counts active memberships; removed memberships never count.

**RBAC & access-control helpers.** The plan routes layer `requireMembership` +
`requirePermission` (using the existing `plan.read` / `plan.change_demo` keys,
already in the Sprint 5 catalog) on top of the organization-level entitlement
resolution. `requireEntitlement` / `requireQuota` are deliberately separate
helpers from `requireMembership` / `requirePermission`.

**Projects.** Project create enforces `max_projects` after the permission check.
This is the primary end-to-end proof of the sprint. No other project behavior
changed.

**Future API Keys.** `api_keys_access` and `max_api_keys` are modeled and
resolvable today via `EntitlementService.resolveApiKeyEntitlements`. A future API
key module enforces `requireEntitlement(api_keys_access)` then
`requireQuota(max_api_keys)` using the existing helpers — no plan-model change.

**Future Audit Logs.** `audit_log_access` and `audit_retention_days` are modeled
and resolvable via `resolveAuditEntitlements`. Plan changes already write to the
internal `security_events` seam; a future permission-gated (`audit_events.read`)
audit read API would read from it. No audit read API exists in this sprint.

**Future Invitations.** The `max_members` quota boundary
(`EntitlementService.requireMemberAdditionQuota`) is reusable as-is: a future
invitation / member-add workflow calls it after the permission check. Sprint 7
adds no invitation flow.

**Future Stripe / billing.** A billing integration would map external
subscription state onto the internal `organization_plans.plan_key` (and could use
`changed_by_user_id` / the action-event seam for provenance). The
`organization_plans` schema is billing-agnostic and needs no redesign to support
that later. **No billing integration exists in this sprint.**

---

## E. Known Limitations

- **Demo-only plan switching.** The only way to change a plan is `PATCH
  …/plan/demo`, gated by `plan.change_demo`. There is no automated or external
  plan assignment.
- **No Stripe / billing.** No checkout, portal, subscription, invoice, payment,
  tax, reconciliation, usage-billing engine, or real subscription status.
- **No API key lifecycle.** `api_keys_access` / `max_api_keys` are modeled and
  resolvable, but there is no API key create/list/revoke surface and no external
  API.
- **No audit log read API.** `audit_log_access` / `audit_retention_days` are
  modeled; `plan.changed_demo` is written to the internal event seam, but no
  user-facing audit read API exists.
- **No audit retention deletion job.** `audit_retention_days` is returned as a
  modeled policy value only; nothing deletes data on a schedule.
- **No invitation flow.** The `max_members` quota helper exists and is tested via
  service/DB paths, but there is no member-add/invitation endpoint to wire it to
  yet.
- **No web plan/quota UI.** Enforcement is entirely backend; there is no web demo
  plan page, quota UI, or project UI change.
- **Quota race window (accepted for v1 scale).** The quota check reads the count
  immediately before the write rather than holding a count lock across the whole
  operation. Two highly-concurrent creates against the exact same ceiling could
  both pass the check. This is accepted for v1 scale; a future hardening could
  serialize via a per-organization advisory lock or a counted constraint. No
  background quota reconciliation job exists.

---

## F. Sprint Changelog

See [`sprint-7-artifact-package.md`](sprint-7-artifact-package.md) for the full
iteration summary, validation results, and follow-up risks.
