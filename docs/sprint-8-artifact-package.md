# Sprint 8 Artifact Package

Official completion artifact for Orgistry Sprint 8 — **API Keys & External
Read-Only Projects API**. This is the authoritative, finalized record of what the
sprint delivered, the contracts and invariants it establishes, how it was
validated, its security posture, the accepted residual risks, and what the next
sprint may build on. It summarizes and indexes; the full engineering reference is
[`api-keys-external-api.md`](api-keys-external-api.md).

Sprint 8 extends the Sprint 7 capability model with organization-scoped machine
credentials and the platform's first external API surface, proving the chain:

```
Organization Plan → API Key Entitlement (api_keys_access) → API Key Quota (max_api_keys)
  → Hash-Backed API Key → Scoped External API Access (projects:read) → Tenant-Scoped Projects Read
```

It introduces a second authorization plane and keeps it strictly separate from
the first:

```
Permission:  what the USER managing keys may do        (RBAC; api_keys.*).
Entitlement: whether the ORGANIZATION'S plan allows keys (api_keys_access).
Quota:       how many active keys the organization may hold (max_api_keys).
Scope:       what a KEY may do once authenticated        (projects:read).
```

> **API keys are organization-scoped machine credentials — not user sessions and
> not user impersonation.** A key belongs to exactly one organization, carries its
> own typed scopes, holds no user permissions, and its tenant is derived from the
> key row, never the request.

**Status: COMPLETE and ACCEPTED** (initial implementation + one refinement pass;
see [§10](#10-final-changelog)).

---

## 1. Implementation Summary

Sprint 8 delivers hash-only, organization-scoped API keys and a read-only external
Projects endpoint on top of the Sprint 5 RBAC and Sprint 7 entitlement/quota
layers. No billing, no write surface, no UI.

### What was implemented

- **API key persistence** — `api_keys` table: `key_`-prefixed ids, a **unique**
  `secret_hash`, typed `scopes` (jsonb), `expires_at`, `last_used_at`, revocation
  markers (`revoked_at` / `revoked_by_user_id`), `created_by_user_id`, audit
  timestamps. Indexes: unique secret-hash lookup, org+created list, and a partial
  org-active index (`WHERE revoked_at IS NULL`).
- **Stable secret format** — `orgistry_<displayId>_<secret>`. Only the
  display-safe prefix and `sha256(secret)` are stored.
- **Management routes** (Bearer **user** auth, organization-scoped):
  - `POST /v1/organizations/:organizationId/api-keys`
  - `GET /v1/organizations/:organizationId/api-keys`
  - `DELETE /v1/organizations/:organizationId/api-keys/:apiKeyId`
- **External read-only route** (API-key auth): `GET /v1/external/projects`.
- **API key authenticator** producing a machine `ApiKeyActor`, external
  Redis-backed per-key/per-organization rate limits, throttled `last_used_at`,
  lifecycle action events, and failed-auth security events.

### Major modules / files

- **Contracts:** `packages/contracts/src/api-keys.ts`, `error-codes.ts`,
  `index.ts`.
- **DB:** `packages/db/src/schema/api-keys.ts`, `schema/index.ts`, `index.ts`,
  `schema/auth.ts` (`api_key` actor type), `migrations/0006_tense_jamie_braddock.sql`.
- **API module:** `apps/api/src/modules/api-keys/*` — `api-key-secret.ts`,
  `api-key.types.ts`, `api-key.repo.ts`, `api-key.service.ts`,
  `api-key.authenticator.ts`, `api-key.routes.ts`, `external-projects.service.ts`,
  `external-projects.routes.ts`, `api-key.events.ts`, `api-key.errors.ts`,
  `testing/*`.
- **Entitlements:** `modules/entitlements/entitlement.service.ts` (two additive
  gates: `requireApiKeysAccess`, `requireApiKeyCreationQuota`).
- **Wiring/config:** `apps/api/src/{app,server}.ts`,
  `packages/config/src/{schema,index}.ts`, `.env.example`.

### API key lifecycle overview

Create resolves the actor, then enforces, in order:
`requireMembership → requirePermission(api_keys.create) → requireApiKeysAccess →
requireApiKeyCreationQuota → generate secret → insert (hash only) →
record api_key.created`. The raw secret is returned **once** (create response) and
is unrecoverable thereafter. List returns active **and** revoked keys (status is
derived), never the secret or hash. Revoke sets the markers, records one
`api_key.revoked` action event, and is **idempotent** (a repeat preserves markers
and writes no second event). Keys are revoked, never hard-deleted.

### External Projects API overview

`GET /v1/external/projects` is authenticated **only** by an API key, takes **no
organization id** in the path, derives the tenant from the resolved key row,
requires the `projects:read` scope, re-checks `api_keys_access` on every request,
returns only the key organization's active (non-soft-deleted) projects with cursor
pagination and explicit external DTOs, and exposes no write surface.

### How management auth differs from API key auth

| | Management routes | External route |
| --- | --- | --- |
| Credential | Bearer **user** access token (JWT) | Bearer **API key** (`orgistry_…`) |
| Actor | user `OrganizationActor` | machine `ApiKeyActor` (no user id, no permissions) |
| Membership | `requireMembership` required | **never** called |
| Tenant source | route `:organizationId` | the **key row** (`organization_id`) |
| Org id in request | path param | **not accepted** anywhere |
| Browser JWT | required | **rejected** (parses to a non-key → 401) |

### Entitlement / quota / scope chain

`api_keys_access` (plan entitlement) gates whether keys may exist and be used;
`max_api_keys` (plan quota) gates how many **active** keys may exist; the typed
`projects:read` **scope** gates what an authenticated key may do. These are
distinct from the user RBAC permissions (`api_keys.*`) that govern key management.
The Sprint 7 entitlement/quota model is consumed unchanged — two thin gates reuse
the existing pure `requireEntitlement` / `requireQuota` primitives.

### Deliberately not implemented

Write-enabled external APIs, external project create/update/delete, org-id external
routes, key impersonation of users, service accounts, OAuth client credentials,
personal access tokens, key rotation / secret-reveal / update endpoints, an
advanced/custom scope editor, resource-level scopes, a web API key UI, an external
SDK, OpenAPI publishing, webhooks, invitations, an audit-log read API/UI,
Stripe/billing, custom plans/roles, ABAC, RLS, and workers/queues.

---

## 2. Documentation Index

| Document | Covers |
| --- | --- |
| [`docs/sprint-8-artifact-package.md`](sprint-8-artifact-package.md) (this) | Official completion artifact: implementation summary, invariants, validation evidence, security review, confidence, residual risks, scope control, next-sprint readiness, changelog. |
| [`docs/api-keys-external-api.md`](api-keys-external-api.md) | Full engineering reference (§A–F): developer docs, architecture, contracts/invariants, integration, limitations, handoff. |
| [`README.md`](../README.md) | Public surface summary, the Sprint 8 endpoint list, and the doc index. |
| [`.env.example`](../.env.example) | The external rate-limit buckets and the last-used throttle config variables. |
| `docs/sprint-1…7-artifact-package.md` | Prior sprint artifacts (the per-sprint completion index). |

Where future engineers should look:

- **API key lifecycle** — `api-keys-external-api.md` §A ("How API keys work",
  management lifecycle).
- **Secret format** — `api-keys-external-api.md` §A ("How API keys work") and §C
  ("API key secret format"); code in `api-key-secret.ts`.
- **Contracts** — `api-keys-external-api.md` §C; code in
  `packages/contracts/src/api-keys.ts`.
- **Invariants** — `api-keys-external-api.md` §C and [§3](#3-contracts-and-invariants)
  below.
- **External API behavior** — `api-keys-external-api.md` §A/§C/§D.
- **Rate limits** — `api-keys-external-api.md` §A/§D and `.env.example`; code in
  `api-key.authenticator.ts` + `lib/rate-limit.ts`.
- **Event model** — `api-keys-external-api.md` §A ("Event model") and §D; code in
  `api-key.events.ts` / `api-key.repo.ts`.
- **Known limitations** — `api-keys-external-api.md` §E and [§7](#7-remaining-risks)
  below.
- **Next sprint handoff** — `api-keys-external-api.md` §F and
  [§9](#9-readiness-for-next-sprint) below.

---

## 3. Contracts and Invariants

Stable interfaces. Changing any of these is a reviewed contract change.

- **Key ids** use the `key_` prefix, generated in the repository (`createId('key')`);
  there is no database default (an id-less insert is rejected).
- **One organization per key.** An API key belongs to exactly one organization and
  is only ever addressed within it (management) or scoped to it (external).
- **Raw secrets are never stored.** Only `sha256(secret)` is persisted, in the
  **unique** `secret_hash` column; a presented key resolves to at most one row.
- **Raw secret shown once.** The raw secret appears in **exactly one** response —
  `POST …/api-keys` (`201`) — and is unrecoverable afterwards.
- **Secret hashes are unique and never returned.** No DTO carries `secret_hash`.
- **Create is the only secret-bearing response.** List, read, and revoke responses
  exclude both the raw secret and the secret hash.
- **External tenant context is derived from the key row** (`organization_id`),
  never from the route, query, body, or header.
- **External route accepts no organization id** — there is no org path segment and
  no org input is read.
- **External route accepts no browser JWT** — a non-`orgistry_` credential parses
  to nothing and is rejected with the generic `API_KEY_UNAUTHORIZED` (401).
- **`projects:read` is required** for `GET /v1/external/projects`; a missing scope
  yields `API_KEY_SCOPE_REQUIRED` (403) with the required scope in `details`.
- **Revoked keys cannot authenticate** (generic 401).
- **Expired keys cannot authenticate** (generic 401).
- **Active quota count** means **`revoked_at IS NULL` AND
  (`expires_at IS NULL OR expires_at > now`)**. Revoked and expired keys do **not**
  count toward `max_api_keys`. `now` is supplied by the service clock, never Redis.
- **Revoke is idempotent.** The first revoke writes `revoked_at` +
  `revoked_by_user_id` and exactly one `api_key.revoked` event; a repeated revoke
  returns the same safe success, preserves both markers, and writes no second
  event. An unknown or cross-tenant key is a uniform `API_KEY_NOT_FOUND` (404).
- **`last_used_at` is throttled and approximate** — at most one write per
  `API_KEY_LAST_USED_THROTTLE_SECONDS` (default 60) per key; failed/revoked/expired
  auth never updates it.
- **Redis rate limiting must not affect authentication correctness.** Rate limits
  run after full key validation and fail **open**; auth truth is PostgreSQL alone.
- **Lifecycle action events and failed-auth security events are conceptually
  distinct.** `api_key.created` / `api_key.revoked` are `user`-actor action events
  written in the mutation transaction; `api_key.auth_*` / `api_key.rate_limit_exceeded`
  are machine/anonymous-actor security events for rejected requests. They share the
  `security_events` table only as an internal storage detail (separate writer
  methods, separate input types, disjoint event-name namespaces).

Illustrative (obviously fake) raw key shape — never log or store a real one:

```
orgistry_EXAMPLE01_THIS-IS-NOT-A-REAL-SECRET
```

---

## 4. Validation Evidence

All commands below were run in this finalization pass. Unit tests run without
infrastructure; integration tests and `db:reset:test` were run against disposable
PostgreSQL + Redis containers (see environment note).

| Command | Result |
| --- | --- |
| `pnpm typecheck` | ✅ PASS — 7 projects |
| `pnpm lint` | ✅ PASS |
| `pnpm test` (unit) | ✅ PASS — **393** tests, 45 files |
| `pnpm --filter @orgistry/web-demo run build` | ✅ PASS |
| `pnpm db:generate` (schema drift) | ✅ no schema changes (0006 is current) |
| `git diff --check` | ✅ PASS — no whitespace/conflict errors |
| `pnpm db:reset:test` | ✅ PASS (reset truncates `api_keys`) |
| `pnpm --filter @orgistry/db test:integration` | ✅ PASS — **13** tests |
| `pnpm --filter @orgistry/api test:integration` | ✅ PASS — **35** tests |

Integration total: **48** (db 13 + api 35), including the Redis-dependent
`readiness.integration.test.ts`.

Sprint 8 unit coverage:

- `packages/contracts/src/api-keys.test.ts` — **10** (scope enum, request/DTO
  validation, no-secret-field DTOs).
- `apps/api/src/modules/api-keys/api-key-secret.test.ts` — **7** (format,
  parse-null-on-malformed, deterministic hash, entropy).
- `apps/api/src/modules/api-keys/api-key.routes.test.ts` — **18** (auth/membership/
  permission/entitlement/quota gates, hash-only storage, one-time secret,
  active/revoked/expired quota counting, lifecycle-event attribution, revoke
  idempotency preservation, tenant-scoped revoke).
- `apps/api/src/modules/api-keys/external-projects.routes.test.ts` — **16**
  (missing/malformed/unknown/revoked/expired/inactive-org/missing-entitlement/
  missing-scope, browser-JWT rejection, tenant isolation, soft-delete omission,
  cursor pagination, no-write surface, last-used throttling, per-key & per-org
  rate limits, security-event attribution & metadata sanitization).
- Integration: `migrate.integration.test.ts` asserts the `api_keys` table +
  indexes, secret-hash uniqueness, the partial active-index predicate, and that an
  id-less insert is rejected (ids are repository-generated).

**Environment note (unchanged from Sprints 5–7):** the dev host's port 5432 was
held by an unrelated PostgreSQL with different credentials, so `db:reset:test` and
both integration suites were run against disposable `postgres:16-alpine` +
`redis:7-alpine` containers on alternate ports (5544 / 6399), then removed. This is
a port/credential choice, not a Sprint 8 limitation. No command failed; no failures
are outstanding.

---

## 5. Security Review

- **Secret handling.** The raw secret is generated server-side, returned by the
  create response exactly once, and never stored, returned again, or logged (the
  `api-keys` module performs no logging at all).
- **Hash-only persistence.** Only `sha256(secret)` is stored, in the unique
  `secret_hash` column. SHA-256 is correct here: the secret is already
  high-entropy, so the threat model is database exfiltration → lookup, not offline
  brute force.
- **No secret/hash in DTOs.** The public `ApiKey` DTO has no `secret` or
  `secret_hash` field (contract test); list/read/revoke responses carry neither.
- **No secret/hash/token material in events.** Tests assert the raw secret, the
  secret component, the hash, and Authorization material are absent from both
  lifecycle and auth-failure event metadata. All metadata passes through
  `sanitizeSecurityMetadata`; the resolved-id metadata key (`targetKeyId`) avoids
  the sanitizer's `api_key`/`secret`/`hash` denylist substrings.
- **Failed-auth attribution rules.** Malformed and unknown keys store **no** key id
  and **no** organization id (no invented attribution; `anonymous` actor).
  Revoked/expired/scope/entitlement/rate-limit events include the **safely
  resolved** key id and organization id (`api_key` actor). Verified by tests.
- **Revoked / expired behavior.** Both fail authentication with the generic 401,
  do not update `last_used_at`, and emit a sanitized security event.
- **Scope enforcement.** `projects:read` is required externally; a scope-less key
  yields `API_KEY_SCOPE_REQUIRED` (403).
- **Tenant isolation.** Cross-tenant management revoke is a uniform
  `API_KEY_NOT_FOUND`; the external read returns only the key organization's active
  projects. Both tested.
- **Browser JWT rejection.** A browser access token is not an API key; it fails
  format parsing and is rejected with the generic 401.
- **External no-org-id behavior.** The route has no org segment and reads no org
  input; the tenant is the key row's `organization_id`, so a client cannot request
  another tenant's data.
- **Rate-limit behavior.** Per-key and per-organization Redis buckets run **after**
  full validation and fail **open** — a Redis outage disables throttling but never
  affects auth correctness; Redis remains required for `/ready`.

---

## 6. Confidence Assessment

**Confidence: High.**

- **Test coverage.** Every required behavior is exercised end-to-end through the
  HTTP layer over a shared in-memory store, plus DB-backed integration tests for
  schema, indexes, and uniqueness. Secret handling, scope enforcement, tenant
  isolation, quota counting (active/revoked/expired), revoke idempotency, last-used
  throttling, rate limits, and event attribution/sanitization are all covered.
- **Validation results.** All commands pass (unit 393; integration 48; typecheck,
  lint, web build, schema-drift, `git diff --check`, `db:reset:test`).
- **Remaining race windows.** The only one is the small create-time quota race
  (below), bounded to at most one key over quota and self-correcting; it matches
  the accepted Sprint 7 posture and is not a security issue.
- **Documentation alignment.** The artifact, the §A–F reference, the README, and
  `.env.example` agree with the code (verified this pass: quota excludes expired
  keys; action vs security events distinct; tenant from key row; browser JWT
  rejected; raw secret shown once and never stored).
- **Scope control.** No out-of-scope feature was added; the entitlement/quota model
  was consumed, not redesigned.
- **Security posture.** Hash-only storage, one-time secret, sanitized events,
  fail-open rate limiting decoupled from auth correctness, and strict tenant
  derivation from the key row.

---

## 7. Remaining Risks

Accepted residual risks only:

- **Create-time quota race window.** The active-count read and the insert are not
  serialized under a per-organization lock, so two simultaneous creates at the
  ceiling could both pass; worst case is one key over `max_api_keys`, self-correcting
  on the next create. There is no per-org key-count DB constraint. Same posture as
  the Sprint 7 project/member quotas. Fix (deferred): a transactional count under a
  per-org lock.
- **`last_used_at` is approximate** because writes are throttled (≤ 1 per
  `API_KEY_LAST_USED_THROTTLE_SECONDS`, default 60, per key). It is a "recently
  used" signal, not a per-request audit.
- **Rate limiting fails open if Redis is unavailable.** Throttling is disabled
  during a Redis outage; authentication correctness does not depend on Redis
  (validation is PostgreSQL-only). Redis remains required for `/ready`.
- **Management routes are entitlement-gated.** Because list/revoke require
  `api_keys_access`, after a plan downgrade an organization cannot list or revoke
  its existing keys until re-entitled — though those keys already cannot
  authenticate (the external authenticator re-checks the entitlement every request).
  A management-visibility limitation, not a security hole.

---

## 8. Scope Control

Confirmed — Sprint 8 did **not** add any of:

- write-enabled external APIs
- API key rotation endpoint
- API key secret-reveal endpoint
- API key update endpoint
- advanced scope editor
- API key UI
- invitations
- audit read API
- billing / Stripe
- service accounts
- OAuth client credentials
- personal access tokens
- custom roles
- resource-level permissions
- ABAC
- RLS
- workers / queues
- production deployment automation
- public package publishing

The external API is read-only with a single flat scope (`projects:read`). The
Sprint 7 entitlement/quota model was consumed via two additive `EntitlementService`
gates, not redesigned.

---

## 9. Readiness for Next Sprint

**Ready.** Sprint 8 is complete, validated, and documented. The next sprint can
safely build on these stable surfaces:

- **API key schema** — `api_keys` table, `key_` ids, indexes (incl. the partial
  active index).
- **Secret format** — `orgistry_<displayId>_<secret>`, with total/safe parsing.
- **Hash-only storage** — unique `secret_hash`; raw secret unrecoverable.
- **One-time secret display** — create is the sole secret-bearing response.
- **Typed scope model** — flat enum, extensible to e.g. `projects:write` without a
  policy engine.
- **API key authenticator** — the full validation pipeline returning a machine
  actor.
- **API key actor context** — `ApiKeyActor`, permanently separate from user
  sessions.
- **External route pattern** — authenticate by scope → read tenant from the actor →
  reuse a tenant-scoped repository; copy it for further read endpoints.
- **Tenant isolation pattern** — org derived from the key row; no org id externally.
- **Action/security event behavior** — distinct lifecycle and auth-failure events
  on the shared internal seam, awaiting a permission-gated reader.
- **Documentation** — the §A–F reference and this artifact, kept in sync with code.

The natural next sprint remains **Invitations Lifecycle**, unless project planning
chooses the **Audit Log read API** (the `api_key.*`, member, project, and plan
events already accumulate on the organization-scoped `security_events` seam,
awaiting a permission-gated `audit_events.read` surface).

---

## 10. Final Changelog

- **Initial implementation.** Added organization-scoped, hash-backed API keys
  (`key_` ids, `orgistry_<displayId>_<secret>` format, unique `secret_hash`),
  one-time secret display, the typed `projects:read` scope, the three management
  routes (Bearer user auth + membership + `api_keys.*` + `api_keys_access` +
  `max_api_keys`), the external `GET /v1/external/projects` route (API-key auth,
  no org id, no browser JWT, tenant from key row, `projects:read`, active-only,
  cursor-paginated), the API key authenticator + machine actor, per-key/per-org
  Redis rate limits, last-used throttling, lifecycle action events and failed-auth
  security events, sanitized metadata, the `0006` migration, and the full test
  suite. Consumed the Sprint 7 entitlement/quota model via two additive gates.
- **Refinement pass.** (1) Sharpened the event model so lifecycle action events and
  failed-auth security events are explicitly distinct (shared storage documented as
  an internal detail). (2) Corrected the active-quota count to exclude **expired**
  keys as well as revoked keys (`revoked_at IS NULL AND (expires_at IS NULL OR
  expires_at > now)`, clock-supplied `now`). (3) Replaced the tautological `key_`-id
  test with a real service-path assertion and an id-less-insert-rejected migration
  test. (4) Proved revoke idempotency preserves markers and writes no second event
  (via a second authorized actor). (5) Strengthened security-event coverage
  (missing-entitlement, rate-limit-exceeded, attribution rules, no token material
  in metadata).
- **Documentation changes.** Authored `api-keys-external-api.md` (§A–F) and this
  artifact; updated `README.md` (endpoint list, quota/event/idempotency notes) and
  `.env.example` (external rate-limit + throttle vars). Removed the stale
  "expired keys count toward quota" statement everywhere.
- **Validation improvements.** Unit suite grew to 393 (added active/revoked/expired
  quota counting, event attribution, revoke idempotency, security-event sanitization
  tests); integration suite asserts table/indexes, hash uniqueness, the partial
  active-index predicate, and repository-owned id generation.
- **Final acceptance status: ACCEPTED.** All validation passes; the only residual
  risk is the bounded, self-correcting create-time quota race window. Sprint 8 is
  ready for handoff.
