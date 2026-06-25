# Audit Log Read API (Sprint 10)

Orgistry's organization-scoped, read-only Audit Log API. It exposes the
**organization action events** that producers across Sprints 5–9 already write to
the internal `security_events` seam, behind a permission- and entitlement-gated
surface, with cursor pagination, safe filters, defensive metadata sanitization,
and retention-policy metadata.

This sprint is **read-only and additive**. It introduces **no new event system**,
**no schema changes**, and **no migration** — it adds a query boundary, a public
DTO/mapping layer, a service that composes policy, and one route.

```
GET /v1/organizations/:organizationId/audit-events
```

---

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Public audit DTOs, actor/target summaries, list query + response, metadata schema, event catalog | `packages/contracts/src/audit.ts` |
| Public/persisted event mapping + target-type map + persisted allowlist | `apps/api/src/modules/audit/audit.catalog.ts` |
| Read repository boundary types + normalized record | `apps/api/src/modules/audit/audit.types.ts` |
| DTO shaping + read-time metadata sanitization + honest actor/target derivation | `apps/api/src/modules/audit/audit.mapper.ts` |
| Drizzle-backed tenant-scoped read repository over `security_events` | `apps/api/src/modules/audit/audit.repo.ts` |
| Service (membership → permission → entitlement → retention → query → shape) | `apps/api/src/modules/audit/audit.service.ts` |
| Route (single GET surface; thin handler) | `apps/api/src/modules/audit/audit.routes.ts` |
| `requireAuditLogAccess` entitlement gate | `apps/api/src/modules/entitlements/entitlement.service.ts` |
| In-memory read repo + test app builder | `apps/api/src/modules/audit/testing/*` |
| Service wiring | `apps/api/src/server.ts`, `apps/api/src/app.ts` |

No new error codes, tables, columns, indexes, or migrations were added.

### How it works

The request flows through one fixed pipeline, owned by the **service**
(`apps/api/src/modules/audit/audit.service.ts`):

```
authenticate (Bearer)                         ← route (auth boundary)
  → requireMembership(org)                     → OrganizationActor
    → requirePermission(audit_events.read)     → 403 FORBIDDEN if missing
      → requireEntitlement(audit_log_access)   → 403 ENTITLEMENT_REQUIRED if missing
        → resolve audit_retention_days         → response metadata (display-only)
          → repository.listAuditEvents(org, …)  → tenant-scoped keyset query
            → sanitize metadata + shape DTOs    → mapper (never a raw row)
              → cursor-paginated success envelope
```

The **repository** is a pure query boundary: it requires an organization id,
scopes every query by it, restricts to the auditable persisted event names the
service supplies, applies the validated filters and keyset pagination, and
returns **normalized records** — never raw Drizzle rows, and never the
`security_events` columns the API does not expose (`ip_address`, `user_agent`,
`session_id`). It owns no permission or entitlement policy and mutates nothing.

The **mapper** turns a normalized record into the public `AuditEvent`: it
re-sanitizes metadata at read time (defense in depth), maps the persisted event
name to its public type, and derives safe actor/target summaries.

### How to extend it safely

- **Add a new auditable event type**: add the public name to `AUDIT_EVENT_TYPES`
  (`packages/contracts/src/audit.ts`), then add the public→persisted entry and
  the public→target-type entry in `audit.catalog.ts`. The persisted name must
  match the producing module's event name. The catalog is the single source of
  truth; the reverse map and the allowlist derive from it.
- **Add a new filter**: extend `auditListQuerySchema` (validation lives in the
  contract), thread it through `ListAuditEventsInput` → `ListAuditEventsParams`,
  and implement it in **both** repositories (DB + in-memory) so behavior stays
  identical. Keep filters index-conscious — prefer the indexed `event_type` /
  `created_at` columns over JSON extraction.
- **Never** widen the repository to accept a query without an organization id,
  and never move permission/entitlement checks into it.

---

## B. Architectural Notes

### Key design decisions

1. **Expose existing events; do not redesign ingestion.** Since Sprint 5, every
   organization action (member, project, plan, API key, invitation) has been
   written to the `security_events` table inside the mutation's transaction. That
   table already carries `organization_id`, sanitized `metadata`, `request_id`,
   `actor_type`, and a dotted `event_type`. Sprint 10 reads that seam. Rewriting
   producers or building a parallel event store would be churn with no behavioral
   benefit and real migration risk.

2. **A thin public/persisted mapping layer.** Most persisted names are already
   the public names; the member-management events are the exception (they carry
   an internal `org.` prefix). Rather than rename historical producers (a
   breaking change to existing rows and tests), the catalog maps
   `org.member_role_changed → member.role_changed` and `org.member_removed →
   member.removed`. The public API is therefore stable and decoupled from
   storage names.

3. **The catalog is the action/security boundary, in code.** The repository only
   ever matches the **allowlist** of auditable persisted names. Authentication /
   session security events (`auth.*`) and API-key failed-auth security events
   (`api_key.auth_*`, `api_key.rate_limit_exceeded`) are absent from the catalog,
   so they can never appear in the default audit stream — even if a future
   producer attributes one to an organization.

4. **`targetType` filtering by event-type set, not JSON.** A persisted event's
   target kind is fully determined by its event type. So filtering by
   `targetType` translates to "the set of event types with that target kind" and
   filters the **indexed** `event_type` column — never a JSON predicate. (Member
   events store no `targetType` key in metadata, so a JSON predicate would also
   be incorrect, not just slow.)

5. **Independent permission and entitlement gates.** `audit_events.read` is a
   user capability (role→permission); `audit_log_access` is an organization plan
   property. They are checked separately and both must pass — mirroring the
   Sprint 8 API-key model (`requireApiKeysAccess`).

### Tradeoffs

- **Reusing `security_events` for both action and security events.** The physical
  table is shared (an implementation detail inherited from Sprints 5–8). The cost
  is that the read path must enforce the boundary via an allowlist; the benefit
  is zero schema churn and a single, transactionally-consistent write seam.
- **`targetId` filtering uses a bounded metadata OR.** Target ids live in
  type-specific metadata keys (`targetProjectId`, `targetKeyId`, …), not a
  column. The `targetId` filter matches the value across that fixed key set. It
  is not index-backed; it is bounded (no free-text search) and documented.
- **In-memory test repo synthesizes id/createdAt for producer events.** Producer
  fakes push events without an id/timestamp; the in-memory read repo synthesizes
  deterministic, monotonic values from insertion order. Tests needing precise
  control seed events with explicit `id`/`createdAt`.

### Constraints respected

- Organization id comes only from the route — never the request body.
- No raw persistence row crosses the boundary; secrets never appear in metadata.
- No schema change, no migration, no mutation of event data on the read path.

### Rejected alternatives

- **Renaming the member events to drop the `org.` prefix.** Rejected: it would
  rewrite historical rows / producers and break existing tests for no public
  benefit. The mapping layer is cheaper and reversible.
- **A dedicated `audit_events` table + backfill.** Rejected: redesigns ingestion,
  needs a migration and a dual-write or backfill, and contradicts the sprint's
  "expose existing events" objective.
- **Mixing security events into the stream with a `category` discriminator.**
  Rejected for v1: `auth.*` events are user/session-scoped and not safely
  organization-attributed. The `category` field exists and is reserved, so a
  future sprint can add `security` without a breaking change.

---

## C. Contracts & Invariants

### Route

`GET /v1/organizations/:organizationId/audit-events` — Bearer-authenticated.

### Query parameters (`auditListQuerySchema`)

| Param | Type | Notes |
| --- | --- | --- |
| `cursor` | opaque string | From a previous page's `nextCursor`. Malformed → `400 BAD_REQUEST`. |
| `limit` | int | Default **20**, max **100**. Out of range → `400 VALIDATION_ERROR`. |
| `eventType` | public event type | One of `AUDIT_EVENT_TYPES`. |
| `actorType` | `user \| api_key \| system \| unknown` | |
| `targetType` | `membership \| project \| plan \| api_key \| invitation \| organization \| unknown` | |
| `actorId` | string | Acting user id (optional filter). |
| `targetId` | string | Target id, matched across known metadata keys (optional filter). |
| `createdAfter` / `createdBefore` | ISO-8601 | Inclusive time bounds. |

Invalid filter values return `400 VALIDATION_ERROR`. Filters never widen
organization scope; the route org id is applied independently and always.

### Response shape (`auditListResponseSchema`, standard success envelope)

```jsonc
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "sevt_…",
        "organizationId": "org_…",
        "type": "project.created",        // public event type
        "category": "action",             // v1 always "action"
        "actor": {
          "type": "user",                 // user | api_key | system | unknown
          "userId": "user_…",             // null unless a user actor
          "membershipId": "mem_…",        // null when unknown
          "apiKeyId": null,               // set only for api_key actors
          "label": null
        },
        "target": {
          "type": "project",              // membership|project|plan|api_key|invitation|organization|unknown
          "id": "prj_…",                  // null when the kind has no discrete id (e.g. plan)
          "label": null                   // e.g. the new plan key for plan changes
        },
        "metadata": { "name": "Launch" }, // sanitized; never secrets/tokens/hashes/cookies/headers/bodies
        "requestId": "req_…",             // when recorded
        "createdAt": "2026-06-25T00:00:00.000Z"
      }
    ],
    "nextCursor": null,                    // null when there are no more
    "hasMore": false,
    "meta": { "auditRetentionDays": 90 }   // display-only (see Retention)
  }
}
```

Errors use the standard error envelope and include the request id (echoed on the
`x-request-id` response header via the central error handler).

### Actor summary semantics

- Supported types: `user`, `api_key`, `system`, `unknown`. The persisted
  `anonymous` actor maps to public `unknown`.
- Identity is read from **safe fields only**: a user actor exposes `userId` and
  the actor's `membershipId` (when present in metadata); an api_key actor exposes
  the safely-resolved `apiKeyId`. Fields that do not apply are `null`.
- The reader **never invents identity**. An unattributed/incomplete event stays
  `unknown`; malformed external-key attempts carry no token-derived identifiers
  (the producers never persist them).

### Target summary semantics

- Supported types: `membership`, `project`, `plan`, `api_key`, `invitation`,
  `organization`, `unknown`. The persisted `organization_plan` target maps to
  public `plan`.
- `id` is the opaque target id resolved from the type's metadata key, or `null`
  when the kind has no discrete id (a plan change targets the org plan; an
  organization target is the tenant itself).
- `label` is an optional non-secret display string (the new plan key for a plan
  change). No secret-bearing target metadata is ever exposed.

### Pagination contract

- Cursor pagination only — **no offset**. Default limit 20, max 100.
- Ordering is **`created_at DESC, id DESC`** — total and stable (`id` breaks
  `created_at` ties). The cursor encodes the sort position `{createdAt, id}`, not
  a page number.
- The repository fetches `limit + 1` to compute `hasMore`/`nextCursor`. Pages
  never duplicate or skip events.
- A malformed cursor fails predictably with `400 BAD_REQUEST`.

### Permission & entitlement

- Permission: **`audit_events.read`** (Owner and Admin in the v1 role matrix).
- Entitlement: **`audit_log_access`** (granted by the Pro and Business demo plans;
  the default Free plan does not grant it → `403 ENTITLEMENT_REQUIRED`).
- The two are enforced independently; both must pass.

### Retention metadata behavior

`meta.auditRetentionDays` is the organization plan's modeled retention window
(Free 0, Pro 30, Business 90). It is **display-only** — see
[§E](#e-known-limitations).

#### Field-name convention: `auditRetentionDays` (DTO) vs `audit_retention_days` (policy key)

There are two distinct names for the same value, and the distinction is
deliberate:

| Name | Casing | What it is | Where it appears |
| --- | --- | --- | --- |
| `audit_retention_days` | snake_case | The **entitlement / policy key** in `ENTITLEMENT_KEYS` (and the `entitlements` map of the plan endpoints) | `packages/contracts/src/plans.ts`, the `…/entitlements` and `…/plan/demo` responses |
| `auditRetentionDays` | camelCase | The **public DTO field** carrying that value in the audit response `meta` | `packages/contracts/src/audit.ts`, the `…/audit-events` response |

This repo's public **DTO response fields are uniformly camelCase**
(`organizationId`, `nextCursor`, `createdByUserId`, `expiresAt`, …). The only
snake_case keys in any response are the **entitlement policy keys** themselves
(`max_members`, `audit_log_access`, `audit_retention_days`), which are surfaced
verbatim as the `ENTITLEMENT_KEYS` namespace inside an `entitlements: { … }` map.
The audit `meta` is an ordinary DTO container, so its field follows the dominant
DTO convention (`auditRetentionDays`); naming it `audit_retention_days` would make
it the **only** snake_case field in any non-entitlement response container, a new
inconsistency. The Sprint 10 policy name (`audit_retention_days`) is the
entitlement key the value is *resolved from*; the DTO field is the camelCase
surfacing of it. Tests assert the actual public field name (`meta.auditRetentionDays`).

### Things that must not change without migration/review

- The public event-type names in `AUDIT_EVENT_TYPES` (clients branch on them).
- The persisted→public mapping in `audit.catalog.ts` (must track producer names).
- The `created_at DESC, id DESC` ordering and the cursor payload shape.
- The action/security boundary (the catalog allowlist).

---

## D. Integration Notes

The audit read API is a consumer of systems built in earlier sprints; it changes
none of them.

- **Organizations / memberships**: the route org id is the tenant authority
  boundary; `requireMembership` (Sprint 4/5) resolves the actor and yields a
  uniform `ORGANIZATION_NOT_FOUND` for non-members, so non-members cannot probe.
- **RBAC**: authorization is by the `audit_events.read` permission key via
  `requirePermission` — never by role name.
- **Entitlements / plans**: `requireAuditLogAccess` and `resolveAuditEntitlements`
  (Sprint 7) gate access and supply the retention value; a plan downgrade
  immediately disables audit reads.
- **Event producers (Sprints 5–9)**: members, projects, plans, API keys, and
  invitations write action events to `security_events` inside their mutations.
  Audit read maps those persisted names to public types. Producers are unchanged.
- **API keys**: the **management** key-lifecycle actions (`api_key.created` /
  `api_key.revoked`) are auditable. API-key **failed-auth security events** are
  not. The external API-key surface has **no** access to the audit log.
- **Future web demo admin surfaces**: this backend API is the seam a future
  audit UI would call. No UI ships in Sprint 10.

---

## E. Known Limitations

Sprint 10 deliberately does **not** implement:

- audit UI / web demo audit page
- export (incl. CSV) / webhook delivery / SIEM integration
- alerting / analytics dashboard / compliance reports
- retention **deletion**, retention **enforcement**, or any background cleanup job
- cross-organization audit search / admin superuser audit surface
- event ingestion redesign / rewrite of producers / immutable ledger / event
  signing / event replay
- a user/session-wide security event console
- API-key access to audit logs / an external audit API
- full-text search / an advanced query language
- billing/Stripe, workers/queues, deployment automation

Also explicitly:

- **Retention is display-only.** `auditRetentionDays` reflects plan policy; no
  events are deleted and no age limit is enforced. The value can exceed or differ
  from the age of returned data.
- **Security events are excluded** from the default stream per the chosen v1
  boundary; only organization action events are returned. The `category` field is
  reserved (`action` only in v1) so a future, safely-attributed security stream
  can be added without a breaking change.
- **Actor attribution may be `unknown`** when event data is incomplete; identity
  is never fabricated.
- **Metadata is sanitized defensively** at read time (see below), in addition to
  the write-time sanitization producers already apply.

### Metadata sanitization

Returned `metadata` passes through `sanitizeSecurityMetadata`
(`apps/api/src/lib/security-metadata.ts`) at read time — producers are not trusted
blindly. The sanitizer **recursively** drops any key whose lowercased name
contains a sensitive substring, handling nested objects, arrays, mixed casing,
null, and primitive values, and bounding depth and string length.

**Blocked (dropped entirely, never masked in place):**

- Secret-bearing substrings: `password`, `token`, `secret`, `authorization`,
  `cookie`, `hash`, `credential`, `otp`, `apikey` / `api_key`. This covers raw
  tokens, token hashes, passwords, password hashes, refresh tokens, **API key
  secrets/hashes/raw values** (`apiKeySecret`, `apiKeyHash`, `apiKeyValue`,
  `apiKeyToken`, `apiKeyCredential`), invitation tokens/hashes, Authorization
  headers, cookies, and any full request body nested under a sensitive key.
- Request-correlation identifiers: `ipaddress`, `useragent`, `sessionid`. These
  are not secrets but are surfaced (when at all) through dedicated columns/DTO
  fields, never freeform metadata, so they are denylisted defensively. (They are
  also excluded **structurally**: the read repository never selects the
  `ip_address`, `user_agent`, or `session_id` columns.)

**Preserved — safe opaque identifiers vs secret-bearing API key material.** A
substring denylist alone would wrongly drop `apiKeyId` (it contains `apikey`)
even though it is just an opaque `key_…` id the actor/target summaries need. So
the sanitizer keeps an **exact-match allowlist** of safe identifier keys
(`SAFE_IDENTIFIER_KEYS`) that wins over the denylist: `apiKeyId`,
`targetApiKeyId`, `actorApiKeyId`, `targetKeyId`, `membershipId`,
`targetMembershipId`, `actorMembershipId`, `userId` / `targetUserId` /
`actorUserId`, `projectId` / `targetProjectId`, `invitationId` /
`targetInvitationId`, `organizationId` / `targetOrganizationId`. Matching is
**exact**, so `apiKey` (a raw secret) and `apiKeySecret` are still dropped — only
the precise id keys survive, never a secret that merely shares a prefix. This is
why `api_key.created` / `api_key.revoked` keep a usable `target.id` while their
secrets never appear.

The mapper adds **no synthetic keys** — there is no internal `__persistedType` or
mapping marker in the output; `metadata` is exactly the producer's safe fields
after sanitization. The non-secret structural fields the mapper reads
(`actorMembershipId`, `targetType`, `target*Id`) may also remain in `metadata`.
