# Sprint 10 Artifact Package

**Sprint:** 10 — Audit Log Read API
**Status:** Implementation complete; Definition of Done met. Unit and DB-backed
integration suites pass (the latter validated on clean infra — see §4). Ready for
review and handoff to the next sprint.
**Scope:** A safe, organization-scoped, **read-only** API over the audit/action
events that producers from Sprints 5–9 already write to the internal
`security_events` seam — public DTOs + a public/persisted mapping layer, a
tenant-scoped read repository, a policy-composing service, one route, the
`audit_log_access` entitlement gate, defensive metadata sanitization, cursor
pagination, validated filters, and display-only retention metadata.

This file is the authoritative Sprint 10 artifact and handoff record. The
developer / architecture / contract / integration reference lives in
[`docs/audit-log.md`](./audit-log.md).

---

## 1. Implementation Summary

### What was implemented

A single read surface:

```
GET /v1/organizations/:organizationId/audit-events
```

It exposes the **organization action events** already recorded on the
`security_events` table — behind a permission gate (`audit_events.read`) and an
**independent** entitlement gate (`audit_log_access`) — with cursor pagination,
validated filters, read-time metadata sanitization, honest actor/target
summaries, and display-only retention metadata. The route organization id is the
authoritative tenant boundary; no organization context is read from the request
body.

### How the read pipeline works

The service composes one fixed pipeline:

```
authenticate (Bearer)                         ← route (auth boundary)
  → requireMembership(org)                     → OrganizationActor
    → requirePermission(audit_events.read)     → 403 FORBIDDEN if missing
      → requireEntitlement(audit_log_access)   → 403 ENTITLEMENT_REQUIRED if missing
        → resolve audit_retention_days         → response meta (display-only)
          → repository.listAuditEvents(org, …)  → tenant-scoped keyset query
            → sanitize metadata + shape DTOs    → mapper (never a raw row)
              → cursor-paginated success envelope
```

The **repository** is a pure query boundary: it requires an org id, restricts to
the auditable persisted-event allowlist, applies validated filters + keyset
pagination, and returns normalized records (never raw rows; it never selects the
`ip_address` / `user_agent` / `session_id` columns). The **mapper** re-sanitizes
metadata at read time, maps the persisted event name to its public type, derives
safe actor/target summaries, and stamps the authoritative org id.

### Why it is additive over existing event producers

Since Sprint 5, every organization action (member, project, plan, API key,
invitation) has been written to `security_events` inside the mutation's
transaction. Sprint 10 **reads** that seam. It introduces **no new event system,
no schema change, and no migration** (`pnpm db:generate` reports zero drift). Most
persisted names are already public; the member events (`org.member_*`) are mapped
to public names (`member.*`) by a thin catalog rather than renaming historical
producers. The catalog's allowlist is also the action/security boundary in code.

### Where it lives

| Area | Files |
| --- | --- |
| Contracts | `packages/contracts/src/audit.ts` (DTOs, query/response/meta schemas, event catalog) + `src/index.ts` barrel |
| Catalog / mapping | `apps/api/src/modules/audit/audit.catalog.ts` (public↔persisted map, allowlist, filter resolution) |
| Types | `apps/api/src/modules/audit/audit.types.ts` |
| Mapper | `apps/api/src/modules/audit/audit.mapper.ts` (sanitize + shape) |
| Repository | `apps/api/src/modules/audit/audit.repo.ts` (Drizzle, tenant-scoped read) |
| Service | `apps/api/src/modules/audit/audit.service.ts` (policy pipeline) |
| Route | `apps/api/src/modules/audit/audit.routes.ts` |
| Entitlement gate | `apps/api/src/modules/entitlements/entitlement.service.ts` (`requireAuditLogAccess`) |
| Shared sanitizer | `apps/api/src/lib/security-metadata.ts` (safe-id allowlist + ip/ua/session denylist) |
| Wiring | `apps/api/src/app.ts`, `apps/api/src/server.ts` |
| Test infra | `…/audit/testing/*`, `…/organization/testing/in-memory-org-store.ts` |

### What was deliberately NOT implemented

No audit UI / web-demo page, export/CSV, webhook, SIEM, alerting, analytics,
compliance reports, retention deletion/enforcement, background worker,
cross-organization search, admin superuser surface, security-event console,
API-key access to audit logs, external audit API, full-text search, advanced
query language, billing/Stripe, workers/queues, or deployment automation. See
§7 (Scope Control).

---

## 2. Public API Contract

**Route:** `GET /v1/organizations/:organizationId/audit-events` — Bearer auth. The
`:organizationId` path segment is the sole, authoritative tenant boundary.

**Query params** (`auditListQuerySchema`, all optional, validated):

| Param | Type | Notes |
| --- | --- | --- |
| `cursor` | opaque string | From a prior page's `nextCursor`; malformed → `400 BAD_REQUEST` |
| `limit` | int | Default 20, max 100; out of range → `400 VALIDATION_ERROR` |
| `eventType` | public event type | One of `AUDIT_EVENT_TYPES` |
| `actorType` | `user \| api_key \| system \| unknown` | |
| `targetType` | `membership \| project \| plan \| api_key \| invitation \| organization \| unknown` | |
| `actorId` | string | Acting user id |
| `targetId` | string | Matched across known metadata id-keys |
| `createdAfter` / `createdBefore` | ISO-8601 | Inclusive time bounds |

**Success response** (standard envelope, `data` =):

```jsonc
{
  "items": [
    {
      "id": "sevt_…",
      "organizationId": "org_…",
      "type": "project.created",        // public event type
      "category": "action",             // v1 always "action"
      "actor":  { "type": "user", "userId": "user_…", "membershipId": "mem_…", "apiKeyId": null, "label": null },
      "target": { "type": "project", "id": "prj_…", "label": null },
      "metadata": { "name": "Launch" }, // sanitized; never secrets/tokens/hashes/cookies/headers/bodies/ip/ua/session
      "requestId": "req_…",
      "createdAt": "2026-06-25T00:00:00.000Z"
    }
  ],
  "nextCursor": null,                    // null when there are no more
  "hasMore": false,
  "meta": { "auditRetentionDays": 90 }   // display-only
}
```

**Error behavior:** standard error envelope with the request id echoed on the
`x-request-id` response header. `401` unauthenticated; `404
ORGANIZATION_NOT_FOUND` for non-members (indistinguishable from "does not exist",
so non-members cannot probe); `403 FORBIDDEN` lacking the permission; `403
ENTITLEMENT_REQUIRED` (with `details.entitlement: "audit_log_access"`) lacking the
entitlement; `400 VALIDATION_ERROR` for bad filters; `400 BAD_REQUEST` for a
malformed cursor.

**Pagination:** cursor only (no offset). Ordering `created_at DESC, id DESC` —
total and stable (`id` breaks ties). The cursor encodes the sort position
`{createdAt, id}`, not a page number; the repository fetches `limit + 1` to
compute `hasMore`/`nextCursor`. Pages never duplicate or skip events.

**Filters:** validated by the contract; applied **within** organization scope
(never widening it). `eventType`/`targetType` resolve to an indexed `event_type`
set (a target kind is fully determined by its event type, so this is correct and
index-friendly). An empty selection (e.g. `targetType=organization`, which no v1
event uses) returns an empty page without a query.

**Metadata:** sanitized defensively at read time (see §below and `audit-log.md`).
Never a raw persistence row; never secrets/tokens/hashes/cookies/Authorization
headers/request bodies; never ip/user-agent/session. Safe opaque ids are
preserved. No internal mapping field (e.g. `__persistedType`) is ever present.

**Actor summary:** `type ∈ {user, api_key, system, unknown}` (persisted
`anonymous` → `unknown`); exposes only safe ids (`userId`, `membershipId`,
`apiKeyId`) and never fabricates identity — an incomplete event stays `unknown`.

**Target summary:** `type ∈ {membership, project, plan, api_key, invitation,
organization, unknown}` (persisted `organization_plan` → `plan`); `id` is the
opaque target id or `null` when the kind has none; `label` is a non-secret
display string (e.g. the new plan key for a plan change).

**Permission + entitlement:** `audit_events.read` (Owner/Admin in the v1 matrix)
**and** `audit_log_access` (Pro/Business plans; Free does not grant it). Enforced
independently — both must pass.

**Retention metadata — field-name distinction (explicit):**

- `audit_retention_days` — the **entitlement / policy key** (`ENTITLEMENT_KEYS`),
  the value is *resolved from* it; snake_case, as all entitlement keys are.
- `meta.auditRetentionDays` — the **public DTO field** that surfaces that value;
  camelCase, matching this repo's uniformly camelCase DTO response fields.

It is **display-only**: Sprint 10 returns the modeled retention window (Free 0,
Pro 30, Business 90) but deletes nothing and enforces no age limit.

---

## 3. Documentation Index

| Document | Status | Covers |
| --- | --- | --- |
| [`docs/audit-log.md`](./audit-log.md) | Created (Sprint 10) | A–E reference: developer docs; architecture (decisions, tradeoffs, rejected alternatives, why expose-not-redesign); contracts & invariants; the field-name convention table; integration notes; known limitations; the full metadata-sanitization rules (safe-id allowlist vs secret-bearing material, ip/ua/session). |
| [`docs/sprint-10-artifact-package.md`](./sprint-10-artifact-package.md) | This file (final) | Authoritative artifact: implementation summary, public API contract, doc index, validation evidence, confidence assessment, remaining risks, scope control, next-sprint readiness, commit message. |
| [`README.md`](../README.md) | Updated | Top-banner Sprint 10 paragraph; non-goals corrected (audit **read** shipped; retention deletion/UI/export/webhook/SIEM still out); entitlement consumption note (`audit_log_access` gates, `audit_retention_days` → `meta.auditRetentionDays` display-only); Documentation index entries for the two docs above. |

No other docs were changed in this finalization pass.

---

## 4. Validation Evidence

All commands run from the repo root.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | **Pass** — all 7 projects (`tsc --noEmit`) |
| `pnpm test` | **Pass** — 489 tests, 53 files |
| `pnpm --filter @orgistry/web-demo run build` | **Pass** — Vite production build |
| `pnpm db:generate` | **Pass** — "No schema changes, nothing to migrate" (zero drift) |
| `git diff --check` | **Pass** — clean (no whitespace/conflict markers) |
| `pnpm test:integration` | **Pass** — db migration suite (13) + api integration suites (38) = **51 tests** green on clean infra (see note) |
| `pnpm lint` | Placeholder script — type-checking is the repo's active gate, by design |

**Sprint 10 test footprint (unambiguous):** 3 dedicated test files —
`packages/contracts/src/audit.test.ts` (8), `…/audit/audit.mapper.test.ts` (14),
`…/audit/audit.routes.test.ts` (24) = **46 tests** — plus **4** sanitizer tests
added to the existing `…/auth/security-events.test.ts` (now 10 total) = **50
Sprint 10 tests**. These are part of the 489-test, 53-file unit suite. No existing
suite regressed (auth/session, organizations, RBAC, projects, entitlements/quotas,
API keys, invitations, web build all green).

**Integration-test execution note.** The default `pnpm infra:up` could not bind
PostgreSQL on this host: an unrelated container (`vocab_postgres`) holds
`127.0.0.1:5432`, so the Orgistry container fails with `Bind for 127.0.0.1:5432
failed: port is already allocated` (and any connection on 5432 reaches the other
server, surfacing `password authentication failed for user "orgistry"`). This is a
host port-conflict, not a Sprint 10 defect — the change adds no schema and no
migration. The suites were validated by provisioning a throwaway,
Orgistry-compatible Postgres on a **free** port and pointing the test env at it;
the user's container was left untouched and **no permanent infra change was
introduced** (the throwaway was torn down afterward):

```bash
# 1) Throwaway Postgres on a free port, seeded with the orgistry_test DB
docker run -d --name orgistry-pg-tmp \
  -e POSTGRES_USER=orgistry -e POSTGRES_PASSWORD=orgistry -e POSTGRES_DB=orgistry \
  -p 55432:5432 \
  -v "$PWD/infra/postgres-init:/docker-entrypoint-initdb.d:ro" \
  postgres:16-alpine

# 2) Reset+migrate the test DB and run the integration suites
export NODE_ENV=test
export DATABASE_URL="postgres://orgistry:orgistry@localhost:55432/orgistry"
export TEST_DATABASE_URL="postgres://orgistry:orgistry@localhost:55432/orgistry_test"
pnpm db:reset:test && pnpm test:integration

# 3) Tear down
docker rm -f orgistry-pg-tmp
```

On a clean host (nothing on 5432) the documented path is simply
`pnpm infra:up && pnpm db:reset:test && pnpm test:integration`.

This finalization pass was **doc-only** (no application code changed since the
integration run above), and `pnpm test:integration` was **not re-run** here
because the local 5432 conflict persists and clean infra was not re-provisioned;
the previously documented successful run stands.

---

## 5. Confidence Assessment

- **API shape stability — high.** The DTOs, query params, ordering, and cursor
  payload are contract-tested and frozen behind `@orgistry/contracts`. The public
  event catalog decouples client-facing names from storage, so producer renames
  cannot break the API. Invariants requiring review-before-change are listed in
  `audit-log.md` §C.
- **Permission/entitlement separation — high.** The two gates are distinct
  (`audit_events.read` vs `audit_log_access`) and tested in isolation in both
  directions (permission-present/entitlement-missing and vice versa), with the
  enforcement order fixed in the service.
- **Tenant isolation — high.** The repository requires an org id and scopes every
  query by it before any filter; the mapper stamps the authoritative actor org
  id; non-members get an indistinguishable 404; cross-tenant `targetId` filtering
  returns nothing. All covered by route tests.
- **Metadata sanitization — high.** Read-time defense-in-depth via a shared,
  recursive sanitizer with an exact-match safe-id allowlist and a secret +
  correlation-key denylist; unit- and route-tested that safe ids survive while
  secrets/hashes/tokens/headers/cookies/ip/ua/session never serialize.
- **Pagination / filter stability — high.** Keyset ordering is total and stable;
  no-duplicate/no-skip is asserted by paging the full set; filters validated by
  contract and tested per dimension.
- **Documentation readiness — high.** The three docs are internally consistent on
  the four canonical terms and the field-name distinction; this artifact is the
  authoritative handoff.
- **Regression risk — low.** Additive read path; no schema/migration; the only
  shared-code change (sanitizer) was verified non-breaking (no producer/test uses
  the newly allowlisted/denylisted keys as live metadata). Full unit suite and the
  clean-infra integration suites pass.
- **Production/compliance readiness — NOT claimed.** This is a validated internal
  backend surface, not a production-certified or compliance-audited system.

---

## 6. Remaining Risks

- **`targetId` filter is not index-backed.** It matches across a bounded set of
  metadata id-keys (no free-text search). Acceptable for v1; if the filter becomes
  hot, a generated column + index is the follow-up.
- **No security-event stream/category beyond `action`.** Auth/session security
  events are intentionally excluded. The `category` field is reserved so a future,
  safely-attributed `security` category can be added without a breaking change.
- **Retention is display-only.** `meta.auditRetentionDays` reflects plan policy;
  no deletion or enforcement exists. Any future retention job must honor this
  contract rather than silently change response semantics.
- **Future surfaces must preserve this contract.** A future audit UI / export /
  retention job must consume the existing DTO + permission/entitlement model and
  the action/security boundary, not bypass them.

---

## 7. Scope Control Confirmation

No out-of-scope features were added. Verified absent: audit UI / web-demo page,
export/CSV, webhook delivery, SIEM integration, alerting, analytics dashboard,
compliance reports, retention deletion/enforcement/cleanup job, background
retention worker, cross-organization audit search, admin superuser audit surface,
event ingestion redesign, event-producer rewrites, immutable ledger, cryptographic
signing, event replay, security-event console, API-key access to audit logs,
external audit API, full-text search, advanced query language, billing/Stripe,
workers/queues, and production deployment automation. This sprint is a backend
read API plus its tests and docs — nothing more.

---

## 8. Readiness for Next Sprint

**Ready — yes.** Sprint 10 is implementation-complete with DoD met, and the
following are stable enough to build on:

- **Audit DTO shape** — frozen, contract-tested public schemas (`AuditEvent`,
  actor/target summaries, list response + `meta`).
- **Route pattern** — the standard organization-scoped, Bearer-authenticated,
  permission+entitlement-gated read surface.
- **Permission/entitlement enforcement** — `audit_events.read` +
  `audit_log_access`, independent and tested.
- **Pagination** — stable keyset cursor (`created_at DESC, id DESC`).
- **Filters** — validated event/actor/target type, time bounds, actor/target id.
- **Sanitizer** — shared, recursive, allowlist-aware; safe ids in, secrets/ip/ua/
  session out.
- **Actor/target summaries** — honest derivation with no fabricated identity.
- **Retention display** — `meta.auditRetentionDays`, display-only.
- **Audit/security boundary** — the catalog allowlist keeps action events in and
  auth/session security events out.

**Recommended next sprint:** **Web Demo Admin Surfaces** (a read-only audit view
that consumes this API unchanged) or a **Maintenance/Hardening** pass (e.g. a
`targetId` index, or — as a separate, deliberately-scoped effort — a retention
enforcement job that honors the display-only contract). A future UI must not
weaken the permission/entitlement gates, tenant isolation, the action/security
boundary, or metadata sanitization.

---

## 9. Suggested Commit Message

```
feat(audit): organization-scoped audit log read API (Sprint 10)

Read-only, permission- and entitlement-gated API over the organization action
events already recorded on the security_events seam (Sprints 5-9):
GET /v1/organizations/:organizationId/audit-events.

- public audit DTOs, actor/target summaries, list query/response + retention
  metadata contracts; stable public event-type catalog + public<->persisted
  mapping layer that keeps the action/security boundary in code
- tenant-scoped read repository (keyset pagination, created_at DESC, id DESC);
  service composes membership -> audit_events.read -> audit_log_access ->
  retention -> query -> sanitize/shape; requireAuditLogAccess entitlement gate
- defensive read-time metadata sanitization: secrets/tokens/hashes/headers/
  cookies and ip/user-agent/session blocked; safe opaque ids (apiKeyId,
  targetKeyId, membership/project/invitation ids) preserved via exact-match
  allowlist; no raw rows, no internal mapping fields
- audit_retention_days entitlement value surfaced as the display-only DTO field
  meta.auditRetentionDays (no retention deletion); auth/session security events
  excluded from the default stream
- contracts, mapper, sanitizer, and end-to-end route tests; docs/audit-log.md +
  Sprint 10 artifact package; README sync

No schema change, no migration (db:generate: no drift). Unit suite (489) and
DB-backed integration suites (51, clean infra) green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

Do not commit. Do not push.
