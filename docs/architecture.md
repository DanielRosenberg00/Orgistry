# Architecture Overview

The current shape of the Orgistry system. This reflects the implementation as of
the latest sprint and supersedes any architecture statements in earlier
per-sprint documents (those remain as historical records).

## What Orgistry is

A runnable, fully typed **pnpm monorepo** implementing the backbone of a
multi-tenant SaaS identity and access platform: accounts and sessions,
organizations and memberships, fixed RBAC, plans/entitlements/quotas, an
organization-scoped resource (Projects), machine API keys with a read-only
external API, the invitation lifecycle, and an organization-scoped audit log read
API — plus a thin React admin demo that consumes those APIs.

The central chain the system builds and enforces:

```
User → Organization → Membership → Role → Permission → Entitlement → Quota
     → Organization-Scoped Resource
```

## Monorepo structure

```
apps/
  api/        Fastify HTTP API — the source of truth
  web-demo/   React/Vite admin demo — a thin official API consumer
packages/
  config/     Typed, Zod-validated runtime configuration (single source)
  contracts/  Frozen API contracts: envelopes, error codes, DTOs, pagination
  shared/     Low-level primitives: prefixed IDs, request IDs, cursors, env loader
  auth-core/  Security primitives: Argon2id, JWT, opaque-token hash, redaction
  db/         Drizzle schema, migrations, client factory, guarded test reset
infra/        Docker Compose: PostgreSQL, Redis, Mailpit
tooling/      Validation helpers (schema-drift check, demo seed)
docs/         Authoritative + historical documentation
```

Internal `@orgistry/*` packages are consumed as **TypeScript source** — no build
step. `tsx`, Vite, Vitest, and `tsc` pick up edits directly.

## App and package responsibilities

- **`apps/api`** — the only authority. Fastify app with health/readiness,
  request-ID propagation, structured JSON logging, central error handling, and
  consistent response envelopes. Organized into modules (`auth`, `organization`,
  `rbac`, `projects`, `entitlements`, `api-keys`, `invitations`, `audit`), each
  owning its routes/service/repository and composing the shared access-control
  helpers.
- **`apps/web-demo`** — a deliberately thin client (see [below](#web-demo-as-a-thin-consumer)).
- **`packages/contracts`** — the stable interface boundary. Request/response DTOs
  and the error-code catalog live here so the API and web demo share one typed
  contract. Changing a contract is a reviewed change.
- **`packages/config`** — the single validated source of runtime config; fails
  loudly at startup on invalid/missing values. Never reads files on import.
- **`packages/auth-core`** — pure security primitives with no HTTP/DB concerns.
- **`packages/shared`** — ID/cursor/request-ID/clock helpers; the Node-only
  `@orgistry/shared/node` subpath holds the `.env` loader.
- **`packages/db`** — Drizzle schema registry, migration baseline, connection
  factory, and the guarded test-database reset.

## API as the source of truth

All authorization, entitlement, quota, and tenancy decisions are made in the
API. Clients (the web demo, external API-key callers) never hold authority: they
present credentials and receive authoritative results and errors. Permission-
aware UI in the web demo is a usability hint computed from the caller's effective
permissions — it never gates anything the backend wouldn't.

## Web demo as a thin consumer

`apps/web-demo` is an official, thin React/Vite admin UI. It:

- holds access tokens **in memory only** (never `localStorage`);
- restores sessions via the HttpOnly refresh cookie at boot, with single-flight
  silent refresh on `401`;
- unwraps the response envelope into typed data or a typed `ApiError`;
- renders permission-aware controls as hints while relying on backend errors
  (`FORBIDDEN`, `ENTITLEMENT_REQUIRED`, `QUOTA_EXCEEDED`) for truth;
- reads its API base URL and CSRF header name from `VITE_*` env at build/dev time.

Surfaces: login/register, organization switcher, overview, members, invitations,
projects, plan & entitlements, API keys, audit log. See [web-demo](./web-demo.md).

## Database model overview

PostgreSQL via Drizzle ORM. Tables (all with prefixed string IDs, e.g. `user_`,
`org_`, `prj_`):

- **Auth**: `users`, `sessions`, `refresh_tokens` (hash-only, family-tracked),
  `email_verification_tokens`, `security_events`.
- **Organization/RBAC**: `roles` (4 fixed), `organizations`, `memberships`
  (partial-unique on active `(user, org)`), `permissions` (catalog),
  `role_permissions` (matrix).
- **Resources/entitlements**: `projects` (soft-delete), `plans` (Free/Pro/
  Business catalog), `organization_plans` (one per org), `api_keys` (hash-only
  secret, scopes), `invitations` (hash-only token, one pending per email).
- **Meta**: `app_meta` key/value.

Seeds (roles, permissions, the role→permission matrix, the plan catalog) are
embedded in migrations and derived from `@orgistry/contracts` with deterministic
IDs and `ON CONFLICT DO NOTHING`, so they are idempotent and drift-free. Schema
drift is caught by `pnpm db:check` (see [validation](./validation.md)).

## Authentication and session model

Argon2id passwords; short-lived JWT access tokens; an opaque, hash-only refresh
token delivered only via an HttpOnly SameSite=Lax cookie. Refresh rotates
transactionally with reuse detection that revokes the whole token family and
session. Cookie-backed mutations require a custom CSRF header; auth surfaces are
Redis rate-limited (fail-open). Full detail in the [security model](./security-model.md),
[auth](./auth-foundation.md), and [sessions](./session-lifecycle.md).

## Organization and membership model

Registration provisions the user's **personal workspace** (organization + active
Owner membership) atomically with the account/session. Authenticated users create
team organizations and see only orgs where they hold an active membership.
Authorization keys on the organization **ID**, never the slug. A reusable
organization-context resolver is the seam every org-scoped route builds on.

## RBAC / access-control model

Four fixed roles (Owner/Admin/Member/Viewer) map to a code-defined permission
catalog. Routes compose `requireMembership → requirePermission(actor, "<key>")` —
**permission is the authorization primitive**, never a role-name check. The sole
exception is the **Last Owner** invariant, enforced transactionally. See
[RBAC](./rbac-permissions.md).

## Entitlements / quotas model

Three orthogonal concepts kept strictly separate: **permission** (may the user),
**entitlement** (does the plan unlock it), **quota** (is there capacity). Fixed
demo plans carry the values; an organization-level entitlement resolver maps plan
→ values (fail-safe, role-independent); reusable `requireEntitlement` /
`requireQuota` helpers enforce them after the permission check. No billing. See
[entitlements](./entitlements-plans-quotas.md).

## Project resource pattern

Projects are the canonical organization-scoped resource and the template for
future ones: every query scoped by route org ID, authorization via
membership+permission, cursor-paginated list, soft delete, and an
indistinguishable `404` for cross-tenant/deleted targets. See [projects](./projects.md).

## API key / machine-access model

Organization-scoped machine credentials (not user sessions). Hash-only secret
shown once; typed scopes (`projects:read`); entitlement- and quota-gated creation.
The external `GET /v1/external/projects` derives its tenant from the key (no org
ID in the route, no JWT), re-checks the entitlement per request, and applies
per-key/per-org rate limits. See [API keys](./api-keys-external-api.md).

## Invitation lifecycle model

Single-use, expiring, hash-only-token invitations for one email to join one org
with one fixed role. Reservation quota (`active members + pending ≥ max_members`),
fail-closed email send before persistence, email-match enforcement on acceptance,
and a single transactional acceptance seam shared by existing-user accept and
registration-with-invitation. Invitations create memberships, never sessions. See
[invitations](./invitations.md).

## Audit log read model

A permission- and entitlement-gated, cursor-paginated, filterable read over the
organization action events recorded on the internal event seam. Internal event
names map to a stable public catalog; metadata is defensively sanitized (safe IDs
survive; secrets/tokens/headers/PII do not); auth/session security events are
excluded from the default stream; retention is display-only. See [audit](./audit-log.md).

## Event model

Domain actions (project/member/invitation/API-key/plan lifecycle) are recorded on
an internal event seam (the `security_events` table, with `actor_type`
distinguishing user/system/anonymous/api_key). Action events are conceptually
distinct from authentication/security events even though they share the table.
The audit read API is the only public projection of the action subset.

## Validation and testing approach

- **Offline gate** (`pnpm validate`): typecheck, ESLint, unit tests, web tests,
  web build, schema-drift check, whitespace check — no services required.
- **Integration gate** (`pnpm validate:integration`): test-DB reset plus DB
  migration-from-scratch and live API readiness/route tests against PostgreSQL +
  Redis.
- **CI** mirrors both as separate jobs. Mailpit/SMTP is exercised manually, not in
  CI. Full detail in the [validation matrix](./validation.md).

## Key design decisions and trade-offs

- **API is the only authority; the web demo is intentionally thin.** Keeps
  authorization in one place and makes the client safe to treat as untrusted.
- **Permission / entitlement / quota are separate axes.** Correct error
  attribution and a clean path to future billing without reworking authorization.
- **Internal packages as source, not built artifacts.** Faster iteration, one
  TypeScript graph; the trade-off is consumers must use TS-aware tooling.
- **Fixed roles and demo plans, no billing/RLS/workers.** Deliberate scope
  boundary for a reference foundation; see [known limitations](./known-limitations.md).
- **Soft deletes and derived expiry over background jobs.** Avoids a worker/queue
  runtime at the cost of not reclaiming storage or enforcing retention.
