# Evaluation Guide

A reviewer-focused path through Orgistry. The goal is to let a senior engineer
form an accurate judgment **efficiently** — what to read, what to run, what to
inspect, and how to judge the project fairly given its stated scope.

Orgistry is an engineering reference / portfolio project: type-checked, linted,
unit- and integration-tested, but **not production-certified**
([known limitations](./known-limitations.md)). Evaluate it as a *worked
reference for a multi-tenant identity/access backbone*, not as a shippable
product.

Audience: senior engineers, technical reviewers (including those screening on
behalf of a recruiter), collaborators, and maintainers.

## TL;DR review path (~30–45 minutes)

1. Read the [README](../README.md) and the [portfolio case study](./portfolio-case-study.md) (~10 min).
2. Skim the [architecture overview](./architecture.md) and the [API surface index](./api-surface.md) (~10 min).
3. Run `pnpm install && pnpm validate` (offline, no services) (~5 min).
4. Inspect the access-control seam and one full vertical slice (Projects) (~10 min).
5. Read the [security model](./security-model.md) and [known limitations](./known-limitations.md) (~10 min).
6. Optional, with Docker: `pnpm infra:up && pnpm db:migrate && pnpm dev:api`, then `pnpm demo:seed` and click through the web demo.

## What to read first

In order, fastest signal first:

1. **[README](../README.md)** — one-liner, scope, capability summary, commands.
2. **[Portfolio case study](./portfolio-case-study.md)** — the *why* and the key
   decisions, including the permission/entitlement/quota distinction.
3. **[Architecture overview](./architecture.md)** — monorepo shape, the
   "API is the only authority" principle, the models.
4. **[API surface index](./api-surface.md)** — every route with its auth,
   permission, and entitlement, plus the enforcement order. This is the single
   best map of what the system actually does.
5. **[Security model](./security-model.md)** and
   **[known limitations](./known-limitations.md)** — read together; they define
   both the posture and its honest boundary.

## What commands to run first

Everything here is verified against `package.json`. Start offline:

```bash
pnpm install
pnpm validate     # typecheck, lint, unit tests, web tests, web build,
                  # schema-drift check, whitespace — no services required
```

`pnpm validate` is the fastest high-signal check: it runs on a fresh clone with no
Docker and fails fast on the first problem. Then, if you have Docker and want the
live paths:

```bash
pnpm infra:up                 # PostgreSQL, Redis, Mailpit
pnpm validate:integration     # test-DB reset + migration-from-scratch + live API tests
```

Full matrix, what each step proves, and failure interpretation:
[validation](./validation.md). Port-conflict help (Postgres on 5432 is the common
one): [runbook](./runbook.md#handling-port-conflicts).

## What backend modules to inspect

The backend (`apps/api`) is the only authority; spend your time here. Suggested
order, each chosen to show a distinct idea:

- **`apps/api/src/server.ts` and the app bootstrap** — request-ID propagation,
  central error handling, the response envelope, health/readiness.
- **The access-control helpers** (`requireMembership`, `requirePermission`,
  `requireEntitlement`, `requireQuota`) and how org-scoped routes compose them.
  This is the heart of the system; confirm authorization keys on **permission**,
  never a role name.
- **Projects module** (`apps/api/src/modules/projects`) — the canonical vertical
  slice (routes → service → repository): org-scoped queries, quota-after-permission,
  cursor pagination, soft delete, uniform cross-tenant `404`. If you read one
  module end to end, read this one.
- **Auth + sessions** (`apps/api/src/modules/auth`) — registration's atomic
  personal-workspace provisioning, refresh rotation, reuse detection, the CSRF
  header check.
- **Entitlements** (`apps/api/src/modules/entitlements`) — the plan→entitlement/
  quota resolver and the strict separation of the three axes.
- **API keys + external API** (`apps/api/src/modules/api-keys`) — hash-only
  one-time secret, scopes, and the tenant-derived external route that takes no org
  ID and no JWT.
- **Invitations** (`apps/api/src/modules/invitations`) — hash-only token,
  email-match enforcement, fail-closed send, single transactional acceptance seam.
- **Audit** (`apps/api/src/modules/audit`) — permission+entitlement gating and
  defensive metadata sanitization.

Supporting packages worth a glance: `packages/contracts` (the frozen DTO/error
boundary), `packages/auth-core` (Argon2id, JWT, opaque-token hashing — pure, no
HTTP/DB), and `packages/db` (schema, migrations, guarded test reset).

## What frontend modules to inspect

`apps/web-demo` is intentionally thin — review it to confirm it holds **no**
authority, not to evaluate UI polish:

- **The API client / envelope unwrapping** — typed `data` vs typed `ApiError`,
  single-flight silent refresh on `401`, access tokens in memory only.
- **Auth/session bootstrap** — refresh-cookie session restore at boot.
- **Permission-aware UI** — controls rendered from the caller's effective
  permissions as *hints*, with backend errors as the truth.
- **One admin surface** (e.g. Projects or API Keys) — to see the
  thin-consumer pattern and the one-time API key secret warning in context.

Detail: [web demo](./web-demo.md). Thin-consumer rationale: the
[case study](./portfolio-case-study.md#frontend-thin-consumer-pattern).

## What security decisions to review

Read the [security model](./security-model.md), then verify these in code:

- **Hash-only storage** for passwords, refresh tokens, API key secrets, and
  invitation tokens; raw API key/invitation secrets shown or sent exactly once.
- **Refresh rotation + reuse detection** — transactional single-successor
  rotation; a replayed token revokes the whole family and session.
- **CSRF off the correctness path** — custom-header requirement plus strict CORS
  origin allow-list.
- **Tenant isolation** — org-scoped queries keyed on the route org ID; uniform
  cross-tenant `404`.
- **Entitlement/quota separation** and attributable failure codes.
- **Audit sanitization** — secrets/tokens/headers/PII stripped; security events
  excluded from the default stream.

Then read [known limitations](./known-limitations.md) so you weigh these against
what is deliberately *not* done (no RLS, fail-open rate limits, quota race
windows).

## What tests demonstrate important behavior

The offline suite runs **489 unit tests** and **19 web-demo tests** (counts as of
the latest validation run; re-run `pnpm validate` to confirm). High-signal areas
to open:

- **Access-control unit tests** — permission vs entitlement vs quota ordering and
  the attributable error codes.
- **Auth/session tests** — refresh rotation and **reuse detection** revoking the
  family.
- **API key tests** (`apps/api/src/modules/api-keys/api-key-secret.test.ts` and
  the web demo's `api-keys-secret.test.tsx`) — one-time secret behavior.
- **Last Owner invariant tests** — role change / removal rejected transactionally.
- **Integration tests** (require live PostgreSQL + Redis) — migration-from-scratch
  with idempotent seeds, `/ready` reflecting dependency health, and tenant
  isolation against a real database.

The integration suites **skip with a warning** (never silently pass) when the
database/Redis env is absent — a green run with skips is not a validated run.

## What demo flow to run

With infra up and the API running, `pnpm demo:seed` builds a presentable state by
driving the **real public API** (never the database directly), then prints
local-only credentials and a ready-to-run `curl` for the external API. Follow the
[demo walkthrough](./demo-walkthrough.md) for the full reviewer journey:
register/login → org switcher → overview → projects (hit `QUOTA_EXCEEDED` on Free)
→ plan change to Pro → invite a user (read it in Mailpit) → create an API key
(one-time secret) → call the external API → view the audit log → observe
permission-aware UX with backend-authoritative errors.

## What limitations to keep in mind

Judge against the stated scope, not an imagined production target. Orgistry
explicitly does **not** implement billing, OAuth, MFA, password reset, production
email, PostgreSQL RLS, custom roles, resource-level/ABAC permissions, audit
export/retention enforcement, webhooks, SDKs, or full browser E2E; and it accepts
quota race windows, fail-open rate limiting, and a demo-quality UI. These are
deliberate non-goals, documented in [known limitations](./known-limitations.md),
with a forward path in the [roadmap](./roadmap.md).

## How to judge the project fairly

A reasonable rubric for *this* kind of artifact:

- **Correctness of the access model.** Is authorization permission-based? Are
  permission/entitlement/quota genuinely separate and attributable? Is tenant
  isolation enforced on every org-scoped query?
- **Security mechanism quality.** Are secrets hash-only? Is refresh rotation +
  reuse detection real and transactional? Is CSRF kept off the correctness path?
- **Boundary discipline.** Is the API the sole authority? Is the client provably
  thin? Are contracts a frozen, shared boundary?
- **Invariant enforcement.** Are Last Owner, rotation, and atomic provisioning
  enforced transactionally rather than hoped for?
- **Validation and reproducibility.** Does `pnpm validate` pass on a fresh clone?
  Does CI mirror it? Does the schema-drift check actually prevent divergence?
- **Honesty.** Do the docs match the implementation, and is the scope boundary
  explicit rather than hidden?

What it is **not** fair to grade it on: production hardening, UI polish, billing,
or any explicitly out-of-scope feature. Those are on the
[roadmap](./roadmap.md) and labeled as future work, not gaps the project claims to
have filled.
