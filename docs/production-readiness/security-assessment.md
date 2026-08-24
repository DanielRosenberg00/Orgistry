# Security & Reliability Assessment

Cross-domain security, reliability, and operational posture. This document
summarizes each domain and cross-references the authoritative
[findings-register.md](findings-register.md) by ID rather than restating findings.
Strengths are recorded alongside gaps so the roadmap does not regress them.

**Sprint 19 update (2026-07-21) — edge & application security hardening.**
The following findings referenced below are now **Closed**, with one-line
evidence each (full detail in
[sprint-19-artifact-package.md](sprint-19-artifact-package.md)):

- **ORG-PR-010** — typed `TRUST_PROXY` (`'false'` default | hop count |
  IP/CIDR list; literal `'true'` rejected at config load) applied at Fastify
  construction in `apps/api/src/app.ts`; with trust disabled `X-Forwarded-*`
  is ignored and `request.ip` is the socket peer
  (`apps/api/src/app.proxy-trust.test.ts`).
- **ORG-PR-011** — internal plugin `apps/api/src/plugins/security-headers.ts`
  sets nosniff/frame-deny/no-referrer/COOP/CORP/Permissions-Policy on every
  response; HSTS `includeSubDomains` only under `NODE_ENV=production`;
  `Cache-Control: no-store` on `/v1/auth/*` and `/v1/invitations/*`. This is
  explicitly not a frontend CSP — ORG-PR-035 remains open.
- **ORG-PR-012** — global per-trusted-IP fixed-window limiter
  (`apps/api/src/plugins/global-rate-limit.ts`, default 300/60 s, `/health`,
  `/ready`, and preflight exempt) plus `invitations/inspect` throttled per IP
  and per token-derived second-order digest
  (`apps/api/src/modules/invitations/invitation.throttle.test.ts`); raw
  tokens never appear in Redis keys, logs, or events.
- **ORG-PR-013** — every 401-family External API failed-auth event funnels
  through `recordFailedAuthEventBounded`
  (`apps/api/src/modules/api-keys/api-key.authenticator.ts`); durable
  `security_events` writes bounded per source IP per window, proven by the
  DB-backed storm test
  (`apps/api/src/modules/api-keys/api-key.failed-auth.integration.test.ts`).
- **ORG-PR-032** — per-actor buckets enforced in services after permission
  checks (org/project/API-key/invitation creation, demo plan change);
  deliberately unthrottled surfaces are bounded-population mutations, with
  the rationale in the Sprint 19 artifact.
- **ORG-PR-033** — `buildLoggerOptions` in `apps/api/src/lib/logging.ts`
  centralizes pino redact paths (authorization/cookies/CSRF header,
  passwords, tokens/hashes, API-key and SMTP/JWT secrets) with log-capture
  tests (`apps/api/src/lib/logging.test.ts`); a backstop, not a replacement
  for the never-log-credentials module policy.
- **ORG-PR-052** — inbound `x-request-id` sanitized centrally
  (`packages/shared/src/request-id.ts`, `[A-Za-z0-9._-]{1,128}` or replaced
  with a generated `req_<uuid>`); `/ready` is coarse in production
  (ready/not-ready only); shutdown is idempotent and bounded by a 10 s
  unref'd force-exit timer.

**ORG-PR-009 is materially advanced, not closed** — the limiter store
contract now reports `'unavailable'` explicitly and sensitive buckets fail
closed under the production-default `RATE_LIMIT_FAILURE_MODE=closed` (the
production config guard refuses an explicit `'open'`; the global bucket
fails open by design), but the finding's alerting half depends on ORG-PR-007
(observability), which remains open. Fail-closed behavior does not replace
monitoring.

**Sprint 21 update (2026-07-26) — supply chain & CI hardening.** Sprint 21
repository implementation is complete: **ORG-PR-018** (drizzle-orm 0.45.2,
the advisory fix release, with the drizzle ≥0.44 `DrizzleQueryError`
cause-chain guard adaptation validated against live PostgreSQL),
**ORG-PR-054** (no esbuild copy below the 0.25.0 fix remains), **ORG-PR-019**
(full-SHA action pins, explicit least-privilege permissions, concurrency),
and **ORG-PR-040** (`noUncheckedIndexedAccess` repo-wide, zero suppressions)
are **Closed**. **ORG-PR-020 remains open pending first remote CI execution
and negative-path enforcement evidence** — the audit/Gitleaks/CodeQL
workflows and Dependabot are configured and locally validated where a local
equivalent exists, but the CI security boundary is not yet proven enforced.
**ORG-PR-042 remains open** — exact patch tags shipped; digest pinning is
deferred to the ORG-PR-001 artifact track (subsequently **closed in Sprint
23**: every active image reference is tag+digest pinned). Full detail:
[sprint-21-artifact-package.md](sprint-21-artifact-package.md).

**Sprint 22 update (2026-07-26) — CodeQL alert triage & CI gate closure.**
**ORG-PR-020 is Closed.** The CI security boundary is now proven enforced,
not merely configured: all three workflows ran green remotely on `c33a150f`,
a temporary branch demonstrated that the Gitleaks job actually FAILS on a
seeded synthetic secret (run 30207672121 — `generic-api-key`, output
redacted, branch deleted and never merged), and a `main` ruleset makes the
CI, Security, and CodeQL checks required so a scanner failure blocks the
merge. All 41 High alerts from CodeQL's first run were individually triaged
with source/sink evidence and individually dispositioned — no bulk dismissal,
no unresolved true positive
([sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md)).
The triage found one genuine security defect, **ORG-PR-055**: the audit-log
read filtered on five un-indexed JSONB metadata keys over a table with no
retention policy, so a `targetId` matching nothing scanned the organization's
entire event slice with only a coarse per-IP ceiling in front of it; per-user
and per-organization buckets now bound it (the scan cost itself remains
open). **ORG-PR-056** is CLOSED: the demo bootstrap emitted a one-time API
key secret to stdout, was first mitigated with a loopback-target guard, and
was then fully remediated — the bootstrap no longer creates an API key or
prints any credential, and key minting moved to the existing web-demo API
Keys page where the secret reaches only the requesting browser. No accepted
clear-text logging risk remains. Two claims were re-verified rather than inherited: the
password/token hashing boundary is Argon2id-only across all seven password
paths, and both flagged modulo operations are exactly uniform (256 = 32 x 8).
Full detail: [sprint-22-artifact-package.md](sprint-22-artifact-package.md).

## Authentication & account lifecycle

**Strengths (verified):** Argon2id at OWASP-minimum parameters (`password.ts`
`memoryCost=19456, timeCost=2, parallelism=1`); login is enumeration-hardened
(uniform `INVALID_CREDENTIALS` + memoized dummy-hash timing); access tokens are
HS256 via `jose` with an explicit `algorithms: ['HS256']` allowlist (no `alg:none`/
confusion); the DB session is re-validated on every access-token use, so
revocation is effectively immediate.

**Gaps:** the entire recovery surface is absent — password reset (ORG-PR-004),
email verification (ORG-PR-024), password/email change (ORG-PR-039), MFA and
security notifications (ORG-PR-045). Registration leaks account existence
(ORG-PR-030). At the Sprint 14 audit baseline, production config accepted
dev-default secrets and non-Secure cookies (ORG-PR-003) and required the dead
`COOKIE_SECRET` (ORG-PR-047); **Sprint 15 resolved both** — configuration now
refuses dev-default/weak secrets and `COOKIE_SECURE=false` under
`NODE_ENV=production`, and `COOKIE_SECRET` was removed (see the
[findings register](findings-register.md) resolutions). No `kid`/rotation for
the JWT secret (ORG-PR-049) — still open.

## Sessions

**Strengths:** 256-bit CSPRNG refresh tokens stored SHA-256 hash-only;
`HttpOnly`+`SameSite=Lax`+path-scoped cookie; transactional rotation with
`SELECT … FOR UPDATE` and single-successor guarantee; reuse detection revokes the
whole family + session; session list/revoke endpoints exist and are owner-scoped.

**Gaps:** benign concurrent refresh (multi-tab) trips reuse detection and logs the
user out everywhere (ORG-PR-050). Sessions/refresh tokens accumulate with no
cleanup (ORG-PR-015).

## Authorization & tenant isolation

**Strengths (verified):** org context is always derived from the path, never
client-supplied; the canonical order is membership → permission → entitlement →
quota; authorization is pure permission-set membership (no role-name branching in
business logic); all repo lookups scope by `organizationId`; cross-tenant access
returns a uniform 404 with negative tests across every module.

**Resolved (Sprint 20):** the ratified DG-2 policy is now enforced
server-side, inside the member-mutation transaction — any role change that
grants or removes Owner (and any removal of an Owner member) requires the
actor's membership to be in the transaction's locked active-owner set
(`owner-transition.ts` + `organization.repo.ts`), rejected with the standard
safe 403 after target resolution (ORG-PR-017 closed). The two
membership-only read paths were aligned: `GET /v1/organizations/:id` now
enforces `org.read` (matching `api-surface.md`), and
`…/permissions/effective` is the ONE documented intentional membership-only
exception — self-introspection cannot be permission-gated without circularity
(ORG-PR-053 closed).

## Concurrency correctness

**Strengths:** Last-Owner protection and refresh rotation are serialized with
`FOR UPDATE` and covered by real-Postgres concurrency tests; invitation acceptance
of a single token is atomic (row lock + single-use mutation + unique membership
index).

**Resolved (Sprint 20):** every quota-protected creation now serializes its
ENTIRE quota decision inside one transaction under a transaction-scoped
advisory lock keyed by (organization, quota kind): the CURRENT plan ceiling
is resolved through the same transaction (plan row `FOR SHARE`, serialized
against concurrent plan changes — repository contracts accept no
pre-resolved ceilings), then the count, comparison, and insert follow —
projects, API keys, invitation seat reservation, and every member-capacity
consumer (distinct-token acceptance and invited registration completion
share the locked acceptance body). Five real-PostgreSQL race suites prove
the exact ceilings and fail deterministically when the lock is removed, and
a six-test plan-coherence suite proves stale ceilings cannot be used
(ORG-PR-029/044 closed). Lock order, plan-mutation interaction, and
downgrade semantics:
[sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md).

## Database & migrations

**Strengths:** disciplined schema with partial unique indexes enforcing the
active-membership and pending-invitation invariants; additive, transactional
migrations; a thorough migrate-from-scratch integration test; keyset pagination
everywhere with bounded limits.

**Gaps:** one app+migration
superuser (ORG-PR-022); no pool/statement/lock timeouts (ORG-PR-021); no
rollback strategy (ORG-PR-028); `reset-test` guard weaker than documented
(ORG-PR-037); dead `email_verification_tokens` (ORG-PR-048) and a redundant
index (ORG-PR-051). *Sprint 20 closed two former gaps:* the audit read path
is now backed by `ix_security_events_org_created_id` (ORG-PR-014), and at most one
ACTIVE personal workspace per user is enforced by the partial unique index
`uq_organizations_active_personal_owner` (existence per user remains the
tested provisioning transaction's guarantee — ORG-PR-038).

## APIs

**Strengths:** one uniform success/error envelope; a single central error handler
that never leaks stack traces or internals on the 500 path; request IDs generated,
echoed, and logged; no DTO exposes password hashes, token hashes, or API-key
secrets (the raw secret appears exactly once); cursors are unsigned but not a
cross-tenant vector (tenant scope enforced independently in repos).

**Gaps:** no security headers (ORG-PR-011); no `trustProxy` (ORG-PR-010); no
global/edge rate limiting and an unauthenticated `invitations/inspect` oracle
(ORG-PR-012); no idempotency keys on creates (ORG-PR-031); spammable mutations
(ORG-PR-032); inbound `x-request-id` trusted verbatim and `/ready` disclosure
(ORG-PR-052). **Sprint 19 (2026-07-21) resolved all but one of these** —
ORG-PR-010/011/012/032/052 are closed (see the Sprint 19 update at the top of
this document); only ORG-PR-031 (idempotency keys) remains open.

## Frontend security

**Strengths:** access token strictly in-memory with correct single-flight refresh
and a no-loop guard (test-proven); no tokens/secrets in the TanStack Query cache;
the one-time API-key secret is held in transient state, never persisted, and cleared
on dismiss (test-guarded against web storage); permission-aware UI framed correctly
as a hint with the backend as authority.

**Gaps:** no React error boundary (ORG-PR-023); no CSP (ORG-PR-035); UX/a11y
robustness gaps (ORG-PR-036).

## Secrets & cryptography

See [standards-matrix.md](standards-matrix.md) for the control-level mapping.
**Strengths:** consistent hash-only design for passwords (Argon2id) and all opaque
secrets (refresh/invitation/API-key via SHA-256 of 256-bit CSPRNG values);
audit/security metadata sanitized by a denylist+allowlist with depth/size caps.
**Gaps:** ORG-PR-003 (production secret guards), ORG-PR-006 (management/rotation),
ORG-PR-047 (unused cookie secret), ORG-PR-049 (no `kid`), ORG-PR-043 (email PII in
metadata).

**Sprint 24 update (2026-08-23).** ORG-PR-003 and ORG-PR-047 were already
closed (Sprint 15). ORG-PR-006 and ORG-PR-049 are **materially advanced but
open**: secrets now resolve at runtime from either a direct environment value
or a mounted `<NAME>_FILE` secret, with resolution ordered **before** schema
validation and normalized onto the canonical variable name — so a file-backed
secret receives byte-identical production validation and cannot bypass a guard
(test-proven, and re-proven against the packaged artifact). Access-token keys
rotate gracefully through an optional `JWT_PREVIOUS_SECRET` accepted at
verification only; signing stays current-key-only, the keys must differ, both
are held to the production strength rules, and expiry/authorization semantics
are unchanged. Credential redaction now has explicit evidence on the startup,
config-validation, secret-file, SMTP-failure (auth/sender/recipient/connection/
TLS/timeout), 401-envelope, container-log, and web-asset paths. Confirmed by
inspection rather than assumed: **no refresh/session signing secret exists** —
refresh tokens are opaque, unsigned, hash-only, and the cookie is deliberately
unsigned — so rotating `JWT_SECRET` logs nobody out and session invalidation is
a database operation with no platform-wide API. Still absent, and why both
findings stay open: no secrets manager or platform store, no least-privilege
secret access control, no automated rotation or expiry tracking, no hot reload,
no `kid`/versioned-key scheme, and no rehearsed rotation against a real
deployment. See [../runtime-secrets.md](../runtime-secrets.md) and
[../rotation-runbook.md](../rotation-runbook.md).

## Dependencies & supply chain

**Strengths:** `pnpm-lock.yaml` + `--frozen-lockfile`; `onlyBuiltDependencies`
restricts postinstall scripts to esbuild; well-chosen primitives (`@node-rs/argon2`,
`jose`); the `drizzle-orm` (ORG-PR-018) and `esbuild` (ORG-PR-054) advisories
are remediated (Sprint 21: 0.45.2 / no copy < 0.25), in-range vulnerable
transitives updated, and Dependabot (npm / github-actions / docker-compose) +
audit gates + Gitleaks + `osv-scanner` are configured with two narrowly
documented advisory acceptances; as of Sprint 22 the scanners execute on
GitHub-hosted CI and are enforced as required checks (ORG-PR-020 closed).
**Gaps:** no SBOM/provenance/signing and no registry publishing (images are
exact-patch-tag + manifest-list-digest pinned since Sprint 23 — ORG-PR-042
closed; the residual is the Dependabot-uncovered workflow `services:` images,
bumped manually per [../validation.md](../validation.md#image-pinning-policy)).

## CI/CD & release readiness

Three workflows: `ci.yml` mirrors local validation across two jobs with
PG+Redis service containers; `security.yml` runs the pnpm dependency-audit
gates and the Gitleaks secret scan; `codeql.yml` runs JS/TS SAST. All actions
are pinned to verified full commit SHAs with explicit least-privilege
permissions (ORG-PR-019 closed, Sprint 21); all three run remotely and are
required checks on `main` via a repository ruleset, with the secret gate
proved to fail on a seeded finding (ORG-PR-020 closed, Sprint 22).
**Gaps:** ORG-PR-041 (SMTP untested), ORG-PR-001 (no release/deploy pipeline,
no registry publishing, no tags, no versioning — the artifacts themselves and
a CI build+smoke gate exist since Sprint 23: `ci.yml` `artifacts` job runs
`tooling/artifact-smoke.sh` against the production-shaped images). The minimum
release pipeline for the target is defined in
[production-roadmap.md](production-roadmap.md).

## Infrastructure & deployment

App Dockerfiles EXIST since Sprint 23 (non-root API + web artifacts, explicit
migration entrypoint, production-like compose validation reference, CI smoke
gate — see [../deployment-artifacts.md](../deployment-artifacts.md)); IaC and
environment provisioning still do not (ORG-PR-001 open for the deployment
half). The recommended
simplest architecture (reverse proxy + TLS + 2 API replicas + managed Postgres/
Redis + real SMTP + scheduler + secrets manager, **not Kubernetes**) is in
[production-target.md](production-target.md). Depends on: security headers/proxy
config (ORG-PR-010/011, closed), timeouts (ORG-PR-021), least-privilege DB
roles (ORG-PR-022); image pinning (ORG-PR-042) is closed.

## Reliability, backup & DR

**Sprint 25 (2026-08-24)** rebuilt this section's factual basis. The backup,
restore, and PITR CAPABILITIES now exist and are verified against synthetic
data: a repeatable `pg_dump -Fc` backup with an integrity checksum and
provenance metadata; a restore drill that recovers into a fresh database,
proves a corrupted artifact is rejected, asserts schema/migration-ledger/entity
survival, requires a migration re-run to be a no-op, and (with
`--with-artifact`) boots the packaged API against the restored database and
reads restored data back through an API-key-authenticated request; and
**PITR VERIFIED** — base backup plus demonstrably-working WAL archiving plus a
recovery target time, with pre-target rows recovered from archived WAL and
post-target `DELETE`/`DROP TABLE` damage undone. The data-layer and
artifact drills are CI-gated; PITR runs manually and weekly.

**ORG-PR-005 nevertheless remains a P1 blocker**, on its deployment-dependent
half: nothing SCHEDULES a backup, no artifact is stored remotely or encrypted,
no long-lived database archives WAL, no provider-managed PITR window exists,
archive health is unmonitored, and no RPO/RTO has been measured. A verified
drill is a capability; it is not a backup posture. No migration recovery
rehearsal (ORG-PR-028 — the mechanism now exists, the rehearsal does not). No
background runtime (ORG-PR-016). Redis fail-open (ORG-PR-009) and best-effort
writes that can fail requests (ORG-PR-034) are the main runtime-resilience
gaps; degraded-dependency behavior is untested against live services
(ORG-PR-026).
**Sprint 19 (2026-07-21):** ORG-PR-009 is materially advanced — sensitive
rate-limit buckets fail closed in production (`RATE_LIMIT_FAILURE_MODE`
defaults to `closed` there; the guard refuses `open`), the global bucket fails
open by design, and readiness still requires Redis; the alerting residual
tracks to ORG-PR-007.

## Observability & operations

Structured logs with request IDs exist; metrics/tracing/dashboards/alerts do not
(ORG-PR-007), and there is no incident process/runbook/on-call (ORG-PR-008) or
production ops documentation (ORG-PR-027). No logger redaction backstop
(ORG-PR-033) — **closed in Sprint 19** (centralized pino redaction in
`apps/api/src/lib/logging.ts`, log-capture tested). Required alerts: readiness
failure, error-budget burn, rate-limit/fail-open events (now including the
sanitized `rate-limit-store` unavailability warnings emitted since Sprint 19),
audit-writer failure, backup failure, certificate/email health.

## Maintenance jobs (implemented as commands — ORG-PR-015 closed; scheduling open — ORG-PR-016)

The Sprint 14 audit listed the maintenance jobs a production deployment would
need. Sprint 25 implemented the retention half as a single one-shot command and
resolved several of the proposed rows **against the actual schema** rather than
carrying them forward as intentions:

| State | Data | Sprint 25 outcome | Notes |
| --- | --- | --- | --- |
| Expired sessions | `sessions` | **Implemented** — `expired_sessions` category, `expires_at < cutoff` (default 90 d), index-backed | Deletes the session's `refresh_tokens` children in the same transaction (no `ON DELETE CASCADE` exists, deliberately) |
| Expired/used refresh tokens | `refresh_tokens` | **Implemented** — `expired_refresh_tokens`, `expires_at < cutoff` (default 90 d) | Runs before the session sweep so the child rows are gone first |
| Expired invitations | `invitations` | **Deliberately NOT implemented** | `schema/invitations.ts` declares invitation rows durable lifecycle records ("Rows are NEVER hard-deleted"); accepted/revoked rows are the audit trail of who joined an organization. Reclaiming that storage would destroy history the product exposes |
| Reset/verification tokens | `email_verification_tokens`, `password_reset_tokens`, `pending_registrations` | **Implemented** — three categories on `expires_at < cutoff` (default 30 d) | An expired token is already refused at use time, so an eligible row is dead state by the schema's own rules |
| Revoked/expired API keys | `api_keys` | **Deliberately NOT implemented** | `schema/api-keys.ts`: revoked, never hard-deleted — the revoked row is what proves a key existed |
| Audit/security retention | `security_events` | **Implemented** — `security_events`, `created_at < cutoff` (default 180 d, floor 30 d) | GLOBAL, not per plan: `audit_retention_days` remains a display-only modeled value. The default is pinned above the largest plan value (90) by a config test. PII residual: ORG-PR-043 |
| Deleted accounts | `users` | **Out of scope, correctly** | Account deletion is a product feature with consent, export, and cascade semantics (ORG-PR-025/043) — not a maintenance sweep. No category may reach `users` |

Against the Sprint 14 requirements for each job:

| Requirement | Status |
| --- | --- |
| Idempotency | **Met** — proven by an integration test (a second apply deletes nothing) |
| Bounded batch sizes | **Met** — one `LIMIT`-ed batch per transaction, oldest rows first, plus a `--max-batches` cap; batch and cap behavior are test-pinned |
| Concurrency lock | **Not implemented.** Concurrent runs are SAFE (transactional batches over an idempotent predicate; worst case is wasted work) but nothing prevents them. A scheduled deployment should use its scheduler's own concurrency control |
| Metrics | **Not implemented** — the run prints a counts-only summary to stdout |
| Failure alerts | **Not implemented** (ORG-PR-007/016) |
| Scheduling | **Not implemented** (ORG-PR-016) — the command is invoked by an operator |

Safety properties worth recording here rather than only in
[../retention.md](../retention.md): deletion requires `--apply` (dry-run is the
default and no other flag combination reaches apply mode); every predicate is
an age comparison on a timestamp column, never a status field; the comparison
is strictly `<`, so a row at the cutoff survives; retention windows have hard
floors so a zero or negative value fails process start instead of widening the
predicate; and the summary emits counts and table metadata only — an
integration test asserts no email, token hash, user id, or password-hash marker
can appear in it.

## Privacy & data governance

PII inventory: user email + password hash; session/security IP + user-agent;
invited email in invitations and audit metadata; audit/security event bodies.
**Gaps:** no export/deletion (ORG-PR-025); email PII in `security_events`
metadata is now bounded by the global retention window (default 180 days,
Sprint 25) but is neither anonymized nor subject to a legally-reviewed period
(ORG-PR-043) — retention bounds growth, it is not erasure. All legal
determinations
(applicable regime, retention periods, subprocessor list, breach timelines) are
marked **Legal review required** and are out of scope for this audit.

## Developer operations

**Strengths:** excellent local DX — `validate`/`validate:integration`, schema-drift
guard, migrate-from-scratch test, idempotent demo seed, strong extension
recipes; strict TypeScript including repo-wide `noUncheckedIndexedAccess`
(ORG-PR-040 closed, Sprint 21); local scanner commands (`scan:deps`,
`scan:deps:local`, `scan:secrets`) mirroring CI. **Gaps:** production ops
undocumented (ORG-PR-027), no security-focused lint rules, stale subsystem
docs (ORG-PR-046).
