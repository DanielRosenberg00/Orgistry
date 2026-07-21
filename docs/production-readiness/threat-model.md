# Threat Model

Orgistry-specific threat model for the [production target](production-target.md)
(self-hosted, single-region, low-scale multi-tenant B2B identity foundation).

## Scope

The Fastify API (authority), its PostgreSQL and Redis stores, the invitation email
path, the machine-credential external API, and the thin web-demo consumer. Out of
scope: the operator's host OS, the reverse proxy internals, and the email
provider's own security (assessed as trust-boundary assumptions).

## Assets

- **A-CRED** — user credentials (Argon2id hashes) and the ability to authenticate.
- **A-SESSION** — session/refresh tokens granting account access.
- **A-JWT** — the HS256 signing secret (forgery of any access token).
- **A-TENANT** — per-organization data isolation.
- **A-KEY** — machine API-key secrets and their org-scoped data.
- **A-INVITE** — invitation tokens (grant membership on acceptance).
- **A-AUDIT** — integrity/availability of audit & security event records.
- **A-PII** — emails, IP/UA, membership graph.
- **A-AVAIL** — service availability and the database of record.

## Trust boundaries (data flow)

```
 [Browser SPA]───TLS──▶[Reverse proxy]───▶[API]──▶[PostgreSQL]
   in-mem token          TLS term,           │ └──▶[Redis] (rate limits, fail-open)
   HttpOnly cookie       headers, WAF,        │
                         global rate limit    └──▶[SMTP provider]──▶[Invitee inbox]
 [Machine client]──API key──▶[API /v1/external] (tenant derived from key)
```

- **B1** Internet → proxy: TLS, headers, global rate limiting (proxy is the
  intended `trustProxy` hop — ORG-PR-010/011/012 live here). *Sprint 19
  (2026-07-21): the API now enforces its own security headers and a global
  per-trusted-IP limit at this boundary — ORG-PR-010/011/012 closed.*
- **B2** Proxy → API: the API assumes it is fronted; today it sets no `trustProxy`,
  so per-IP controls degrade (ORG-PR-010). *Sprint 19: closed — typed
  `TRUST_PROXY` (`'false'` default | hop count | IP/CIDR list); with trust
  disabled, `X-Forwarded-*` is ignored and `request.ip` is the socket peer, so
  forwarded-header spoofing is impossible.*
- **B3** API → PostgreSQL/Redis: single superuser today (ORG-PR-022); Redis
  fail-open (ORG-PR-009). *Sprint 19: ORG-PR-009 materially advanced —
  sensitive buckets fail closed under the production-default
  `RATE_LIMIT_FAILURE_MODE=closed`; the global bucket fails open by design;
  alerting residual → ORG-PR-007.*
- **B4** API → SMTP → invitee: currently Mailpit only (ORG-PR-002).
- **B5** SPA ↔ API: cookie + CSRF-header + CORS allow-list; token in memory.

## Actors

External unauthenticated attacker; authenticated tenant user (incl. malicious
member/Admin); machine API-key holder; malicious/compromised org administrator;
operator (insider/error); supply-chain/CI attacker.

## Assumptions

- The proxy terminates TLS and will be configured as the trusted hop.
- CORS `CORS_ORIGINS` is correctly set (CSRF defense depends on it — B5).
- The email provider and secrets manager are trustworthy once integrated.
- No production instance/data exists yet, so "likelihood" is assessed for the
  target deployment, not the current repo.

## Risk method

Qualitative. **Risk = Likelihood × Impact**, each Low/Medium/High, combined:

| | Impact Low | Impact Med | Impact High |
| --- | --- | --- | --- |
| **Likelihood High** | Medium | High | Critical |
| **Likelihood Med** | Low | Medium | High |
| **Likelihood Low** | Low | Low | Medium |

Likelihood reflects existing controls; Impact reflects asset value under the
target profile. Severity here is the *threat* risk, distinct from a finding's
P-severity (which also weighs dependency position and effort).

## Threat table

| ID | Threat | Asset | Attacker | Path | Existing controls | Weakness | L | I | Risk | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-CRED | Credential stuffing / password spraying | A-CRED | external | repeated login | per-IP+per-email limits, Argon2id, uniform errors | fail-open on Redis; per-IP collapses behind proxy | M | H | High | ORG-PR-009, 010 |
| T-ENUM | Account enumeration | A-PII | external | register / (future) reset | login hardened | register returns distinct 409 | H | L | Medium | ORG-PR-030, 004 |
| T-TOKEN | Access-token theft | A-SESSION | external | XSS / interception | in-mem token, 15-min TTL, per-request session check | no CSP/headers | L | H | Medium | ORG-PR-011, 035 |
| T-RTOKEN | Refresh-token theft/replay | A-SESSION | external | cookie theft / reuse | HttpOnly+SameSite, hash-only, rotation+reuse-detection | no cookie signing; multi-tab false-positive | L | H | Medium | ORG-PR-050, 047 |
| T-TOKEN-FORGE | JWT forgery via weak/leaked secret | A-JWT | external/insider | guess/steal `JWT_SECRET` | HS256 alg allowlist | dev-default accepted in prod; no rotation | M | H | High | ORG-PR-003, 006, 049 |
| T-CSRF | Cross-site request forgery | A-SESSION | external | forged cookie mutation | SameSite=Lax + custom CSRF header + CORS | header presence-only; depends on CORS list | L | M | Low | ORG-PR-011 |
| T-XSS | Script injection in SPA | A-SESSION | external | injected script | React escaping, in-mem token | no CSP; no error boundary | L | M | Low | ORG-PR-035, 023 |
| T-KEY | API-key leakage / scope bypass | A-KEY | external/holder | leaked key / scope misuse | hash-only, one-time secret, per-request scope+entitlement | no rotation; no create rate limit | M | M | Medium | ORG-PR-032 |
| T-INV | Invitation interception / reuse / mismatch / probing | A-INVITE | external/member | intercept link / guess token / spam | 256-bit hash-only token, email-match, single-use (locked), fail-closed send | unauthenticated inspect unthrottled; no create limit | M | M | Medium | ORG-PR-012, 032 |
| T-PRIV | Privilege escalation (Admin→Owner) | A-TENANT | member/Admin | role-change API | Last-Owner protection, permission-set model | no role-transition guard | M | H | High | ORG-PR-017 |
| T-BOLA | Broken object-level authorization / cross-tenant | A-TENANT | member | forge IDs/cursors | repo org-scoping, uniform 404, negative tests | two read paths skip permission gate (latent) | L | H | Medium | ORG-PR-053 |
| T-QUOTA | Quota bypass under concurrency | A-TENANT | member | concurrent creates | per-request quota check | TOCTOU on create/accept | M | L | Low | ORG-PR-029 |
| T-AUDIT | Audit flooding / metadata leakage / unavailability | A-AUDIT/A-PII | external/auditor | unauth ext requests; email in metadata | sanitized metadata, in-txn writes | pre-auth writes; unindexed org; no retention | M | M | Medium | ORG-PR-013, 014, 015, 043 |
| T-LOG | Log leakage / correlation spoofing | A-PII | insider/external | inbound request-id; future header logging | request-id echoed; audit sanitized | no logger redaction; trusts inbound id | L | L | Low | ORG-PR-033, 052 |
| T-DEP | Dependency compromise | all | supply chain | vulnerable/malicious dep | lockfile, `onlyBuiltDependencies` | high advisory in range; no scanning | M | H | High | ORG-PR-018, 020, 054 |
| T-CI | CI compromise | all | supply chain | hijacked action / broad token | — | mutable tags; no `permissions` | M | H | High | ORG-PR-019, 020 |
| T-SECRET | Secret leakage | A-JWT/A-CRED | insider/external | committed/mismanaged secret | redaction for events | no secrets manager/rotation | M | H | High | ORG-PR-006, 003 |
| T-CONF | Misconfiguration in production | all | operator | boots with dev defaults / no `Secure` | config validation (length only) | no production guards | H | H | Critical | ORG-PR-003 |
| T-DOS | Denial of service | A-AVAIL | external | unthrottled endpoints / slow queries | per-surface auth limits | no global limit; no timeouts; fail-open | M | M | Medium | ORG-PR-012, 013, 021, 009 |
| T-DBLOSS | Database loss / corruption | A-AVAIL | operator/host | host loss, corruption, bad migration | additive migrations, migrate-from-scratch test | no backups/PITR/restore; superuser | M | H | High | ORG-PR-005, 022, 028 |
| T-OPS | Operator error / no observability | A-AVAIL | operator | blind operation, no runbook | `/health` `/ready` | no metrics/alerts/incident process | M | M | Medium | ORG-PR-007, 008, 027 |
| T-MIG | Unsafe migration | A-AVAIL | operator | bad prod migration | transactional, additive | no rollback rehearsal | L | M | Low | ORG-PR-028 |
| T-PRIV-DATA | Data-subject rights unmet | A-PII | operator/legal | export/delete request | soft-delete honored | no export/delete; retention unenforced | M | M | Medium | ORG-PR-025, 043, 015 |

## Sprint 19 mitigation update (2026-07-21)

The threat table above is the Sprint 14 audit baseline, preserved as recorded.
The edge and application security hardening sprint changes the control column
for the following threats (evidence in
[sprint-19-artifact-package.md](sprint-19-artifact-package.md)):

- **T-CRED** — per-IP rate-limit keys, logs, and audit/security-event IPs now
  derive from `request.ip` under typed `TRUST_PROXY` (ORG-PR-010 closed), so
  forwarded-header spoofing cannot rotate limiter identity; sensitive auth
  buckets fail closed on Redis outage under the production default
  (ORG-PR-009 materially advanced). Residual: distributed (many-IP) credential
  stuffing is bounded per IP only, and there is no limiter-outage alerting
  until ORG-PR-007.
- **T-DOS** — a global fixed-window per-trusted-IP limit (default 300/60 s)
  runs `onRequest` before route work, with `/health`, `/ready`, and CORS
  preflight exempt (ORG-PR-012 closed); the global bucket fails open on Redis
  outage by design. Residual: no pool/statement/lock timeouts (ORG-PR-021)
  and per-IP bounding only against distributed abuse.
- **T-INV** — `POST /v1/invitations/inspect` is now throttled per trusted IP
  and per token-derived second-order digest (raw tokens never in Redis keys,
  logs, or events); invitation create is limited per user and per org, accept
  per user (ORG-PR-012/032 closed).
- **T-AUDIT** — durable failed-auth `security_events` writes from the External
  API are bounded per source IP per window; beyond the allowance (or on store
  outage) the write is skipped and a sanitized warn log retains visibility
  (ORG-PR-013 closed, DB-backed storm test). Residual: the unindexed org read
  path (ORG-PR-014), missing retention (ORG-PR-015), and email PII in
  metadata (ORG-PR-043) remain open.
- **T-LOG** — inbound `x-request-id` is sanitized centrally (accepted format
  `[A-Za-z0-9._-]{1,128}`, otherwise replaced with a generated `req_<uuid>`)
  and a centralized pino redaction backstop covers credentials, tokens, and
  secrets across header/body/config/error shapes (ORG-PR-033/052 closed).
- **T-OPS** — `/ready` is coarse in production (ready/not-ready only,
  per-check outcomes logged server-side) and shutdown is idempotent and
  bounded by a 10 s force-exit timer (part of ORG-PR-052). Residual: no
  metrics/alerts/incident process — ORG-PR-007/008/027 remain open.

## Highest residual risks (target profile)

1. **T-CONF (Critical)** — production boot with dev-default secret / non-Secure
   cookie: enables T-TOKEN-FORGE. Closed by ORG-PR-003 (+006).
2. **T-DEP / T-CI (High)** — unscanned dependencies + mutable CI actions.
3. **T-CRED (High)** — brute-force window widened by fail-open limits and proxy IP
   collapse. *Sprint 19 (2026-07-21): both weaknesses resolved (ORG-PR-010
   closed; production fails closed) — residual is distributed abuse bounded
   per IP only and the missing limiter-outage alerting (ORG-PR-007).*
4. **T-PRIV (High)** — Admin→Owner escalation pending a policy decision.
5. **T-DBLOSS (High)** — no tested restore path.

Residual risk after the roadmap: with Phases 2–3 (lifecycle + hardening) and
Phase 4–5 (infra + reliability) complete, T-CONF/T-TOKEN-FORGE/T-CRED/T-DBLOSS
drop to Low–Medium; T-DEP/T-CI drop to Medium with scanning; T-QUOTA and T-BOLA
remain Low and are closed by ORG-PR-029/053. An external security review
(ORG-PR-018 track / standards-matrix) is required before asserting residual risk
is acceptable for launch.
