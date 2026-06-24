# API Keys & External Read-Only Projects API (Sprint 8)

Orgistry's first **machine credential** and its first **external API surface**.
Sprint 8 introduces organization-scoped, hash-backed API keys and a read-only
external Projects endpoint, proving the full chain end to end:

```
Organization Plan
  → API Key Entitlement (api_keys_access)
    → API Key Quota (max_api_keys)
      → Hash-Backed API Key
        → Scoped External API Access (projects:read)
          → Tenant-Scoped Projects Read
```

> **API keys are organization-scoped machine credentials. They are NOT user
> sessions and they do NOT impersonate users.** A key belongs to exactly one
> organization, carries its own typed scopes, holds no user permissions, and its
> tenant is derived from the key row — never from the request.

This document is the engineering reference. The sprint completion record and
changelog live in [`sprint-8-artifact-package.md`](sprint-8-artifact-package.md).

Sprint 8 deliberately does **not** implement: write-enabled external APIs;
external project create/update/delete; organization-id routes for the external
API; key impersonation of users; service accounts; OAuth client credentials;
personal access tokens; key rotation, secret-reveal, or update endpoints; an
advanced/custom scope editor; resource-level scopes; a web demo API key UI; an
external SDK; OpenAPI publishing; webhooks; invitations; an audit-log read API or
UI; Stripe/billing; custom plans/roles; ABAC/policy engines; PostgreSQL RLS; or
workers/queues. See [§E](#e-known-limitations).

---

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| API key scope enum, status, DTOs, create/list/revoke contracts, external project DTO/query | `packages/contracts/src/api-keys.ts` |
| `API_KEY_NOT_FOUND`, `API_KEY_UNAUTHORIZED`, `API_KEY_SCOPE_REQUIRED` codes | `packages/contracts/src/error-codes.ts` |
| `api_keys` table (`key_` ids, unique secret hash, scopes, lifecycle columns, indexes) | `packages/db/src/schema/api-keys.ts` |
| Generated migration (table + indexes) | `packages/db/migrations/0006_tense_jamie_braddock.sql` |
| API key secret format, generation, parsing, hashing | `apps/api/src/modules/api-keys/api-key-secret.ts` |
| API key repository boundary + params/actor types | `apps/api/src/modules/api-keys/api-key.types.ts` |
| Tenant-aware DB repository (create/list/count/lookup/revoke/touch + event writes) | `apps/api/src/modules/api-keys/api-key.repo.ts` |
| Management service (membership → permission → entitlement → quota → write → DTO) | `apps/api/src/modules/api-keys/api-key.service.ts` |
| Management routes (`POST`/`GET`/`DELETE …/api-keys`) | `apps/api/src/modules/api-keys/api-key.routes.ts` |
| External API key authenticator (machine actor, scopes, rate limits, last-used) | `apps/api/src/modules/api-keys/api-key.authenticator.ts` |
| External read-only Projects service + route (`GET /v1/external/projects`) | `apps/api/src/modules/api-keys/external-projects.{service,routes}.ts` |
| Lifecycle + failed-auth event types | `apps/api/src/modules/api-keys/api-key.events.ts` |
| Error factories | `apps/api/src/modules/api-keys/api-key.errors.ts` |
| Entitlement/quota gates for keys (consume existing model) | `apps/api/src/modules/entitlements/entitlement.service.ts` |
| External rate-limit + last-used-throttle config | `packages/config/src/schema.ts`, `packages/config/src/index.ts`, `.env.example` |
| In-memory key repo + test app builder | `apps/api/src/modules/api-keys/testing/*` |
| Service wiring | `apps/api/src/server.ts`, `apps/api/src/app.ts` |

### How API keys work

**An API key is two things glued together by a format:** a display-safe prefix
(stored and shown) and a high-entropy secret (shown once, never stored). The raw
key has the stable shape:

```
orgistry_<displayId>_<secret>
```

- `orgistry` — a fixed scheme prefix that makes a key recognizable.
- `<displayId>` — an 8-char Crockford-base32, non-secret identifier. Stored as
  part of `display_prefix` (`orgistry_<displayId>`); safe to show in lists/logs.
- `<secret>` — a 32-byte base64url secret. Only `sha256(secret)` is stored, in
  the unique `secret_hash` column. The raw key is unrecoverable afterwards.

The two halves map to two storage columns and one boundary rule: **the hash is
stored, the raw is returned exactly once.** See [§C](#c-contracts--invariants).

### The two authorization planes (do not merge)

Sprint 8's central design rule is that **managing keys** and **using keys** are
governed by entirely different mechanisms:

| Concern | Governed by | Where it lives |
| --- | --- | --- |
| May this USER create/list/revoke keys? | RBAC **permission** (`api_keys.*`) | management routes |
| May this ORGANIZATION have/use keys at all? | plan **entitlement** (`api_keys_access`) | management + external |
| How many keys may the organization hold? | plan **quota** (`max_api_keys`) | management create |
| What may this KEY do once authenticated? | API key **scope** (`projects:read`) | external routes |

A user permission never grants a key a scope; a key scope never grants a user a
permission; the plan entitlement gates both. Each is checked in its own place.

### Lifecycle: management routes

All three management routes are **Bearer USER**-authenticated, organization-scoped
(`/v1/organizations/:organizationId/api-keys`), and take the organization id from
the **route path only** — never the body.

**`POST …/api-keys`** — create. Enforcement order (each gate throws before the
next, and the write happens last so a failure creates nothing):

```
requireMembership                  → active member?           (else ORGANIZATION_NOT_FOUND 404)
  → requirePermission(api_keys.create) → user holds the key?  (else FORBIDDEN 403)
    → requireApiKeysAccess           → plan grants keys?       (else ENTITLEMENT_REQUIRED 403)
      → requireApiKeyCreationQuota   → under max_api_keys?     (else QUOTA_EXCEEDED 409)
        → generate secret + insert (hash only) + record api_key.created
```

Returns `201` with the key DTO **and** the raw `secret` (the one and only time it
appears). An optional `expiresAt` (future ISO-8601) may be supplied.

**`GET …/api-keys`** — list. Requires `api_keys.read` + `api_keys_access`.
Cursor-paginated, returns active **and** revoked keys (status is shown), never the
secret or hash.

**`DELETE …/api-keys/:apiKeyId`** — revoke. Requires `api_keys.revoke` +
`api_keys_access`. Validates org ownership, sets `revoked_at` + `revoked_by_user_id`,
records `api_key.revoked`, returns the standard success envelope. **Revocation is
idempotent:** revoking an already-revoked key returns the same safe success but
does **not** overwrite `revoked_at` or `revoked_by_user_id` and does **not** write
a second `api_key.revoked` event (the repository early-returns on a row that is
already revoked). An unknown or cross-tenant key is a uniform `API_KEY_NOT_FOUND`.
Keys are **never hard-deleted**.

### Key IDs are repository-generated

API key ids carry the `key_` prefix. There is **no database default** on the `id`
column — ids are generated in code (`createId('key')` inside
`createDbApiKeyRepository`), the same convention as projects/organizations. The
meaningful prefix assertion therefore lives on the real service path
(`api-key.routes.test.ts`), not on a hand-inserted id; the migration integration
test instead proves an id-less insert is rejected (no DB default exists).

### Event model: actions vs security failures

Two conceptually **distinct** event kinds, never blurred:

- **Lifecycle ACTION events** — `api_key.created`, `api_key.revoked`. User actions,
  written by `recordKeyEvent` **inside the mutation transaction** with a `user`
  actor. Each carries: organization id, actor user id, actor membership id, target
  key id, request id (when available), sanitized metadata, and a created timestamp.
- **Failed-auth SECURITY events** — `api_key.auth_*` / `api_key.rate_limit_exceeded`.
  Best-effort, machine-actor (`api_key`/`anonymous`) records of a *rejected*
  external request, written by `recordAuthEvent`.

**Physical storage is shared** (both land in the `security_events` table, reused
as the durable internal event sink since Sprints 5–7) but this is an **internal
implementation detail, not a conceptual merge**: separate writer methods, separate
input types, different actor types, and disjoint event-name namespaces keep the two
projectable apart for a future audit-log reader. No secret, hash, Authorization
header, cookie, or request body is ever placed in either kind of metadata.

### Using a key: external route

**`GET /v1/external/projects`** is the machine surface. It is authenticated
**only** by an API key (`Authorization: Bearer orgistry_…`), takes **no
organization id in the path**, requires the `projects:read` scope, reuses the
tenant-scoped Projects persistence (active projects only), paginates with an
opaque cursor, and returns explicit external DTOs in the standard envelope. There
is no create/update/delete surface.

```bash
curl https://api.example.test/v1/external/projects \
  -H 'Authorization: Bearer orgistry_AB12CD34_<secret>'   # secret shown is illustrative/fake
```

### How to extend it safely

- **A new scope** (e.g. `projects:write` in a future, write-enabled sprint): add
  it to `API_KEY_SCOPES` in `packages/contracts/src/api-keys.ts`. The enum, the
  create-request validation, and the DTO all derive from that constant, so they
  cannot drift. The authenticator already takes a `requiredScope` argument — a new
  external route just passes its scope. **Do not** build a custom-scope or
  policy-engine layer; the flat enum is intentional.
- **A new external read endpoint**: authenticate with
  `apiKeyAuthenticator.authenticate(rawKey, ctx, <scope>)`, read the tenant from
  `actor.organizationId`, and reuse the relevant tenant-scoped repository. Never
  call `requireMembership` on an external route and never accept an organization
  id from the client.
- **Tuning limits**: the rate-limit buckets and the last-used throttle are typed
  config (`config.rateLimit.external`, `config.apiKeys.lastUsedThrottleSeconds`).
  Change the env values, not the code.

---

## B. Architectural Notes

### Key design decisions

- **Hash-only storage, SHA-256.** The secret component is already high-entropy
  random data, so the threat model is database exfiltration → lookup, not offline
  brute force. A fast, deterministic one-way hash gives constant-cost, indexable,
  unique lookups while keeping the raw secret unrecoverable — identical reasoning
  to the Sprint 2 opaque refresh-token hashing. Argon2 would be wasted cost here.
- **Tenant derived from the key row, never the request.** The external API takes
  no organization id. This is structurally enforced: the route has no org segment,
  and the service is handed `actor.organizationId`. A client therefore *cannot*
  ask for another tenant's data — the credential *is* the tenant scope.
- **A separate machine actor.** `ApiKeyActor` (`actorType: 'api_key'`) is a
  distinct type from the user `OrganizationActor`. It carries no permissions and
  no user id. This makes "a key cannot impersonate a user" a type-level fact, not
  a convention.
- **The entitlement/quota model is consumed, not redesigned.** Sprint 7's
  `api_keys_access` entitlement and `max_api_keys` quota already existed. Sprint 8
  adds two thin gates to `EntitlementService` (`requireApiKeysAccess`,
  `requireApiKeyCreationQuota`) that reuse the existing pure `requireEntitlement` /
  `requireQuota` primitives. The active-key *count* lives in the API key
  repository (counting is a data op); the *comparison* stays in the entitlement
  service (policy). No Sprint 7 file changed shape.
- **Reuse the Projects repository for the external read.** The external service
  depends on the existing `ProjectRepository`, inheriting tenant isolation and
  soft-delete filtering for free. The only difference from the internal slice is
  the *absence* of `requireMembership` — a deliberate, visible omission.
- **Redis is kept off the auth correctness path.** Rate limiting runs *after* the
  key is fully validated and fails **open** (a Redis outage disables throttling,
  never auth). PostgreSQL and the `api_keys` table are the sole source of auth
  truth.

### Tradeoffs made

- **Listing/revoking require `api_keys_access`.** Per spec, every key operation is
  entitlement-gated. Consequence: after a plan *downgrade*, an organization can no
  longer list or revoke its existing keys until it is re-entitled. Those keys are
  already dead for authentication (the external authenticator re-checks the
  entitlement every request), so this is a management-visibility limitation, not a
  security hole. Documented in [§E](#e-known-limitations).
- **Quota counts only keys that can actually authenticate.** Active for
  `max_api_keys` means **both** `revoked_at IS NULL` **and**
  (`expires_at IS NULL OR expires_at > now`). A revoked **or** expired key never
  occupies a quota slot, so a key that can no longer authenticate cannot block
  creation indefinitely. The count takes `now` from the service clock (never
  Redis), keeping it deterministic and testable; the partial index on
  `(organization_id) WHERE revoked_at IS NULL` narrows the scan and the expiry
  predicate drops expired rows.
- **Last-used is throttled, so it is approximate.** `last_used_at` is a coarse
  "recently used" signal (default ≤ 1 write / 60s / key), not a precise audit of
  every call. This is the right tradeoff: a busy key must not generate a write per
  request.

### Rejected alternatives

- **Storing the raw key (or an encrypted, reversible form).** Rejected — a
  reveal/rotation-by-decryption surface is exactly what the sprint excludes, and
  reversible storage reintroduces the exfiltration risk hashing removes.
- **Accepting an organization id on the external API and validating it against the
  key.** Rejected — it adds an attack surface (mismatch handling, probing) for no
  benefit; the key already determines the tenant unambiguously.
- **A generic scope/policy engine.** Rejected as premature generalization. v1 has
  one scope; a flat enum keeps the model legible and extensible without
  infrastructure.
- **Hard-deleting keys on revoke.** Rejected — revocation must be auditable and
  reversible-to-inspect; lifecycle is append-only like every other resource.
- **Reusing the user-auth rate-limit buckets.** Rejected — external traffic has a
  different identity (key/org, not IP/email/session) and a different abuse profile;
  it gets its own typed buckets.

---

## C. Contracts & Invariants

These are stable interfaces. Changing them is a reviewed contract change.

### API key secret format
- Raw key: `orgistry_<displayId>_<secret>`. Scheme prefix `orgistry`,
  Crockford-base32 display id, base64url secret. The secret may itself contain
  `_`; parsing splits only on the **first** separator after the scheme.
- `display_prefix` = `orgistry_<displayId>` — the safe, non-secret identifier.
- Malformed input (anything not matching the format, including a browser JWT)
  parses to `null` and is rejected uniformly — never a throw, never a leak of
  which part was wrong.

### Hash-only storage invariant
- The raw secret is **never** persisted. Only `sha256(secret)` is stored, in the
  **unique** `secret_hash` column. A presented key resolves to at most one row.

### One-time secret display
- The raw `secret` appears in **exactly one** response: `POST …/api-keys` (`201`).
  No list, read, or revoke response — and no event metadata or log — ever contains
  it again. It is unrecoverable after creation.

### Scope model
- v1 scopes: `{ projects:read }`. Typed enum (`apiKeyScopeSchema`); invalid scope
  input is rejected at the contract boundary. Scopes are stored on the key and
  govern machine access only. Missing required scope → stable
  `API_KEY_SCOPE_REQUIRED` (403) with `details.requiredScope`.

### Status (derived, never stored)
- `revoked` (`revoked_at` set) → `expired` (`expires_at` passed) → else `active`.
  Computed from timestamps so it cannot drift.

### Active-key quota definition
- `max_api_keys` counts a key as active iff **`revoked_at IS NULL` AND
  (`expires_at IS NULL OR expires_at > now`)**. Revoked and expired keys never
  count. The count is computed from PostgreSQL with a clock-supplied `now`; it
  never depends on Redis.

### Revocation is idempotent
- The first revoke sets `revoked_at` + `revoked_by_user_id` and records exactly
  one `api_key.revoked` event. A repeated revoke is a safe success that preserves
  the original markers and writes no second event.

### Key IDs
- Generated in the repository as `createId('key')` → `key_…`. There is no DB
  default; an id-less insert is rejected at the database.

### External route behavior
- `GET /v1/external/projects`: API-key Bearer only; **no** org id in the route;
  requires `projects:read`; active, non-revoked, non-expired key; active org;
  current `api_keys_access`; tenant-scoped, soft-delete-omitting, cursor-paginated
  reads; explicit external DTOs; standard envelopes; **no** write surface; browser
  JWTs are not accepted.

### Tenant context derivation
- The organization for every external request is taken from the resolved key
  row's `organization_id`. It is never read from the route, query, body, or
  header.

### Error codes (stable)
- `API_KEY_NOT_FOUND` (404) — management revoke, unknown/cross-tenant key.
- `API_KEY_UNAUTHORIZED` (401) — generic external auth failure (missing,
  malformed, unknown, revoked, expired, inactive org). Deliberately
  indistinguishable across causes.
- `API_KEY_SCOPE_REQUIRED` (403) — authenticated key lacks a required scope.
- `ENTITLEMENT_REQUIRED` (403) / `QUOTA_EXCEEDED` (409) — reused from Sprint 7.
- `RATE_LIMITED` (429) — external bucket exceeded. Every error envelope carries
  `requestId`.

### Things that must not change
- The hash-only storage rule and the unique `secret_hash`.
- The one-time-secret invariant (create is the only secret-bearing response).
- The external route taking no organization id and rejecting browser tokens.
- `key_` id prefix; `api_keys` row never hard-deleted in normal operation.
- The separation of permission / entitlement / quota / scope.

---

## D. Integration Notes

### Management routes ↔ user auth, RBAC, entitlements, quotas
`POST/GET/DELETE …/api-keys` authenticate the **user** through the same auth
boundary as every other organization route (`requireBearerToken` →
`authenticator.authenticate`). The service then composes
`requireMembership` → `requirePermission(api_keys.*)` →
`entitlements.requireApiKeysAccess` → (create only)
`entitlements.requireApiKeyCreationQuota(orgId, activeCount)`. The active count is
read from the API key repository; the limit comparison stays in the entitlement
service. Lifecycle events (`api_key.created`, `api_key.revoked`) are written in the
**same transaction** as the mutation, on the existing organization-scoped
`security_events` seam.

### External route ↔ API key auth, scopes, rate limits, Projects
`GET /v1/external/projects` does **not** use the user auth service and **never**
calls `requireMembership`. It calls the API key authenticator, which validates the
key against PostgreSQL, derives the organization from the row, re-checks
`api_keys_access`, requires `projects:read`, applies per-key/per-organization
Redis rate limits, throttles the `last_used_at` write, and returns an
`ApiKeyActor`. The route hands `actor.organizationId` to the external Projects
service, which reuses the tenant-scoped `ProjectRepository`.

### Why the external API does not accept an organization id
Because the API key *is* the tenant scope. Accepting an org id would let a client
name a tenant — introducing cross-tenant probing and mismatch-handling surface for
zero benefit. Deriving the tenant solely from the key makes cross-tenant access
structurally impossible.

### Why API keys are not user sessions and do not impersonate users
A key authenticates as a `machine actor` with only its own scopes — no user id, no
membership, no permissions. It cannot call user routes, cannot act "as" its
creator, and survives independently of any session. Revoking a key does not touch
the creator's sessions, and revoking the creator's sessions does not disable the
key. The two credential systems share nothing but the `security_events` audit sink.

---

## E. Known Limitations

- **Read-only external API.** Only `GET /v1/external/projects`. No external
  create/update/delete, no other resources, no SDK, no published OpenAPI.
- **No rotation, reveal, or update endpoint.** A compromised key is revoked and a
  new one created. The raw secret is shown once and never again.
- **No advanced/custom scope editor; one scope (`projects:read`).** The scope set
  is code-defined and flat by design.
- **No web demo API key UI.** All behavior is backend-enforced and exercised
  through tests; there is no page to manage keys.
- **Management ops require `api_keys_access`.** After a plan downgrade an
  organization cannot list/revoke its existing keys until re-entitled (the keys
  are already non-authenticating). Acceptable per spec; revisit if a "manage keys
  while downgraded" need arises.
- **Quota race window.** `requireApiKeyCreationQuota` reads the active count and
  then writes without a serializing lock across the count+insert, so two
  simultaneous creates at the ceiling could both pass the check (the DB has no
  per-org key-count constraint). The window is small and the worst case is one
  key over quota; it self-corrects on the next create. A locking/transactional
  count is deferred (the same posture as the Sprint 7 project/member quotas).
- **`last_used_at` is throttled (approximate).** ≤ 1 write per
  `API_KEY_LAST_USED_THROTTLE_SECONDS` (default 60) per key; failed/revoked/expired
  auth never updates it.
- **Rate limiting fails open.** A Redis outage disables external throttling (never
  auth correctness; quota and key validation never consult Redis). Redis remains
  required for `/ready`.

---

## F. Next Sprint Handoff

Sprint 8 is **complete and ready to build on**. A future sprint can safely add:

- **More external read endpoints** — copy `external-projects.*`: authenticate via
  the key authenticator with a `requiredScope`, read the tenant from the actor,
  reuse a tenant-scoped repository. The pattern is established.
- **A `projects:write` scope and write-enabled external API** — add the scope to
  the enum; the authenticator already gates on a passed scope. (Out of scope for
  v1.)
- **Key rotation / a management UI** — the lifecycle columns and events exist; a
  rotation endpoint would create a successor and revoke the predecessor without a
  schema change.
- **An audit-log read API** — `api_key.created` / `api_key.revoked` and the
  failed-auth security events already accumulate on the organization-scoped
  `security_events` seam, awaiting a permission-gated (`audit_events.read`) reader.
- **A transactional quota count** — if the small create-time race becomes relevant,
  serialize the count+insert under a per-organization lock.
