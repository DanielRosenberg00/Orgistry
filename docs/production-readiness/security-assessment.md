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

**Gaps:** Admin can confer Owner with no role-transition guard (ORG-PR-017 —
the governing policy, DG-2, was ratified by the Project Owner in Sprint 15:
only active Owners may grant/remove Owner; enforcement remains open until
Sprint 19). Two read paths authorize on membership alone, diverging
from the pattern (ORG-PR-053; also a doc drift, ORG-PR-046).

## Concurrency correctness

**Strengths:** Last-Owner protection and refresh rotation are serialized with
`FOR UPDATE` and covered by real-Postgres concurrency tests; invitation acceptance
of a single token is atomic (row lock + single-use mutation + unique membership
index).

**Gaps:** quota ceilings for project/API-key/invitation *creation* check counts
outside the write transaction, and acceptance across *distinct* invitations races
under READ COMMITTED — all can overrun the ceiling (ORG-PR-029). Concurrency
tests are narrow (ORG-PR-044).

## Database & migrations

**Strengths:** disciplined schema with partial unique indexes enforcing the
active-membership and pending-invitation invariants; additive, transactional
migrations; a thorough migrate-from-scratch integration test; keyset pagination
everywhere with bounded limits.

**Gaps:** `security_events.organization_id` is unindexed on the audit read path
(ORG-PR-014); no retention for unbounded tables (ORG-PR-015); one app+migration
superuser (ORG-PR-022); no pool/statement/lock timeouts (ORG-PR-021); no
rollback strategy (ORG-PR-028); the personal-workspace invariant is unenforced
(ORG-PR-038); `reset-test` guard weaker than documented (ORG-PR-037); dead
`email_verification_tokens` (ORG-PR-048) and a redundant index (ORG-PR-051).

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

## Dependencies & supply chain

**Strengths:** `pnpm-lock.yaml` + `--frozen-lockfile`; `onlyBuiltDependencies`
restricts postinstall scripts to esbuild; well-chosen primitives (`@node-rs/argon2`,
`jose`). **Gaps:** high `drizzle-orm` advisory in range (ORG-PR-018) and moderate
dev-only `esbuild` (ORG-PR-054); no automated scanning/updates (ORG-PR-020); CI
actions on mutable tags with default token perms (ORG-PR-019); floating Docker
tags (ORG-PR-042); no SBOM/provenance/signing.

## CI/CD & release readiness

`ci.yml` mirrors local validation across two jobs with PG+Redis service
containers. **Gaps:** ORG-PR-019 (pinning/permissions), ORG-PR-020 (scanning),
ORG-PR-041 (SMTP untested), ORG-PR-001 (no release/deploy pipeline, no artifacts,
no tags, no versioning). The minimum release pipeline for the target is defined in
[production-roadmap.md](production-roadmap.md).

## Infrastructure & deployment

No app Dockerfiles, IaC, or environment provisioning (ORG-PR-001). The recommended
simplest architecture (reverse proxy + TLS + 2 API replicas + managed Postgres/
Redis + real SMTP + scheduler + secrets manager, **not Kubernetes**) is in
[production-target.md](production-target.md). Depends on: security headers/proxy
config (ORG-PR-010/011), timeouts (ORG-PR-021), least-privilege DB roles
(ORG-PR-022), floating-tag pinning (ORG-PR-042).

## Reliability, backup & DR

No backups/PITR/restore (ORG-PR-005) — a P1 blocker with a **mandatory restore
drill** before production data. No migration recovery rehearsal (ORG-PR-028). No
background runtime (ORG-PR-016). Redis fail-open (ORG-PR-009) and best-effort
writes that can fail requests (ORG-PR-034) are the main runtime-resilience gaps;
degraded-dependency behavior is untested against live services (ORG-PR-026).
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

## Maintenance jobs (required, none implemented — ORG-PR-015/016)

| State | Data | Suggested schedule | Notes |
| --- | --- | --- | --- |
| Expired sessions | `sessions` | daily | idempotent, locked; metric on rows purged |
| Expired/used refresh tokens | `refresh_tokens` | daily | keep family history within retention |
| Expired invitations | `invitations` | daily | already derived-on-read; reclaim storage |
| Reset/verification tokens | `email_verification_tokens` (+ future reset) | hourly | short TTL cleanup |
| Revoked/expired API keys | `api_keys` | weekly | optional hard-delete per policy |
| Audit/security retention | `security_events` | daily | enforce `audit_retention_days`; PII (ORG-PR-043) |
| Deleted accounts | `users` | on-demand + sweep | anonymize/hard-delete (ORG-PR-025) |

Each job needs: idempotency, a concurrency lock, metrics, failure alerts, and
bounded batch sizes. None exist today.

## Privacy & data governance

PII inventory: user email + password hash; session/security IP + user-agent;
invited email in invitations and audit metadata; audit/security event bodies.
**Gaps:** no export/deletion (ORG-PR-025), email PII retained with no retention
(ORG-PR-043), no retention enforcement (ORG-PR-015). All legal determinations
(applicable regime, retention periods, subprocessor list, breach timelines) are
marked **Legal review required** and are out of scope for this audit.

## Developer operations

**Strengths:** excellent local DX — `validate`/`validate:integration`, schema-drift
guard, migrate-from-scratch test, idempotent demo seed, strong extension recipes.
**Gaps:** production ops undocumented (ORG-PR-027), `noUncheckedIndexedAccess` off
(ORG-PR-040), no security-focused lint rules, stale subsystem docs (ORG-PR-046).
