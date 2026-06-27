# Orgistry — Portfolio Case Study

A technical case study of Orgistry: what it is, why it exists, the decisions
behind it, and what it demonstrates about engineering maturity. It is written for
an engineer evaluating the work, not as marketing. Orgistry is an **engineering
reference / portfolio project** — type-checked, linted, unit- and
integration-tested, but **not production-certified** (see
[known limitations](./known-limitations.md)).

For a fast, command-by-command review path, see the
[evaluation guide](./evaluation-guide.md). For system shape, see the
[architecture overview](./architecture.md).

## Problem statement

Every B2B SaaS rebuilds the same identity and access backbone before it can ship
a single feature: accounts, sessions, organizations, memberships, roles and
permissions, plan gating, quota enforcement, machine credentials, invitations,
and an audit trail. This layer is **tedious to get right and dangerous to get
wrong** — a missed tenant scope leaks another customer's data, a role-name check
where a permission check belonged becomes an authorization bug, a refresh token
without rotation becomes a session-hijack vector.

Orgistry is a worked, end-to-end reference for that backbone: small enough to
read in an afternoon, strict about its invariants, and explicit about its scope.
It is the part of a product that is normally invisible, built so it can be
inspected.

## Target users (of the reference)

- **Engineers** designing or reviewing a multi-tenant access layer who want a
  concrete, reviewable example rather than a framework to adopt wholesale.
- **Reviewers / collaborators** evaluating engineering judgment: how boundaries
  are drawn, how authorization is structured, how trade-offs are made explicit.
- **The author**, as a demonstration of building a non-trivial system to a
  consistent standard end to end — including the parts (validation, docs,
  honesty about scope) that are easy to skip.

It is **not** a library to `npm install`, and not a product for real users.

## Why SaaS identity/access foundations are hard

- **Tenant isolation is a default-deny problem.** Correctness means *every*
  organization-scoped query is keyed on a trusted identifier. One unscoped query
  is a cross-tenant leak. Orgistry keys every such query on the route
  **organization ID** (never the user-supplied slug) and returns an
  indistinguishable `404` across tenant boundaries so existence never leaks.
- **Authorization has three distinct axes that are easy to conflate.** "May this
  user act?" (permission), "does this plan unlock the feature?" (entitlement),
  and "is there capacity?" (quota) are different questions with different correct
  failure codes. Collapsing them produces misleading errors and tangled logic.
- **Sessions are a stateful security surface.** Short-lived access tokens, an
  opaque hash-only refresh credential, transactional rotation, reuse detection,
  CSRF defense, and revocation all have to compose without a gap.
- **Machine access is not a user session.** API keys must be tenant-scoped,
  hash-only, one-time-secret, and authorized by scope rather than by
  impersonating a user.
- **Onboarding crosses a trust boundary.** An invitation hands a capability to
  someone who may not yet have an account, so the token must be single-use,
  expiring, hash-only, email-matched, and never logged.

Each of these is individually well understood; the difficulty is composing all
of them coherently, with one authority and no contradictions.

## Product scope (what is implemented)

The whole system is organized around one chain, enforced server-side:

```
User → Organization → Membership → Role → Permission → Entitlement → Quota
     → Organization-Scoped Resource
```

Implemented surface:

- **Auth & sessions** — Argon2id passwords, short-lived JWT access tokens, an
  opaque hash-only refresh token in an HttpOnly SameSite=Lax cookie,
  transactional rotation with reuse detection, logout, session list/revoke, CSRF
  defense, Redis-backed rate limiting.
- **Organizations & memberships** — a personal workspace auto-provisioned at
  registration, team organizations, ID-based tenant isolation, membership model.
- **Fixed RBAC** — four roles (Owner/Admin/Member/Viewer) over a code-defined
  permission catalog, permission-first authorization, effective permissions, a
  transactional Last Owner invariant.
- **Plans, entitlements & quotas** — fixed demo plans (Free/Pro/Business) with
  strictly separated permission / entitlement / quota checks. No billing.
- **Projects** — the canonical organization-scoped resource (soft delete, cursor
  pagination, uniform cross-tenant `404`).
- **API keys & external API** — organization-scoped machine credentials
  (hash-only, one-time secret, typed scopes) and a read-only, tenant-derived
  `GET /v1/external/projects`.
- **Invitations** — single-use, expiring, hash-only-token invitations with local
  email delivery (Mailpit) and email-match enforcement.
- **Audit log** — a permission- and entitlement-gated, filterable read over
  sanitized organization action events.
- **Web demo** — a thin React/Vite admin UI that consumes these APIs and holds no
  authority of its own.

The complete route list is the [API surface index](./api-surface.md); the
deliberate non-goals are in [known limitations](./known-limitations.md).

## Architecture overview

A fully typed **pnpm monorepo**. The API is the only authority; everything else
is either a contract, a primitive, or a consumer.

```
apps/
  api/        Fastify HTTP API — the source of truth
  web-demo/   React/Vite admin demo — a thin official API consumer
packages/
  config/     Typed, Zod-validated runtime configuration
  contracts/  Frozen API contracts: envelopes, error codes, DTOs, pagination
  shared/     Primitives: prefixed IDs, request IDs, cursors, env loader
  auth-core/  Security primitives: Argon2id, JWT, opaque-token hashing
  db/         Drizzle schema, migrations, client, guarded test reset
infra/        Docker Compose: PostgreSQL, Redis, Mailpit
tooling/      Schema-drift check, demo seed
```

Internal `@orgistry/*` packages are consumed as **TypeScript source** (no build
step), so there is a single type graph and edits are picked up directly by `tsx`,
Vite, Vitest, and `tsc`. Full detail: [architecture overview](./architecture.md).

## Key technical decisions

- **The API is the single authority.** All authorization, entitlement, quota, and
  tenancy decisions are made server-side. Clients present credentials and receive
  authoritative results; they never hold authority. This makes the web demo and
  any external caller safe to treat as untrusted, and keeps the rules in one
  reviewable place.
- **Contracts as a frozen boundary.** Request/response DTOs and the error-code
  catalog live in `@orgistry/contracts`, shared by the API and the web demo, so a
  contract change is a deliberate, reviewed change rather than drift between two
  hand-maintained copies.
- **Seeds derived from contracts, embedded in migrations.** Roles, permissions,
  the role→permission matrix, and the plan catalog are generated from the
  contracts source with deterministic IDs and `ON CONFLICT DO NOTHING`, so they
  are idempotent and drift-free. `pnpm db:check` fails the build if the committed
  migrations diverge from the schema.
- **Config validated once, loudly, at startup.** `@orgistry/config` parses the
  environment through a Zod schema and fails fast on invalid or missing values,
  so misconfiguration surfaces at boot, not mid-request.
- **Internal packages as source, not artifacts.** Faster iteration and one type
  graph; the accepted trade-off is that consumers must use TS-aware tooling.

## Security decisions

Orgistry is a **non-production reference**; the mechanisms are deliberately real
and reviewable. Highlights (full model: [security model](./security-model.md)):

- **Hash-only secrets everywhere they matter.** Passwords (Argon2id), refresh
  tokens, API key secrets, and invitation tokens are stored as hashes only. Raw
  API key and invitation secrets are shown/sent exactly once and are
  unrecoverable afterward.
- **Refresh rotation with reuse detection.** Refresh rotates transactionally —
  exactly one successor per token. Presenting an already-rotated token revokes
  the entire token family and its session.
- **CSRF off the correctness path.** Cookie-backed mutations require a custom
  header that a cross-site attacker cannot set without a CORS preflight the strict
  origin allow-list denies. The defense never gates auth correctness.
- **Tenant isolation in the application layer.** Every org-scoped query keys on
  the route organization ID; cross-tenant access is an indistinguishable `404`.
  (No database RLS — a documented, deliberate boundary.)
- **Defensive audit sanitization.** The audit read strips secrets, hashes,
  tokens, headers, cookies, and PII, keeping only safe opaque IDs; auth/session
  security events are excluded from the default stream.

## Permission vs entitlement vs quota

The distinction that most cleanly separates "access logic" in this codebase:

| Axis | Question | Source | Failure code |
| --- | --- | --- | --- |
| **Permission** | May this user perform this action? | Role → permission catalog (RBAC) | `FORBIDDEN` |
| **Entitlement** | Does this org's plan unlock this feature? | Plan → entitlement resolver | `ENTITLEMENT_REQUIRED` |
| **Quota** | Is there remaining capacity? | Plan → quota values | `QUOTA_EXCEEDED` |

They are checked in that order (permission → entitlement → quota), so a failure is
**attributable** to exactly one cause. Keeping them as separate axes also means a
future billing layer can change entitlements/quotas without touching
authorization. Enforcement order is documented at the bottom of the
[API surface index](./api-surface.md).

## Machine access / API key model

API keys are **organization-scoped machine credentials, not user impersonation**.
A raw key (`orgistry_<displayId>_<secret>`) is shown once at creation; only a
display prefix and a SHA-256 `secret_hash` are stored. Keys carry typed scopes
(v1 ships `projects:read`). The external endpoint `GET /v1/external/projects`
takes **no organization ID** (the tenant is derived from the key row) and accepts
**no browser JWT**; it authorizes by scope, re-checks the `api_keys_access`
entitlement on every request, and applies per-key/per-org rate limits. This keeps
machine access a first-class, separately-authorized path rather than a user
session in disguise. Detail: [API keys & external API](./api-keys-external-api.md).

## Invitation onboarding model

An invitation is single-use, expiring, and stored hash-only; the raw token is
delivered **only** in the invitation email (SMTP → Mailpit) and carried in request
bodies, never URLs, so it is never logged. Acceptance enforces an **email match**
between the invited address and the accepting account, and a single transactional
acceptance seam is shared by existing-user accept and registration-with-invitation.
Accepting creates a **membership, never a session** — an invited new user still
receives their own personal workspace. Invitation creation reserves quota against
`max_members` (active members + pending) and sends email **fail-closed before**
persistence. Detail: [invitations](./invitations.md).

## Audit log model

The audit log is a **read-only projection** of organization action events recorded
on an internal event seam. The read is gated by both the `audit_events.read`
permission **and** the `audit_log_access` entitlement, cursor-paginated, and
filterable. Metadata is defensively sanitized — safe opaque IDs survive; secrets,
tokens, headers, and PII do not — and authentication/session security events are
kept out of the default action stream. The plan's `audit_retention_days` is a
display-only field: there is **no** retention deletion job and **no** export.
Detail: [audit log](./audit-log.md).

## Frontend thin-consumer pattern

`apps/web-demo` is deliberately the *opposite* of where logic usually accretes. It
holds access tokens **in memory only** (never `localStorage`), restores sessions
via the HttpOnly refresh cookie with single-flight silent refresh on `401`,
unwraps the response envelope into typed data or a typed `ApiError`, and renders
permission-aware controls as **hints** computed from the caller's effective
permissions. Those hints never gate anything the backend wouldn't: the
authoritative `FORBIDDEN` / `ENTITLEMENT_REQUIRED` / `QUOTA_EXCEEDED` errors are
the truth. The demo exists to *exercise and reveal* backend behavior, not to
re-implement it. Detail: [web demo](./web-demo.md).

## Validation approach

Two honest tiers, mirrored in CI:

- **Offline gate** (`pnpm validate`): typecheck, ESLint, unit tests, web tests,
  web build, schema-drift check, and a whitespace check — no services required,
  runs on a fresh clone, fails fast on the first problem.
- **Integration gate** (`pnpm validate:integration`): resets a dedicated **test**
  database (guarded so it can never wipe the dev DB) and runs migration-from-
  scratch plus live API readiness/route tests against PostgreSQL + Redis.

The schema-drift check is the notable piece: it regenerates migrations from the
TypeScript schema and fails if anything changed, so the committed SQL can never
silently diverge. Full matrix and failure interpretation:
[validation](./validation.md).

## Tradeoffs and limitations

Stated plainly, because honesty about scope *is* part of the engineering:

- **Not production-certified.** No deployment hardening, no monitoring, no object
  storage.
- **No billing, OAuth, MFA, password reset, or production email.** Plans are fixed
  demo plans; email is local Mailpit only.
- **No PostgreSQL RLS, custom roles, or resource-level/ABAC permissions.** Tenant
  isolation and authorization are application-layer and permission-key based.
- **No background processing.** Expiry is derived on read; nothing reclaims
  storage or enforces audit retention.
- **Accepted runtime compromises.** Quota checks have small read-then-write race
  windows; Redis rate limits fail open so an outage never breaks auth; the web
  demo is demo-quality.
- **No full browser E2E.** The web demo has jsdom component/routing tests, not a
  Playwright/Cypress suite.

The complete, authoritative list is [known limitations](./known-limitations.md);
the path forward is the [roadmap](./roadmap.md).

## What this project demonstrates about engineering maturity

- **Boundaries drawn on purpose.** One authority, a frozen contract layer, pure
  security primitives with no HTTP/DB concerns, and a client that is structurally
  prevented from holding authority.
- **Authorization modeled, not improvised.** Permission, entitlement, and quota
  kept as separate axes with attributable failures and a clean path to billing.
- **Security treated as mechanism, not vocabulary.** Hash-only storage,
  transactional rotation with reuse detection, CSRF off the correctness path, and
  defensive sanitization — each chosen and documented with its trade-off.
- **Invariants enforced transactionally**, not hoped for — Last Owner, refresh
  rotation, atomic personal-workspace provisioning, single acceptance seam.
- **Validation that actually gates.** A fail-fast offline suite plus a live
  integration suite, mirrored in CI, including a drift check that prevents silent
  schema/migration divergence.
- **Scope discipline and honesty.** A large, explicit list of deliberate non-goals
  — the project is judged on what it claims, and it claims only what it does.

In short: Orgistry is meant to show the ability to take a genuinely hard,
correctness-sensitive domain and build it to a consistent standard end to end —
including the unglamorous parts.
