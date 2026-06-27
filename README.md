# Orgistry

An open-source **identity and access foundation** for multi-tenant SaaS, built as
a fully typed TypeScript monorepo. It implements the backbone every B2B SaaS
rebuilds from scratch — accounts, sessions, organizations, memberships, RBAC,
plans/entitlements/quotas, machine API keys, invitations, and an audit log — as a
clean, reviewable reference with a real backend as the source of truth.

> **Maturity:** engineering reference / portfolio project. The implemented
> surface is type-checked, linted, unit- and integration-tested, but the system
> is **not production-certified** — see [Known limitations](#known-limitations).

## What problem it solves

Identity and access control is the part of a SaaS that is tedious to get right
and dangerous to get wrong: tenant isolation, permission checks, plan gating,
quota enforcement, secure sessions, machine credentials, invitations, and an
audit trail. Orgistry is a worked reference for that backbone — small enough to
read end to end, strict about its invariants, and honest about its scope.

The whole system is organized around one chain, enforced server-side:

```
User → Organization → Membership → Role → Permission → Entitlement → Quota
     → Organization-Scoped Resource
```

## Core capabilities

- **Auth & sessions** — Argon2id passwords, short-lived JWT access tokens, an
  opaque hash-only refresh token in an HttpOnly cookie, transactional rotation
  with reuse detection, CSRF defense, and Redis-backed rate limiting.
- **Organizations & memberships** — a personal workspace auto-provisioned at
  registration, team organizations, and ID-based tenant isolation.
- **Fixed RBAC** — four roles (Owner/Admin/Member/Viewer) over a code-defined
  permission catalog; **permission-first** authorization and a transactional Last
  Owner invariant.
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
- **Web demo** — a thin React admin UI that consumes these APIs (it holds no
  authority of its own).

## Architecture at a glance

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

The **API is the only authority** for authorization, entitlements, quotas, and
tenancy. The web demo is intentionally thin: memory-only access tokens,
refresh-cookie session restore, and permission-aware UI that is a *hint* — the
backend's errors are the truth. See [docs/architecture.md](docs/architecture.md).

## Tech stack

TypeScript · pnpm workspaces · Node ≥ 20 · Fastify 5 · Drizzle ORM + PostgreSQL ·
Redis (ioredis) · Zod · React 19 + Vite 6 + TanStack Query · Vitest · ESLint 9 ·
Docker Compose (PostgreSQL / Redis / Mailpit).

## Run locally

```bash
# 1. Install dependencies
pnpm install

# 2. Create your environment file (local-only defaults)
cp .env.example .env

# 3. Start local infrastructure (PostgreSQL, Redis, Mailpit)
pnpm infra:up

# 4. Apply the database migration baseline
pnpm db:migrate

# 5. Run the API and web demo (separately, or together with `pnpm dev`)
pnpm dev:api    # http://localhost:3000
pnpm dev:web    # http://localhost:5173
```

Then either click through the web demo or seed a presentable demo state in one
command (API must be running):

```bash
pnpm demo:seed
```

See the [demo walkthrough](docs/demo-walkthrough.md) for the full reviewer flow,
and the [runbook](docs/runbook.md) if a port is already in use (most often
PostgreSQL on 5432).

## Validate

```bash
pnpm validate              # offline gate — no services required
pnpm validate:integration  # live gate — needs PostgreSQL + Redis (pnpm infra:up)
```

`pnpm validate` runs typecheck, **ESLint**, unit tests, web demo tests, web demo
build, a database **schema-drift check**, and a whitespace check — failing
non-zero on the first problem. `pnpm validate:integration` resets the test
database and runs migration-from-scratch plus live API readiness/route tests.
[CI](.github/workflows/ci.yml) mirrors both. Full detail and failure
interpretation: [docs/validation.md](docs/validation.md).

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm dev:api` / `pnpm dev:web` | Run the API and/or web demo |
| `pnpm typecheck` | Strict `tsc --noEmit` across all workspaces |
| `pnpm lint` / `pnpm lint:fix` | ESLint gate (API + packages + web demo) |
| `pnpm test` / `pnpm test:web` | Unit tests / web demo tests |
| `pnpm build:web` | Web demo production build |
| `pnpm db:check` | Schema drift check (offline) |
| `pnpm validate` / `pnpm validate:integration` | Offline / live validation matrix |
| `pnpm infra:up` / `:down` / `:reset` | Start / stop / wipe local infrastructure |
| `pnpm db:migrate` / `pnpm db:generate` / `pnpm db:reset:test` | Apply / regenerate / reset DB |
| `pnpm demo:seed` | Populate a presentable local demo state via the public API |

## Web demo

`apps/web-demo` is an authenticated React/Vite admin UI and a thin official
consumer of the Orgistry APIs: login/register, organization switcher, overview,
members, invitations, projects, plan & entitlements, API keys, and audit log.
Open <http://localhost:5173>, register (which provisions a personal workspace and
signs you in), and create a team organization from the switcher. Invitation
emails land in Mailpit (<http://localhost:8025>). The API's `CORS_ORIGINS` must
include the web origin. See [docs/web-demo.md](docs/web-demo.md).

## Documentation

**Start here (reviewers):**

- [Evaluation guide](docs/evaluation-guide.md) — what to read, what to run, and
  what to inspect first, with a fair-judgment rubric.
- [Portfolio case study](docs/portfolio-case-study.md) — problem, decisions,
  trade-offs, and what the project demonstrates.
- [Roadmap](docs/roadmap.md) — prospective work; critical production gaps vs
  optional enhancements.

**Authoritative (current):**

- [Architecture overview](docs/architecture.md) — system shape, responsibilities,
  models, design decisions.
- [Security model](docs/security-model.md) — credentials, sessions, CSRF,
  tenancy, authorization, API keys, invitations, audit.
- [API surface index](docs/api-surface.md) — every route by domain, with auth,
  permission, and entitlement.
- [Validation matrix](docs/validation.md) — what to run, what it proves, how to
  read failures.
- [Local infrastructure runbook](docs/runbook.md) — services, ports, env, resets,
  port-conflict handling.
- [Troubleshooting](docs/troubleshooting.md) — symptom-driven fixes.
- [Known limitations](docs/known-limitations.md) — honest scope boundary.
- [Demo walkthrough](docs/demo-walkthrough.md) — executable reviewer flow.
- [Local development](docs/local-development.md) — day-to-day workflow.
- [API conventions](docs/api-conventions.md) — envelopes, errors, request IDs.

**Subsystem references:** [auth](docs/auth-foundation.md) ·
[sessions](docs/session-lifecycle.md) · [organizations](docs/organization-foundation.md) ·
[RBAC](docs/rbac-permissions.md) · [projects](docs/projects.md) ·
[entitlements/plans/quotas](docs/entitlements-plans-quotas.md) ·
[API keys & external API](docs/api-keys-external-api.md) ·
[invitations](docs/invitations.md) · [audit log](docs/audit-log.md) ·
[database](docs/database-foundation.md) · [web demo](docs/web-demo.md).

**Historical:** the per-sprint completion artifacts
(`docs/sprint-*-artifact-package.md`, plus `docs/sprint-1-foundation.md`) are
kept as a development record. They describe the system *at the time each sprint
shipped* — for current behavior, prefer the authoritative docs above.

## Security model summary

Hash-only passwords (Argon2id) and refresh tokens; short-lived JWTs; HttpOnly
SameSite=Lax refresh cookie with transactional rotation and reuse detection;
custom-header CSRF defense; fail-open Redis rate limits; ID-based tenant
isolation; permission-first authorization with Last Owner protection; separated
entitlement/quota gates; hash-only one-time API key secrets with scopes;
hash-only invitation tokens with email-match enforcement; sanitized audit
metadata. Full detail and non-production caveats:
[docs/security-model.md](docs/security-model.md).

## Known limitations

Orgistry is **not production-certified**. Out of scope by design: billing
(Stripe), OAuth/MFA/password reset, production email (Mailpit only), workers/
queues, PostgreSQL RLS, custom roles, resource-level/ABAC permissions, audit
retention enforcement / export / SIEM, write-enabled external API, API key
rotation, full browser E2E tests, and production deployment automation. The UI is
demo-quality, quotas accept small race windows, and rate limiting fails open. The
complete, honest list is [docs/known-limitations.md](docs/known-limitations.md).

## Prerequisites

- Node.js ≥ 20 (developed on Node 22+)
- pnpm ≥ 9 (repo pins `pnpm@10.29.3` via `packageManager`)
- Docker + Docker Compose (local PostgreSQL / Redis / Mailpit)

## License

See [LICENSE](LICENSE).
