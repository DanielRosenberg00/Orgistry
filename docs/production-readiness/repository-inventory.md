# Repository Inventory

Complete inventory of the tracked repository at revision `d0b2f97` (338 tracked
files). Maturity classifications: **Production-capable** (ready for the target
profile), **Partial** (works but needs hardening), **Demo-only**, **Test-only**,
**Local-only**, **Scaffolded** (present, unused), **Historical**.

## Coverage reconciliation

Category-level proof of completeness. Counts are from `git ls-files` /
`docker`-independent enumeration at revision `d0b2f97`; "Reviewed" means the
category was inventoried and represented in the audit. Excluded items are named
with a reason — nothing is silently dropped.

| Category | Count | Reviewed | Excluded | Exclusion reason | Evidence / section |
| --- | --- | --- | --- | --- | --- |
| Applications | 2 | 2 | 0 | — | [Applications & packages](#applications--packages) |
| Packages | 5 | 5 | 0 | — | [Applications & packages](#applications--packages) |
| API modules | 8 | 8 | 0 | — | [API modules](#api-modules-appsapisrcmodules) |
| Route files (`*.routes.ts`, non-test) | 11 | 11 | 0 | — | [API route inventory](#api-route-inventory) (grouped into 12 groups incl. health/readiness) |
| Database tables (`pgTable`) | 16 | 16 | 0 | — | [Database inventory](#database-inventory-16-tables) |
| Schema files (`schema/*.ts`, non-test) | 9 | 9 | 0 | — | [Database inventory](#database-inventory-16-tables) |
| Migrations (`*.sql`) | 8 | 8 | 0 | — | [Migration inventory](#migration-inventory) |
| CI workflows | 1 | 1 | 0 | — | [CI inventory](#ci-inventory) |
| Root `package.json` scripts | 21 | 21 | 0 | — | [Scripts inventory](#scripts-inventory) |
| Test files (`*.test.ts[x]`) | 67 | 67 | 0 | — | [Test inventory](#test-inventory-67-test-files) |
| Top-level docs (`docs/*.md`) | 38 | 38 | 0 | — | [Documentation inventory](#documentation-inventory); 14 are historical sprint artifacts (reviewed for contradictions only) |
| Demo/tooling scripts (`tooling/*`) | 2 | 2 | 0 | — | [Maintenance / demo / generated artifacts](#maintenance--demo--generated-artifacts) |
| Generated/lock artifacts | n/a | n/a | `pnpm-lock.yaml`, migration `meta/` snapshots, `apps/web-demo/dist` | Generated/derived; spot-checked not line-audited | [Maintenance / demo / generated artifacts](#maintenance--demo--generated-artifacts) |
| In-memory test repos (`**/testing/*`) | — | represented | not enumerated per-file | Test-only harness, not production surface | [Test inventory](#test-inventory-67-test-files) |

Reconciliation: every application, package, API module, route file, database
table, migration, CI workflow, root script, test file, production-relevant
document, and demo/tooling script is represented, with **no category excluded**
except generated/derived artifacts and test-only harness files (reason given).

## Applications & packages

| Workspace | Purpose | Source root | Maturity | Notes / findings |
| --- | --- | --- | --- | --- |
| `apps/api` | Fastify HTTP API — the authority | `apps/api/src` | Partial | Strong domain logic; missing headers/proxy/timeouts (ORG-PR-010/011/021), no deploy artifact (ORG-PR-001). |
| `apps/web-demo` | React/Vite thin admin consumer | `apps/web-demo/src` | Demo-only | By design; robustness gaps (ORG-PR-023/035/036). |
| `packages/config` | Zod-validated runtime config | `packages/config/src` | Partial | Sprint 14 baseline: no production guards (ORG-PR-003), unused `COOKIE_SECRET` (ORG-PR-047). Current state: both resolved in Sprint 15 — production guard added, `COOKIE_SECRET` removed. |
| `packages/contracts` | Frozen API contracts (envelopes, codes, DTOs) | `packages/contracts/src` | Production-capable | No DTO leaks; well tested. |
| `packages/shared` | Primitives: IDs, cursors, request-id, env loader | `packages/shared/src` | Production-capable | Cursor unsigned but not a tenant vector. |
| `packages/auth-core` | Argon2id, JWT (jose), opaque-token hashing, redaction | `packages/auth-core/src` | Production-capable | HS256 no `kid` (ORG-PR-049). |
| `packages/db` | Drizzle schema, migrations, client, migrator, test reset | `packages/db` | Partial | No timeouts/least-privilege/rollback (ORG-PR-021/022/028); dead table (ORG-PR-048). |

## API modules (`apps/api/src/modules`)

| Module | Responsibility | Maturity | Key findings |
| --- | --- | --- | --- |
| `auth` | Register/login/refresh/logout/sessions/security-events | Partial | Recovery surface absent (ORG-PR-004/024/039/045); fail-open limits (ORG-PR-009); enumeration (ORG-PR-030). |
| `organization` | Org context, membership, org-RBAC, provisioning | Production-capable* | Solid tenant isolation & Last-Owner; role-transition gap (ORG-PR-017); read-path divergence (ORG-PR-053). |
| `rbac` | Global role/permission catalog reads | Production-capable | Authenticated, intentionally not permission-gated. |
| `projects` | Canonical org-scoped resource | Production-capable | Quota race (ORG-PR-029). |
| `entitlements` | Plans, entitlements, quotas | Partial | Quota TOCTOU (ORG-PR-029); demo plan-change endpoint. |
| `invitations` | Invitation lifecycle + mailer | Partial | Mailpit-only mailer (ORG-PR-002); no rate limit (ORG-PR-012/032). |
| `api-keys` | Machine credentials + external read API | Partial | Pre-auth event write (ORG-PR-013); best-effort writes not isolated (ORG-PR-034). |
| `audit` | Org-scoped audit read API | Partial | Backing table unindexed on org (ORG-PR-014); no retention (ORG-PR-015). |

*Production-capable at the authorization/isolation layer; the app as a whole is Partial.

## API route inventory

Auth is enforced in the **service** layer (permission/entitlement/quota), not the
routes; Bearer auth via `authService.authenticate`. Full per-route requirements
are in `docs/api-surface.md` (accurate except the `org.read` drift, ORG-PR-046/053).

| Group | Routes | Auth | Notable requirements |
| --- | --- | --- | --- |
| Health | `GET /health`, `GET /ready` | none | `/ready` probes PG+Redis; exposes dep names (ORG-PR-052). |
| Auth | `POST /v1/auth/register`,`/login`; `GET /me`; `POST /refresh`,`/logout`; `GET /sessions`; `DELETE /sessions/:id` | mixed | register/login rate-limited; refresh/logout require CSRF header + cookie. |
| Organizations | `POST /v1/organizations`; `GET /v1/organizations`; `GET /:organizationId` | Bearer | list scoped to active memberships; read is membership-only (ORG-PR-053). |
| Members | `GET/PATCH :id/role/DELETE :id` under `/:organizationId/members` | Bearer | `members.*` perms; Last-Owner protected; role-transition gap (ORG-PR-017). |
| Org-RBAC | `GET …/roles`,`/permissions`,`/permissions/matrix`,`/permissions/effective` | Bearer | effective is membership-only by design. |
| Global RBAC | `GET /v1/roles`,`/permissions`,`/permissions/matrix` | Bearer | authenticated, not permission-gated (intentional). |
| Projects | `GET`/`POST`/`GET :id`/`PATCH :id`/`DELETE :id` under `/:organizationId/projects` | Bearer | `projects.*` + `max_projects` quota (race: ORG-PR-029). |
| Plans | `GET …/plan`,`/entitlements`; `PATCH …/plan/demo` | Bearer | `plan.change_demo` Owner-only; demo-only endpoint. |
| API keys | `POST`/`GET`/`DELETE :id` under `/:organizationId/api-keys` | Bearer | `api_keys.*` + `api_keys_access` + `max_api_keys`; no rate limit (ORG-PR-032). |
| External API | `GET /v1/external/projects` | API key | scope `projects:read`; per-key/per-org fail-open limits; pre-auth event write (ORG-PR-013). |
| Invitations | `POST`/`GET`/`DELETE :id` under `/:organizationId/invitations`; `POST /v1/invitations/inspect` (public); `POST /v1/invitations/accept` | mixed | inspect is unauthenticated & unthrottled (ORG-PR-012). |
| Audit | `GET …/audit-events` | Bearer | `audit_events.read` + `audit_log_access`. |

## Database inventory (16 tables)

`packages/db/src/schema/*`. Opaque prefixed text PKs (app-generated) except
seed-supplied catalog tables. **All FKs `ON DELETE no action`** (no cascades).

| Table | Purpose | Notable fields / constraints |
| --- | --- | --- |
| `app_meta` | infra marker | key PK. |
| `users` | accounts | `status`, `email_verified_at` (unused), `deleted_at` soft-delete; `uq_users_normalized_email`. |
| `sessions` | login sessions | `expires_at`, `revoked_at`; idx user_id, expires_at. |
| `refresh_tokens` | rotating tokens | hash-only, `family_id`, `used_at`, `replacement_token_id`; `uq_refresh_tokens_token_hash`. |
| `email_verification_tokens` | **unused scaffolding** | ORG-PR-048; never read/written. |
| `security_events` | auth + audit backing store | `organization_id` (no FK, **no index** — ORG-PR-014); append-only, no retention (ORG-PR-015). |
| `roles` | fixed 4 roles | `uq_roles_key`; seeded `0001`. |
| `organizations` | orgs | `type` (personal/team), `status` (active/archived/suspended — inert), `uq_organizations_slug` (no name unique). |
| `memberships` | user↔org | partial unique `uq_memberships_active_user_org`; soft-remove. |
| `permissions` | 23 keys | `uq_permissions_key`; seeded `0002`. |
| `role_permissions` | grants | composite PK + redundant unique index (ORG-PR-051). |
| `projects` | canonical resource | soft-delete; partial + point-lookup org indexes. |
| `plans` | 3 demo plans | quotas + `audit_retention_days` (unenforced). |
| `organization_plans` | org→plan | `uq_organization_plans_organization`. |
| `api_keys` | machine creds | hash-only secret; partial active index. |
| `invitations` | invites | hash-only token; partial unique pending per (org,email). |

Invariant enforcement summary: DB-enforced (email uniqueness, slug uniqueness,
active-membership uniqueness, pending-invitation uniqueness, one plan per org);
app-only transactional (Last-Owner, refresh single-use, invitation single-use,
quotas); **unenforced convention** (one personal workspace per user — ORG-PR-038).

## Migration inventory

`packages/db/migrations/0000…0007.sql` + `meta/` snapshots + `_journal.json`
(version 7, `breakpoints: true`). All **additive** (CREATE/ADD/INDEX + idempotent
seeds/backfill); **no destructive ops, no down-migrations** (ORG-PR-028).
Migrate-from-scratch is tested (`packages/db/src/migrate.integration.test.ts`).

## Configuration inventory

`packages/config/src/schema.ts` — one Zod schema over all env keys (runtime, HTTP,
CORS, DB/Redis/Mailpit, auth secrets/TTLs, cookie/CSRF, rate-limit buckets, API-key
throttle). `.env.example` documents local defaults. At the Sprint 14 audit
baseline there were **no production guards** (ORG-PR-003); Sprint 15 added them
(`packages/config/src/production-policy.ts`). Frontend build-time `VITE_*` keys
in `apps/web-demo/src/config.ts`.

## Scripts inventory

Root `package.json`: `dev*`, `typecheck`, `lint(:fix)`, `test`, `test:integration`,
`test:web`, `build:web`, `db:check`, `check:whitespace`, `validate`,
`validate:integration`, `demo:seed`, `infra:up/down/reset`, `db:generate/migrate/
reset:test`. `packages/db/scripts/`: `migrate.ts`, `reset-test.ts` (guard weaker
than documented — ORG-PR-037).

## CI inventory

`.github/workflows/ci.yml` — two jobs mirroring local validation: `validate`
(offline: typecheck→lint→unit→web→build→schema-drift→whitespace) and `integration`
(PG+Redis service containers → `validate:integration`). Triggers `push:main` +
`pull_request`. **Gaps:** actions pinned to tags not SHAs, no `permissions:`
block (ORG-PR-019); no dependency/secret/SAST scanning, no Dependabot/Renovate
(ORG-PR-020); Mailpit/SMTP not exercised (ORG-PR-041); no release/deploy job
(ORG-PR-001).

## Docker inventory

`infra/docker-compose.yml` — local Postgres 16 / Redis 7 / Mailpit (`latest`),
floating tags (ORG-PR-042). `infra/postgres-init/01-create-test-db.sql` creates
`orgistry_test`. **No app Dockerfiles** (ORG-PR-001).

## Test inventory (67 test files)

| Class | Count | Runs offline? |
| --- | --- | --- |
| Unit / service | 29 | yes |
| Contract (Zod) | 9 | yes |
| Route / in-memory (`app.inject`) | 15 | yes |
| DB-integration (live PG) | 8 | `skipIf` no `TEST_DATABASE_URL`/`DATABASE_URL` |
| API-integration live (PG+Redis) | 1 | `skipIf` |
| Component (jsdom) | 5 | yes |

Strong negative/tenant-isolation/security-event coverage. **Absent:** browser
E2E, load, fuzz, live failure-injection (ORG-PR-026), broad concurrency
(ORG-PR-044), live SMTP (ORG-PR-041).

## Documentation inventory

~35 docs under `docs/`. Authoritative-current: `architecture`, `security-model`,
`api-surface`, `validation`, `runbook` (local-only), `troubleshooting`,
`known-limitations`, `local-development`, `demo-walkthrough`, `evaluation-guide`,
`portfolio-case-study`, `roadmap`. Subsystem refs (sprint-labeled, mostly
current-as-design). **Stale:** `database-foundation` (frozen Sprint 4),
`rbac-permissions` reserved-keys note, `api-conventions` error codes, `api-surface`
`org.read`, `evaluation-guide` test count — all ORG-PR-046. Historical: 13
`sprint-*-artifact-package.md` + `sprint-1-foundation.md`. This
`docs/production-readiness/` package is new (Sprint 14).

## Maintenance / demo / generated artifacts

- `tooling/check-schema-drift.mjs` — verifies migrations match schema (offline).
- `tooling/demo-seed.mjs` — drives the public API to seed demo state; idempotent,
  non-destructive; hardcoded local-only credentials (`demo.owner@orgistry.local`
  / `demo-password-123`, invitee `demo.invitee@orgistry.local`).
- Generated: `pnpm-lock.yaml`, migration `meta/` snapshots, `apps/web-demo/dist`
  (build output, git-ignored).
- **No maintenance jobs exist** (ORG-PR-015/016) — this is an inventory absence,
  not an artifact.
