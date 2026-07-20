# Findings Register

Authoritative source for all Sprint 14 production-readiness findings. Every other
document references these IDs and must not restate a different severity or title.
Severity, classification, and confidence conventions are defined in
[README.md](README.md#finding-severity-conventions).

**No P0 findings.** P0 denotes an immediate critical risk requiring emergency
remediation before any further work. The audit found no such condition: no
evidence of an active compromise, no exposed production secret in the repository
or its history, no data-loss event, and no immediately exploitable critical flaw
in the implemented code. The highest-severity confirmed gaps are the *absence* of
a production envelope (deployment, email, config guards, recovery, backup, secrets
management); these are production-launch blockers and are therefore classified P1.
A P1 finding is held at P1 — not lowered — even though it would only become
critical once the system is deployed as-is; severity is not reduced because the
system is pre-production.

Counts: **6 P1**, **22 P2**, **17 P3**, **9 P4** — 54 total (at Sprint 14 audit
time; original entries below are preserved as recorded).

**Status update (Sprint 15, 2026-07-18):** [ORG-PR-003](#org-pr-003) (P1) and
[ORG-PR-047](#org-pr-047) (P4) are **Closed** with implementation and test
evidence — see the *Resolution* line appended to each entry. **Open P1
production blockers: ORG-PR-001, ORG-PR-002, ORG-PR-004, ORG-PR-005,
ORG-PR-006.** In particular, ORG-PR-006 (secrets management/rotation) is *not*
closed by the Sprint 15 config guard — rejecting weak secrets is not secrets
management. The repository remains not ready for staging or production.

**Status update (Sprint 16, 2026-07-18):** [ORG-PR-024](#org-pr-024) (P2) and
[ORG-PR-048](#org-pr-048) (P4) are **Closed** — the full email-verification
lifecycle is implemented, active product behavior, and lifecycle-tested (unit +
DB-backed integration, including concurrent-completion race coverage).
[ORG-PR-002](#org-pr-002) (P1) **remains Open, materially advanced**: a
production SMTP adapter (nodemailer transport: implicit TLS with verification,
negotiated SASL auth), deterministic driver selection, and fail-closed
production mail config now exist, but **no delivery through a real external
provider to a real inbox has been performed** (no provider credentials in any
validation environment) — adapter existence is not delivery evidence. **Open P1 production blockers: ORG-PR-001, ORG-PR-002,
ORG-PR-004, ORG-PR-005, ORG-PR-006.** The repository remains not ready for
staging or production. See
[email-and-verification.md](../email-and-verification.md).

**Status update (Sprint 17, 2026-07-20):** [ORG-PR-004](#org-pr-004) (P1) and
[ORG-PR-039](#org-pr-039) (P3) are **Closed** — the full credential lifecycle
(enumeration-safe password recovery over a dedicated hash-only
`password_reset_tokens` table with `FOR UPDATE` race-safe completion and full
session/refresh revocation; current-password-gated password change and email
change) is implemented, lifecycle-tested (unit + DB-backed integration,
including the concurrent-completion race), and documented — see the
*Resolution* line on each entry and
[credential-management.md](../credential-management.md).
[ORG-PR-030](#org-pr-030) (P3) **remains Open, materially advanced**: the
registration duplicate-email 409 is now bounded by a per-email-digest rate
limit and recorded as a durable probe event, but the conflict itself is still
distinguishable; full response uniformity requires a verification-first
registration redesign. **Open P1 production blockers: ORG-PR-001, ORG-PR-002,
ORG-PR-005, ORG-PR-006.** The repository remains not ready for staging or
production.

## Summary table

| ID | Title | Domain | Class | Sev | Conf |
| --- | --- | --- | --- | --- | --- |
| [ORG-PR-001](#org-pr-001) | No production deployment automation (Dockerfiles/IaC/pipeline) | Infrastructure | Production blocker | P1 | High |
| [ORG-PR-002](#org-pr-002) | No production email provider (Mailpit-only) — **Open; materially advanced (Sprint 16): adapter + guard exist, external delivery unvalidated** | Email/Infra | Production blocker | P1 | High |
| [ORG-PR-003](#org-pr-003) | Dev-default secrets accepted & `COOKIE_SECURE` unenforced under `NODE_ENV=production` — **Closed (Sprint 15)** | Secrets/Config | Production blocker | P1 | High |
| [ORG-PR-004](#org-pr-004) | No password recovery flow — **Closed (Sprint 17)** | Account lifecycle | Product completeness gap | P1 | High |
| [ORG-PR-005](#org-pr-005) | No database backup / PITR / tested restore | Backup & DR | Production blocker | P1 | High |
| [ORG-PR-006](#org-pr-006) | No secrets management or rotation procedure | Secrets/Ops | Production blocker | P1 | High |
| [ORG-PR-007](#org-pr-007) | No observability (metrics/tracing/dashboards/alerts) | Observability | Operational gap | P2 | High |
| [ORG-PR-008](#org-pr-008) | No incident response / production runbook / on-call | Operations | Operational gap | P2 | High |
| [ORG-PR-009](#org-pr-009) | Rate limiting fails open on Redis outage | Auth/App security | Security risk | P2 | High |
| [ORG-PR-010](#org-pr-010) | `trustProxy` unset → per-IP limits and audit IPs invalid behind a proxy | Auth/App security | Security risk | P2 | High |
| [ORG-PR-011](#org-pr-011) | No HTTP security headers (helmet) | App security | Security risk | P2 | High |
| [ORG-PR-012](#org-pr-012) | No global/edge rate limiting; unauthenticated `invitations/inspect` oracle unthrottled | App security | Security risk | P2 | High |
| [ORG-PR-013](#org-pr-013) | External API writes an un-throttled `security_events` row per unauthenticated request | App security/Reliability | Reliability risk | P2 | High |
| [ORG-PR-014](#org-pr-014) | `security_events` lacks an `organization_id` index backing the audit read path | Database/Perf | Reliability risk | P2 | High |
| [ORG-PR-015](#org-pr-015) | No retention/cleanup for unbounded tables | Data governance | Operational gap | P2 | High |
| [ORG-PR-016](#org-pr-016) | No background-processing runtime (workers/scheduler) | Reliability | Operational gap | P2 | High |
| [ORG-PR-017](#org-pr-017) | Admin can escalate self/others to Owner (no role-transition guard) | Authorization | Security risk | P2 | Medium |
| [ORG-PR-018](#org-pr-018) | `drizzle-orm` high-severity advisory (installed `<0.45.2`) | Supply chain | Security risk | P2 | Medium |
| [ORG-PR-019](#org-pr-019) | CI actions pinned to mutable tags; no workflow `permissions` block | CI/CD | Security risk | P2 | High |
| [ORG-PR-020](#org-pr-020) | No dependency/vuln/secret/SAST scanning in CI | Supply chain | Operational gap | P2 | High |
| [ORG-PR-021](#org-pr-021) | No DB pool / statement / lock timeouts | Reliability | Reliability risk | P2 | Medium |
| [ORG-PR-022](#org-pr-022) | App and migrations share a single Postgres superuser | Infra/Security | Security risk | P2 | High |
| [ORG-PR-023](#org-pr-023) | No React error boundary; a render throw blanks the SPA | Frontend | Reliability risk | P2 | High |
| [ORG-PR-024](#org-pr-024) | No email verification (unused `email_verification_tokens` scaffolding) — **Closed (Sprint 16)** | Account lifecycle | Product completeness gap | P2 | High |
| [ORG-PR-025](#org-pr-025) | No account deletion / data export (data-subject rights) | Privacy | Compliance dependency | P2 | High |
| [ORG-PR-026](#org-pr-026) | No failure-injection / degraded-dependency integration tests | Testing | Reliability risk | P2 | Medium |
| [ORG-PR-027](#org-pr-027) | No production operations documentation | Documentation | Operational gap | P2 | High |
| [ORG-PR-028](#org-pr-028) | No migration rollback / recovery strategy | Database | Operational gap | P2 | High |
| [ORG-PR-029](#org-pr-029) | Quota ceilings are TOCTOU-racy under concurrency | Concurrency | Data-integrity risk | P3 | High |
| [ORG-PR-030](#org-pr-030) | User enumeration on registration — **Open; materially advanced (Sprint 17): per-email throttle + probe events; 409 still distinguishable** | Auth | Security risk | P3 | High |
| [ORG-PR-031](#org-pr-031) | No idempotency keys on create operations | API | Reliability risk | P3 | Medium |
| [ORG-PR-032](#org-pr-032) | Spammable authenticated mutations lack rate limits | App security | Security risk | P3 | High |
| [ORG-PR-033](#org-pr-033) | No structured-logger redaction backstop | Observability/Security | Maintainability issue | P3 | Medium |
| [ORG-PR-034](#org-pr-034) | "Best-effort" last-used / auth-event writes not isolated | Reliability | Reliability risk | P3 | Medium |
| [ORG-PR-035](#org-pr-035) | No CSP / security meta in the web demo | Frontend | Security risk | P3 | Medium |
| [ORG-PR-036](#org-pr-036) | Frontend UX/robustness gaps (revoke confirm, deep-link, expiry UX, a11y) | Frontend | Developer-experience issue | P3 | High |
| [ORG-PR-037](#org-pr-037) | `reset-test` destructive guard weaker than documented | Database/DX | Maintainability issue | P3 | High |
| [ORG-PR-038](#org-pr-038) | "One personal workspace per user" invariant unenforced | Database | Data-integrity risk | P3 | Medium |
| [ORG-PR-039](#org-pr-039) | No password-change / email-change flows — **Closed (Sprint 17)** | Account lifecycle | Product completeness gap | P3 | High |
| [ORG-PR-040](#org-pr-040) | `noUncheckedIndexedAccess` disabled | Type safety/DX | Maintainability issue | P3 | High |
| [ORG-PR-041](#org-pr-041) | Mailpit / live SMTP path never exercised in CI | Testing | Operational gap | P3 | High |
| [ORG-PR-042](#org-pr-042) | Docker infra images pinned by floating tags | Supply chain | Maintainability issue | P3 | High |
| [ORG-PR-043](#org-pr-043) | PII in audit/security metadata with no retention | Privacy | Compliance dependency | P3 | Medium |
| [ORG-PR-044](#org-pr-044) | Narrow concurrency test coverage | Testing | Reliability risk | P3 | High |
| [ORG-PR-045](#org-pr-045) | No MFA/passkeys and no security notifications | Account lifecycle | Product completeness gap | P3 | High |
| [ORG-PR-046](#org-pr-046) | Stale/contradictory subsystem documentation | Documentation | Developer-experience issue | P4 | High |
| [ORG-PR-047](#org-pr-047) | `COOKIE_SECRET` required but never used (unsigned cookies) — **Closed (Sprint 15)** | Config | Maintainability issue | P4 | High |
| [ORG-PR-048](#org-pr-048) | `email_verification_tokens` dead schema shipped — **Closed (Sprint 16)** | Database | Maintainability issue | P4 | High |
| [ORG-PR-049](#org-pr-049) | HS256 symmetric JWT with no `kid`/rotation path | Cryptography | Optional enhancement | P4 | High |
| [ORG-PR-050](#org-pr-050) | Concurrent legitimate refresh revokes family + session (multi-tab logout) | Auth | Reliability risk | P4 | High |
| [ORG-PR-051](#org-pr-051) | Redundant unique index duplicates PK on `role_permissions` | Database | Optional enhancement | P4 | High |
| [ORG-PR-052](#org-pr-052) | Minor API disclosures (`/ready` deps, inbound `x-request-id`, no shutdown timeout) | API | Maintainability issue | P4 | Medium |
| [ORG-PR-053](#org-pr-053) | Two read paths skip the permission gate (divergence, no current gap) | Authorization | Maintainability issue | P4 | High |
| [ORG-PR-054](#org-pr-054) | `esbuild` moderate dev-only advisory (via `drizzle-kit`) | Supply chain | Optional enhancement | P4 | High |

---

## Detailed findings

Fields: Classification · Severity · Confidence · Status (fact/inference/assumption)
· Evidence · Current behavior · Expected production behavior · Risk · Remediation
· Dependencies · Effort (S/M/L/XL) · Required validation · Roadmap phase ·
Standards · Threats.

> **Note on the `Standards:` tags.** Any standard reference in a finding (e.g.
> "ASVS", "SSDF", "SLSA") is an **informal practice-level pointer** into
> [standards-matrix.md](standards-matrix.md), not a verified control identifier.
> Exact standard identifiers were not verifiable in this environment; see the
> matrix's verification-basis note. The `Threats:` tags reference
> [threat-model.md](threat-model.md).

<a id="org-pr-001"></a>
### ORG-PR-001 — No production deployment automation
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** `git ls-files | grep -i dockerfile` → none; only `infra/docker-compose.yml` (local Postgres/Redis/Mailpit). `.github/workflows/` contains only `ci.yml` (no release/deploy job). `git tag` → empty. All `package.json` are `version: 0.0.0`, `private: true`. `docs/known-limitations.md` confirms "no production deployment automation."
- **Current behavior:** The API and web demo have no container image, no infrastructure-as-code, no environment provisioning, and no deploy pipeline. The apps run only via `pnpm dev:*` locally.
- **Expected production behavior:** A reproducible, immutable artifact per app (multi-stage Dockerfile, non-root runtime) built and promoted by a pipeline to a target environment, with migration orchestration and rollback.
- **Risk:** The system cannot be deployed to production at all; nothing downstream (staging, restore drill, launch) can proceed.
- **Remediation:** Add a production Dockerfile per app, minimal IaC for the selected profile (see [production-target.md](production-target.md)), and a build→migrate→deploy pipeline. **Not implemented during the Sprint 14 audit.**
- **Dependencies:** Requires the production target decision. Blocks ORG-PR-005, ORG-PR-007, ORG-PR-008.
- **Effort:** L. **Validation:** a tagged build deploys to a target environment reproducibly; container runs as non-root.
- **Roadmap:** Phase 4 (Production infrastructure). **Standards:** SLSA build/provenance; SSDF PW.6/PO.3. **Threats:** T-DEP, T-OPS.

<a id="org-pr-002"></a>
### ORG-PR-002 — No production email provider (Mailpit-only)

> **Status: OPEN — materially advanced (Sprint 16, 2026-07-18).** The
> Evidence/Current behavior lines below describe the **Sprint 14 audit
> baseline**, preserved as recorded. Sprint 16 delivered the adapter half of
> the remediation: a shared account-mailer boundary
> (`apps/api/src/modules/mail/`) with a production SMTP adapter
> (`smtp-account-mailer.ts`, nodemailer transport per the refinement
> iteration — implicit TLS with certificate/hostname verification, auth
> negotiated by nodemailer from server capabilities (AUTH PLAIN directly
> test-evidenced), bounded
> timeouts, construction-time config validation, central header-injection
> guard, no credential logging), explicit deterministic driver selection
> (`MAIL_DRIVER`), and a fail-closed production config guard (production
> refuses the Mailpit/memory drivers, missing or placeholder SMTP credentials,
> non-routable senders, and localhost/non-HTTPS public web URLs). The TLS +
> auth conversation is covered by automated tests against an in-process fake
> server, and live local delivery to the Mailpit container was re-verified.
> **What keeps this open:** the required validation is a *live send through a
> real external provider to a real inbox*, and that has NOT been performed —
> no provider credentials or sandbox inbox exist in the validation
> environment. Adapter existence is not delivery evidence. The exact safe
> validation procedure is documented in
> [email-and-verification.md](../email-and-verification.md#external-provider-validation).
> Bounce/complaint handling and suppression lists remain out of scope
> (deliberately, per the Sprint 16 boundary) and are tracked by this finding's
> original expected-behavior text.

- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** `apps/api/src/modules/invitations/invitation.mailpit-mailer.ts — createMailpitInvitationMailer` (raw `net` SMTP, no auth/TLS) is the only non-test `InvitationMailer` implementation. `infra/docker-compose.yml` service `mailpit`. `docs/known-limitations.md`: "Email is delivered only to the local Mailpit container."
- **Current behavior:** Invitations (and any future verification/reset email) can be delivered only to a local dev sink. There is no deliverability, templating, DKIM/SPF, or bounce handling. **Confirm which mailer `server.ts` instantiates in production** (unknown noted below).
- **Expected production behavior:** A real provider behind the existing `InvitationMailer` interface with authenticated TLS SMTP/API, verified sending domain, and bounce/complaint handling.
- **Risk:** Invitations undeliverable to real recipients; blocks any email-dependent lifecycle feature (ORG-PR-004, ORG-PR-024). Because invitation create is **fail-closed** (`invitation.service.ts — createInvitation` sends before persisting), a broken provider makes invitation creation fail entirely.
- **Remediation:** Implement a production mailer adapter; wire via config; verify delivery. The clean interface abstraction (`InvitationMailer`) makes this swap-in only.
- **Dependencies:** Blocks ORG-PR-004, ORG-PR-024, ORG-PR-045. **Effort:** M. **Validation:** live send to an external inbox in staging; CI SMTP assertion (ORG-PR-041).
- **Roadmap:** Phase 2 (Account lifecycle) / Phase 4. **Standards:** ASVS V2 recovery prerequisites. **Threats:** T-INV.

<a id="org-pr-003"></a>
### ORG-PR-003 — Dev-default secrets accepted & `COOKIE_SECURE` unenforced in production

> **Status: CLOSED (Sprint 15, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as recorded;
> they no longer describe the repository. See the **Resolution** line at the
> end of this entry for the current state.

- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact (independently re-checked).
- **Evidence:** `packages/config/src/schema.ts` — `JWT_SECRET: z.string().min(16)` (L74), `COOKIE_SECRET … .min(16)` (L75-77), `COOKIE_SECURE: booleanFromEnv.default('false')` (L81). No `refine`/`superRefine`/`NODE_ENV` cross-check (grep confirmed). `packages/config/src/index.ts:100` computes `isProduction` but nothing consumes it for enforcement. `.env.example:60-61` ships `JWT_SECRET=dev-only-jwt-secret-change-me` / `COOKIE_SECRET=dev-only-cookie-secret-change-me` — both ≥16 chars, so they **pass** validation under `NODE_ENV=production`.
- **Current behavior:** A production process boots successfully with the shipped guessable HS256 secret and with the refresh cookie lacking `Secure`.
- **Expected production behavior:** Startup refuses known dev-default secret values and low-entropy secrets in production, and forces `COOKIE_SECURE=true` (or refuses to boot without it) when `NODE_ENV=production`.
- **Risk:** With a public/guessable JWT secret an attacker can forge access tokens (full account/tenant takeover). Without `Secure`, the refresh cookie can leak over plaintext. This is the single highest-impact misconfiguration the config layer fails to prevent.
- **Remediation:** Add a production `superRefine`: reject the known dev defaults and require `COOKIE_SECURE=true`; consider a minimum entropy/length floor for production. **Config-only change; not implemented during the Sprint 14 audit (later implemented in Sprint 15 — see Resolution below).**
- **Dependencies:** Related to ORG-PR-006. **Effort:** S. **Validation:** unit test asserts production config rejects dev defaults and `COOKIE_SECURE=false`.
- **Roadmap:** Phase 3 (Security hardening). **Standards:** ASVS V6/V3, V14 config; SSDF PW.9. **Threats:** T-TOKEN-FORGE, T-CONF.
- **Resolution (Sprint 15, 2026-07-18): CLOSED.** `envSchema` now applies `enforceProductionConfigSafety` (`packages/config/src/production-policy.ts`, wired via `superRefine` in `packages/config/src/schema.ts`). Under `NODE_ENV=production`, `loadConfig` throws `ConfigValidationError` for: known dev-default/fixture/CI secrets (exact match), `JWT_SECRET` < 32 chars, placeholder-marker values, single-repeated-character values, and `COOKIE_SECURE=false` (explicit or defaulted). The guard runs inside the only parse path, and `apps/api/src/server.ts — main` calls `getConfig()` before any service or `listen`, so unsafe production config cannot boot the API. Evidence: `packages/config/src/config.test.ts` — `production configuration guard (NODE_ENV=production)` suite (positive + all negative cases; messages name the field and never echo the secret). Docs: [docs/production-config-guard.md](../production-config-guard.md). Note: this does **not** close ORG-PR-006 (no secrets manager, no rotation, no entropy proof).

<a id="org-pr-004"></a>
### ORG-PR-004 — No password recovery flow
- **Class / Sev / Conf:** Product completeness gap · P1 · High · Verified fact (absence).
- **Evidence:** `grep -rniE "password.?reset|forgot|reset-password" apps/api/src packages --include=*.ts` (excl. tests) → zero non-test matches. No reset-token table (only the unused `email_verification_tokens`). No route, service, or web surface. Login/registration exist (`auth.routes.ts`), establishing password auth is implemented while recovery is absent.
- **Current behavior:** A user who forgets their password is permanently locked out; no self-service recovery.
- **Expected production behavior:** Email-driven reset with a single-use, expiring, hash-only token (mirroring the invitation token design), rate-limited request endpoint, enumeration-safe response, and session invalidation on reset.
- **Risk:** Permanent lockout for any forgetful user; unsustainable support burden; effective account/data loss for that user. Standard expectation for any real multi-user product.
- **Remediation:** Build the reset flow on the existing opaque-token + mailer primitives. **Depends on ORG-PR-002.**
- **Dependencies:** ORG-PR-002 (email), ORG-PR-016 (token expiry cleanup). **Effort:** M. **Validation:** integration tests for request/redeem/expiry/reuse/enumeration.
- **Roadmap:** Phase 2. **Standards:** ASVS V2.5 (credential recovery). **Threats:** T-ENUM, T-CRED.
- **Resolution (Sprint 17, 2026-07-20): CLOSED.** Full recovery flow implemented on the existing opaque-token + mailer primitives, exactly as the remediation specified: public `POST /v1/auth/password-recovery/request` (enumeration-safe — identical `{ accepted: true }` for existing/unknown/disabled/soft-deleted accounts and on ANY internal failure incl. account lookup, persistence, mail delivery, and the best-effort security-event write; request events are always anonymous and never account-linked; rate-limited per IP + per normalized-email digest) and public `POST /v1/auth/password-recovery/complete` (raw token + new password in the body only). Dedicated `password_reset_tokens` table (migration `0009`): hash-only 32-byte CSPRNG tokens, short expiry (`PASSWORD_RESET_TTL_SECONDS`, default 1 h), single-use `used_at` + retired-unused `invalidated_at` lifecycle, sibling invalidation on every new generation under a per-user issuance lock (persist-and-commit before send — every emailed token was persisted first, though a later request may supersede a sent link; exactly one generation survives issuance). Completion is ONE transaction under `SELECT … FOR UPDATE` (`password-recovery.repo.ts — completeReset`): password swap + token consumption + sibling invalidation + revocation of EVERY session and refresh token; no session is issued (fresh login required). Reset link uses fragment-only transport (`/auth/reset-password#token=…`) with the Sprint 16 frontend token-hygiene pattern. Evidence: `password-recovery.routes.test.ts` (28 route tests incl. concurrent completion, an eight-scenario enumeration-uniformity matrix under injected lookup/persistence/mail/event-store failures and disabled/soft-deleted states, attribution, and secret-hygiene sweeps), `password-recovery.integration.test.ts` (live PostgreSQL, independently runnable concurrent-generation and concurrent-completion races, durable revocation), web-demo `password-recovery.test.tsx` (15 tests incl. storage/DOM/query-string hygiene). Docs: [credential-management.md](../credential-management.md). Residual (documented, accepted): request-path timing is not fully equalized (existing accounts trigger a synchronous send), bounded by the rate limits.

<a id="org-pr-005"></a>
### ORG-PR-005 — No database backup / PITR / tested restore
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact (absence).
- **Evidence:** No backup config anywhere; `infra/docker-compose.yml` uses a local named volume only. `docs/roadmap.md` lists "No backup/restore story" as a critical gap. `docs/known-limitations.md` confirms no operational tooling.
- **Current behavior:** No automated backups, no point-in-time recovery, no restore procedure, no restore test.
- **Expected production behavior:** Automated encrypted backups + PITR meeting the target RPO/RTO ([production-target.md](production-target.md)), with a **restore drill executed before production data** and re-verified periodically.
- **Risk:** Any data-loss event (operator error, corruption, host loss) is unrecoverable. This is the classic "we had backups but never tested a restore" trap.
- **Remediation:** Use managed-Postgres backups/PITR or documented `pg_dump`/WAL archiving; document and rehearse restore. **Not implemented during the Sprint 14 audit.**
- **Dependencies:** ORG-PR-001 (infra). **Effort:** M. **Validation:** a restore drill reconstructs the DB to a target timestamp and passes readiness/integration checks — mandatory launch gate.
- **Roadmap:** Phase 5 (Reliability & operations). **Standards:** SSDF PO.3; ASVS V14. **Threats:** T-DBLOSS, T-OPS.

<a id="org-pr-006"></a>
### ORG-PR-006 — No secrets management or rotation procedure
- **Class / Sev / Conf:** Production blocker · P1 · High · Verified fact.
- **Evidence:** Secrets sourced from `.env` only (`packages/shared/src/node/load-env.ts`, `.env.example`). No secrets-manager integration; `docs/roadmap.md` lists rotation of `JWT_SECRET`/`COOKIE_SECRET` as future work. `access-token.ts` has no `kid`/versioned-secret support (see ORG-PR-049), so rotation is disruptive.
- **Current behavior:** Production secrets would live in environment/committed-file form with no rotation path and no emergency-compromise procedure.
- **Expected production behavior:** Secrets sourced from a manager (or the platform's secret store), documented routine + emergency rotation, and least-privilege access. No secret in a committed file in any non-local environment.
- **Risk:** Secret sprawl and no response plan for a leaked `JWT_SECRET`/DB credential; compounds ORG-PR-003.
- **Remediation:** Integrate a secrets store; document rotation runbooks; pair with ORG-PR-049 for graceful JWT rotation.
- **Dependencies:** ORG-PR-001, ORG-PR-003. **Effort:** M. **Validation:** a rehearsed rotation of `JWT_SECRET` with no unexpected mass logout beyond the accepted window.
- **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V6.4 (secret management); SSDF PS.1. **Threats:** T-SECRET, T-CONF.

<a id="org-pr-007"></a>
### ORG-PR-007 — No observability (metrics/tracing/dashboards/alerts)
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** No prometheus/prom-client/OpenTelemetry anywhere (grep → 0). Logger is Fastify pino configured only with `{ level }` (`app.ts:136`). `/ready` probe latency is measured (`lib/readiness.ts`) but never exported. `/health` and `/ready` exist but nothing consumes them.
- **Current behavior:** Structured JSON logs with request IDs exist; there are no metrics, traces, dashboards, SLOs, or alerts.
- **Expected production behavior:** Per-route latency/error-rate metrics, request tracing, dashboards, and alerts on readiness failure, error-budget burn, rate-limit spikes, audit-writer failures, and certificate/email/backup health.
- **Risk:** Operators are blind to failures and abuse (compounds ORG-PR-009, ORG-PR-013); no way to detect or diagnose production incidents.
- **Remediation:** Add metrics + tracing exporters and an alerting layer.
- **Dependencies:** ORG-PR-001. **Effort:** L. **Validation:** a dashboard shows per-route latency/error rate; a synthetic readiness failure pages.
- **Roadmap:** Phase 5. **Standards:** ASVS V7 (logging/monitoring); SSDF RV.1. **Threats:** T-OPS, T-DOS.

<a id="org-pr-008"></a>
### ORG-PR-008 — No incident response / production runbook / on-call
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `docs/runbook.md` is explicitly a *local infrastructure* runbook (Docker services + port conflicts). `docs/troubleshooting.md` covers local/CI symptoms only. No on-call, escalation, postmortem, or status-communication docs (doc census).
- **Current behavior:** No production incident-response process, ownership, or runbooks.
- **Expected production behavior:** Runbooks for the top failure modes (DB down, Redis down, deploy rollback, migration recovery, secret compromise, email outage), defined ownership, and a postmortem process.
- **Risk:** Unstructured, slow, error-prone incident handling.
- **Remediation:** Author production runbooks and an incident process (see ORG-PR-027).
- **Dependencies:** ORG-PR-007. **Effort:** M. **Validation:** a tabletop exercise against one runbook. **Roadmap:** Phase 5. **Standards:** SSDF RV.2/RV.3. **Threats:** T-OPS.

<a id="org-pr-009"></a>
### ORG-PR-009 — Rate limiting fails open on Redis outage
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `apps/api/src/lib/rate-limit.ts — createRedisRateLimiter.consume` (L40-51): `try { redis.incr… } catch { return true }` with comment "Fail open: rate limiting must never break auth on a Redis outage." All auth buckets (`auth.service.ts` login/register/refresh) and external-API buckets (`api-key.authenticator.ts`) use it.
- **Current behavior:** During any Redis outage, all login/register/refresh and external-API throttling is silently disabled while auth continues serving.
- **Expected production behavior:** A configurable fail-closed (or degraded) mode for sensitive surfaces (at minimum login), plus alerting when the limiter is bypassed. Documented and intentional today, but a production posture must make the tradeoff explicit and observable.
- **Risk:** A Redis outage opens an unthrottled brute-force / credential-stuffing window with no signal.
- **Remediation:** Add a per-surface fail-closed option and emit a metric/alert when Redis is unavailable.
- **Dependencies:** ORG-PR-007 (alerting). **Effort:** M. **Validation:** test that login fails closed (or degrades) when the limiter throws in the configured mode.
- **Roadmap:** Phase 3. **Standards:** ASVS V11.1 (anti-automation). **Threats:** T-CRED, T-DOS.

<a id="org-pr-010"></a>
### ORG-PR-010 — `trustProxy` unset → per-IP limits and audit IPs invalid behind a proxy
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** No `trustProxy` in `Fastify({...})` (`app.ts:135`); `apps/api/src/lib/request-context.ts:22` uses `request.ip` (socket peer). Per-IP buckets `rl:login:ip`/`rl:register:ip`/`rl:refresh:ip` (`auth.service.ts`) and `security_events.ip_address` derive from it.
- **Current behavior:** Behind a reverse proxy/LB (the standard production topology) `request.ip` is the proxy address: all clients collapse into one per-IP bucket, and every recorded IP is the proxy. The safe side: `X-Forwarded-For` is *not* trusted, so IP spoofing to evade limits is not possible today.
- **Expected production behavior:** A trusted-proxy allow-list so `request.ip` reflects the real client, restoring per-IP throttling and accurate audit IPs — without blindly trusting `X-Forwarded-For`.
- **Risk:** Per-IP login/register limits become a single global bucket (one attacker exhausts it for everyone; per-attacker throttling is impossible); audit/security IPs are useless for investigation.
- **Remediation:** Set `trustProxy` to the known proxy hop(s) once the deployment topology is fixed.
- **Dependencies:** ORG-PR-001 (topology known). **Effort:** S. **Validation:** integration test asserting client IP resolves correctly with a trusted `X-Forwarded-For` and is ignored otherwise.
- **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V11, V7.3 (log integrity). **Threats:** T-CRED, T-DOS, T-AUDIT.

<a id="org-pr-011"></a>
### ORG-PR-011 — No HTTP security headers (helmet)
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** No `helmet`/`@fastify/helmet` anywhere (grep → 0). `app.ts:135` registers only CORS + error handler. No HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- **Current behavior:** Responses carry no security headers.
- **Expected production behavior:** HSTS, `nosniff`, frame-deny, referrer policy, and a response CSP appropriate to an API, applied globally.
- **Risk:** A browser-facing, cookie-authenticating API (`credentials: true`) without header hardening is exposed to clickjacking, MIME sniffing, and downgrade; pairs with the missing frontend CSP (ORG-PR-035).
- **Remediation:** Register a security-headers plugin; align CSP with the SPA.
- **Dependencies:** none. **Effort:** S. **Validation:** response-header assertion test. **Roadmap:** Phase 3. **Standards:** ASVS V14.4 (HTTP security headers). **Threats:** T-XSS, T-CSRF.

<a id="org-pr-012"></a>
### ORG-PR-012 — No global/edge rate limiting; unauthenticated `invitations/inspect` oracle unthrottled
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** Rate limiting exists only in `auth.service.ts` and `api-key.authenticator.ts` (grep `.consume(`); there is no `@fastify/rate-limit` / global `onRequest` throttle. `POST /v1/invitations/inspect` is public and unauthenticated (`invitation.routes.ts:113`) with no limiter.
- **Current behavior:** An unauthenticated attacker can hammer `invitations/inspect` (token-probing + invitation-content disclosure for any valid token) bounded only by 256-bit token entropy, and hit every other unthrottled route freely.
- **Expected production behavior:** A global/edge rate limit (proxy/WAF or a Fastify global limiter) covering unauthenticated and mutation surfaces, in addition to the per-surface auth limits.
- **Risk:** Token-guessing and generic request flooding; combines with ORG-PR-013 for a cheap DoS.
- **Remediation:** Add a global limiter and/or edge rate limiting; throttle `invitations/inspect` specifically.
- **Dependencies:** ORG-PR-010 (accurate client IP). **Effort:** M. **Validation:** limiter test on `invitations/inspect` and a default global bucket. **Roadmap:** Phase 3. **Standards:** ASVS V11.1. **Threats:** T-INV, T-DOS.

<a id="org-pr-013"></a>
### ORG-PR-013 — External API writes an un-throttled `security_events` row per unauthenticated request
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact (independently re-checked).
- **Evidence:** `api-key.authenticator.ts` — the malformed-credential (L118→125) and unknown-key (L134→141) branches call `apiKeys.recordAuthEvent` (a DB INSERT) **before** throwing 401; the rate-limit `consume` calls are only reached at L217/222 *after* key resolution. No global limiter (ORG-PR-012). `security_events` has no `organization_id` index (ORG-PR-014) and no retention (ORG-PR-015).
- **Current behavior:** Every unauthenticated request to `GET /v1/external/projects` with a missing/garbage bearer drives one uncapped INSERT into `security_events`.
- **Expected production behavior:** Pre-authentication abuse is bounded by an edge/global limit; unattributable failed attempts are counted/sampled, not one unbounded row each.
- **Risk:** Unauthenticated table-flooding → unbounded growth, index bloat, degraded audit reads (amplifies ORG-PR-014), and disk-exhaustion DoS.
- **Remediation:** Add edge/global rate limiting ahead of the authenticator (ORG-PR-012); consider sampling/aggregating pre-auth failure events; add the org index (ORG-PR-014) and retention (ORG-PR-015).
- **Dependencies:** ORG-PR-012, ORG-PR-014, ORG-PR-015. **Effort:** M. **Validation:** load test confirming pre-auth writes are bounded. **Roadmap:** Phase 3. **Standards:** ASVS V11.1, V7. **Threats:** T-DOS, T-AUDIT.

<a id="org-pr-014"></a>
### ORG-PR-014 — `security_events` lacks an `organization_id` index backing the audit read path
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact.
- **Evidence:** `packages/db/src/schema/auth.ts — securityEvents` (L151-177) indexes only `user_id`, `event_type`, `created_at`; `organization_id` carries no FK and no index (comment "reserved for future compatibility" is now stale). The audit read query filters `organization_id = ? AND event_type IN (...) ORDER BY created_at DESC, id DESC` plus an unindexed jsonb `metadata->>` filter (`audit.repo.ts`).
- **Current behavior:** Tenant-scoped audit reads scan/bitmap over an append-only, never-pruned table.
- **Expected production behavior:** A composite `(organization_id, created_at, id)` index (and consideration for the jsonb target filter) so audit reads stay bounded as the table grows.
- **Risk:** Audit list latency degrades over time, amplified by ORG-PR-013/ORG-PR-015.
- **Remediation:** Add the composite index in a new forward migration. **Not implemented during the Sprint 14 audit** (schema/migration change).
- **Dependencies:** informs ORG-PR-013/015. **Effort:** S. **Validation:** `EXPLAIN` shows index usage; schema-drift check passes; migrate-from-scratch test updated. **Roadmap:** Phase 3. **Standards:** ASVS V7 (log availability). **Threats:** T-AUDIT, T-DOS.

<a id="org-pr-015"></a>
### ORG-PR-015 — No retention/cleanup for unbounded tables
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** Grep for `DELETE FROM|.delete(|cron|setInterval|sweep|cleanup|purge|prune|retention` (non-test) → only a stale comment (`auth.ts:94` "Expiry sweep") and the display-only `plans.audit_retention_days` (`entitlement.service.ts:53` "not enforced"). No cleanup exists for `sessions`, `refresh_tokens`, `security_events`, `invitations`, `email_verification_tokens`, or expired `api_keys`.
- **Current behavior:** These tables grow forever; `audit_retention_days` is surfaced but never enforced.
- **Expected production behavior:** Scheduled, idempotent, locked cleanup jobs for each state class ([see maintenance-jobs in security-assessment](security-assessment.md)), with metrics and failure alerts.
- **Risk:** Storage/index bloat, slow scans (compounds ORG-PR-014), and unmet retention promises (privacy — ORG-PR-043).
- **Remediation:** Introduce scheduled cleanup once a background runtime exists (ORG-PR-016). **Not implemented during the Sprint 14 audit.**
- **Dependencies:** ORG-PR-016. **Effort:** M. **Validation:** job tests (idempotency, lock, metrics) + retention enforcement test. **Roadmap:** Phase 5. **Standards:** ASVS V7.3; privacy retention. **Threats:** T-AUDIT, T-PRIV.

<a id="org-pr-016"></a>
### ORG-PR-016 — No background-processing runtime (workers/scheduler)
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `docs/known-limitations.md`: "No workers, queues, schedulers, or cron." No scheduler code (grep). `infra/docker-compose.yml` header: "No worker/queue runtime."
- **Current behavior:** Anything requiring a background job (expiry sweeps, retention deletion, email retries) is derived-on-read or not performed.
- **Expected production behavior:** A scheduler/worker (cron container, platform scheduler, or in-process scheduled task) to run maintenance jobs reliably.
- **Risk:** Enabler gap — ORG-PR-015 retention, ORG-PR-004 reset-token expiry cleanup, and email-retry reliability all depend on it.
- **Remediation:** Add the simplest scheduler that fits the target (does not require a queue system at this scale).
- **Dependencies:** ORG-PR-001. **Effort:** M. **Validation:** a scheduled job runs, is observable, and is idempotent. **Roadmap:** Phase 5. **Standards:** SSDF PO.3. **Threats:** T-AUDIT, T-PRIV.

<a id="org-pr-017"></a>
### ORG-PR-017 — Admin can escalate self/others to Owner
- **Class / Sev / Conf:** Security risk · P2 · Medium · Evidence-backed inference (policy-dependent).
- **Evidence:** `members.change_role` is held by both Owner and Admin (`packages/contracts/src/access.ts` ROLE_PERMISSIONS, L176-177). `member.service.ts — changeMemberRole` (L163-183) → `organization.repo.ts — changeMemberRole` (L307-363) validates only the Last-Owner *demotion* invariant; no guard restricts *promoting* a membership to `owner` or prevents an Admin from creating an Owner. No test asserts the intended behavior either way.
- **Current behavior:** An Admin can set any membership (including their own) to `owner`, then use Owner-only capabilities (e.g. `plan.change_demo`).
- **Expected production behavior:** A documented, enforced role-transition policy — most likely: only an Owner may create/confer Owner. Whichever policy is chosen, it must be enforced in code and tested.
- **Risk:** Vertical privilege escalation to the top role by any Admin.
- **Remediation:** Add a role-transition guard and negative tests. **Policy decision required** (see [production-target.md](production-target.md) decision gates).
- **Dependencies:** none. **Effort:** S. **Validation:** tests for allowed/blocked promotions. **Roadmap:** Phase 3. **Standards:** ASVS V4.1 (access control), V1.2. **Threats:** T-PRIV.
- **Policy update (Sprint 15, 2026-07-18):** the required policy decision now exists — **DG-2 was ratified by the Project Owner** ([sprint-15-decisions.md](sprint-15-decisions.md)): only an active Owner may grant or remove the Owner role; Admins may not confer Owner on themselves or others; last-owner protection remains mandatory. **This finding remains OPEN**: the code still permits Admin→Owner promotion; enforcement and negative tests are Sprint 19 work.

<a id="org-pr-018"></a>
### ORG-PR-018 — `drizzle-orm` high-severity advisory (installed `<0.45.2`)
- **Class / Sev / Conf:** Security risk · P2 · Medium · Verified fact (advisory) / inference (exploitability).
- **Evidence:** `pnpm audit --prod` → 1 high: `drizzle-orm` "SQL injection via improperly escaped SQL identifiers", vulnerable `<0.45.2`, path `apps__api>drizzle-orm`; installed `^0.38.3` (`apps/api/package.json`), advisory GHSA-gpj5-g38j-94v9.
- **Current behavior:** The API depends on a drizzle-orm version in the advisory range.
- **Expected production behavior:** Dependency not in a known-vulnerable range, or a documented risk acceptance with exploitability analysis. Exploitation requires attacker-controlled *SQL identifiers* (table/column names); Orgistry's queries use static identifiers with parameterized values, so a direct path is not evident — but this must be triaged, not assumed.
- **Risk:** Potential SQL injection if any identifier is ever derived from user input; unpatched high advisory in the dependency tree.
- **Remediation:** Triage exploitability, then remediate on the dependency track. **Per Sprint 14 scope, dependencies are NOT upgraded solely for remediation here** — routed to the roadmap.
- **Dependencies:** ORG-PR-020 (scanning). **Effort:** S. **Validation:** `pnpm audit` clean or documented acceptance; grep confirms no dynamic identifiers. **Roadmap:** Phase 3. **Standards:** ASVS V5.3 (injection); SLSA/SSDF PW.4. **Threats:** T-DEP, T-SQLI.

<a id="org-pr-019"></a>
### ORG-PR-019 — CI actions pinned to mutable tags; no workflow `permissions` block
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `.github/workflows/ci.yml` uses `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` (major-version tags, not SHAs). No `permissions:` block → default `GITHUB_TOKEN` scope applies. No `concurrency:` group.
- **Current behavior:** CI trusts mutable third-party action references and runs with default token permissions.
- **Expected production behavior:** Actions pinned to full commit SHAs; an explicit least-privilege `permissions:` block; `concurrency` to cancel superseded runs.
- **Risk:** A hijacked/retagged action executes in CI with broader-than-needed token scope (supply-chain/CI compromise).
- **Remediation:** Pin to SHAs, add `permissions: { contents: read }` (widen per job as needed).
- **Dependencies:** none. **Effort:** S. **Validation:** workflow lints; pins are SHAs. **Roadmap:** Phase 3 / Phase 6. **Standards:** SLSA source/build; SSDF PO.5. **Threats:** T-CI.

<a id="org-pr-020"></a>
### ORG-PR-020 — No dependency/vuln/secret/SAST scanning in CI
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact (absence).
- **Evidence:** `.github/` contains only `workflows/ci.yml`; no `dependabot.yml`/`renovate.json`; CI runs no `pnpm audit`, CodeQL, secret scanning, or SAST (workflow read).
- **Current behavior:** Vulnerable/abandoned deps (e.g. ORG-PR-018) and leaked secrets are detected only by manual runs; `^` ranges mean drift is invisible.
- **Expected production behavior:** Automated dependency updates + `audit` gate + secret scanning + SAST/CodeQL in CI.
- **Risk:** Known-vulnerable dependencies and committed secrets ship undetected.
- **Remediation:** Add Dependabot/Renovate, an `audit`/OSV gate, secret scanning, and CodeQL.
- **Dependencies:** none. **Effort:** M. **Validation:** CI runs the scanners and fails on a seeded finding. **Roadmap:** Phase 3 / Phase 6. **Standards:** SSDF PW.4/RV.1; SLSA. **Threats:** T-DEP, T-SECRET, T-CI.

<a id="org-pr-021"></a>
### ORG-PR-021 — No DB pool / statement / lock timeouts
- **Class / Sev / Conf:** Reliability risk · P2 · Medium · Verified fact.
- **Evidence:** `packages/db/src/client.ts — createDbClient` sets pool `max: 10` with no `connect_timeout`/`idle_timeout`/`max_lifetime`/`statement_timeout` (grep → none); API calls it with no `max` (`server.ts:44`). `FOR UPDATE` paths (owner/rotation/accept) have no lock/statement timeout.
- **Current behavior:** A slow/stuck query or lock can occupy a pool slot indefinitely; under load the 10-slot pool can exhaust with no queue timeout.
- **Expected production behavior:** Explicit `statement_timeout`, `idle_in_transaction_session_timeout`, lock timeouts, and pool sizing/timeouts tuned to the deployment.
- **Risk:** A single pathological query stalls the API; cascading pool exhaustion under load.
- **Remediation:** Set statement/lock/pool timeouts via config for production.
- **Dependencies:** ORG-PR-001. **Effort:** S. **Validation:** a deliberately slow query is cut off by `statement_timeout`. **Roadmap:** Phase 4. **Standards:** ASVS V11 (resource limits). **Threats:** T-DOS.

<a id="org-pr-022"></a>
### ORG-PR-022 — App and migrations share a single Postgres superuser
- **Class / Sev / Conf:** Security risk · P2 · High · Verified fact.
- **Evidence:** `infra/docker-compose.yml:19` and `.env.example:42` define one `orgistry` superuser used for both runtime (`server.ts:44`) and DDL (`scripts/migrate.ts`). No `CREATE ROLE`/`GRANT`/separate roles anywhere (grep → none).
- **Current behavior:** The app runtime connection has full DDL/DROP authority.
- **Expected production behavior:** A least-privilege runtime role (DML on app tables only) distinct from a migration role with DDL rights.
- **Risk:** A compromised app connection (e.g. via ORG-PR-018) can drop/alter schema, not just read/write rows.
- **Remediation:** Provision separate migration and runtime roles with scoped grants in production.
- **Dependencies:** ORG-PR-001. **Effort:** M. **Validation:** runtime role cannot run DDL; migrations run under the DDL role. **Roadmap:** Phase 4. **Standards:** ASVS V1.11/V4 (least privilege). **Threats:** T-DBLOSS, T-SQLI.

<a id="org-pr-023"></a>
### ORG-PR-023 — No React error boundary; a render throw blanks the SPA
- **Class / Sev / Conf:** Reliability risk · P2 · High · Verified fact.
- **Evidence:** No error boundary in `apps/web-demo/src/main.tsx` or `App.tsx` (grep). `hooks/useOrganization.ts — useSelectedOrganizationId` (L23-29) throws "No organization is selected" by design.
- **Current behavior:** Any render-time throw yields a white screen with no recovery UI.
- **Expected production behavior:** A top-level error boundary rendering a recoverable fallback and (optionally) reporting the error.
- **Risk:** A single unexpected throw takes the whole UI down with no path back; worst near org-selection edge cases.
- **Remediation:** Add an error boundary around the router/shell with a reset action.
- **Dependencies:** none. **Effort:** S. **Validation:** component test that a thrown child renders the fallback. **Roadmap:** Phase 3 (frontend hardening). **Standards:** ASVS V14 (resilience). **Threats:** T-OPS.

<a id="org-pr-024"></a>
### ORG-PR-024 — No email verification (unused `email_verification_tokens` scaffolding)

> **Status: CLOSED (Sprint 16, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as
> recorded; they no longer describe the repository. See the **Resolution**
> line at the end of this entry.

- **Class / Sev / Conf:** Product completeness gap · P2 · High · Verified fact (absence).
- **Evidence:** Table `email_verification_tokens` exists (`packages/db/src/schema/auth.ts` L130-149, migration `0001`) and `users.emailVerifiedAt` exists, but grep across `apps/`+`packages/` shows references only in schema/barrel/migrations/tests — no service, route, or consumer. No verification email is ever sent; `email_verified_at` is never set.
- **Current behavior:** Email ownership is never verified; the scaffolding is dead.
- **Expected production behavior:** A verification flow that mints/sends/redeems a token and can gate sensitive actions.
- **Risk:** Unverified emails enable typo'd/hostile-address signups and undermine any email-based recovery; unused schema misleads (ORG-PR-048).
- **Remediation:** Implement verification on the existing token table + mailer, or explicitly remove the scaffolding if deferred.
- **Dependencies:** ORG-PR-002. **Effort:** M. **Validation:** integration tests for mint/redeem/expiry/resend. **Roadmap:** Phase 2. **Standards:** ASVS V2.1. **Threats:** T-ENUM, T-INV.
- **Resolution (Sprint 16, 2026-07-18): CLOSED.** The complete lifecycle is implemented and tested: authenticated `POST /v1/auth/email-verification/request` (also the resend endpoint; current user's stored email only — no address input, so no enumeration surface), public `POST /v1/auth/email-verification/complete` (raw token in the body), hash-only 32-byte CSPRNG tokens (`email-verification.token.ts` over the shared opaque-token primitives), expiry (`EMAIL_VERIFICATION_TTL_SECONDS`, default 24 h), single-use consumption + sibling invalidation + conditional `users.email_verified_at` update in ONE transaction under `SELECT … FOR UPDATE` (`email-verification.repo.ts`), resend invalidation of all prior unused tokens, best-effort automatic first email after registration, Redis-backed rate limits, sanitized `auth.email_verification_*` security events, `emailVerified` on the current-user contract, and the web-demo banner + `/auth/verify-email` completion flow. Evidence: `email-verification.routes.test.ts` (18 route tests), `email-verification.integration.test.ts` (live PostgreSQL incl. the concurrent double-completion race), web-demo `email-verification.test.tsx` (13 tests). Verification is **advisory** in Sprint 16 (no gates) by documented product policy — see [email-and-verification.md](../email-and-verification.md). Note: closure of this finding does not close ORG-PR-002 (external delivery unvalidated).

<a id="org-pr-025"></a>
### ORG-PR-025 — No account deletion / data export (data-subject rights)
- **Class / Sev / Conf:** Compliance dependency · P2 · High · Verified fact (absence). **Legal review required.**
- **Evidence:** `users.deletedAt` soft-delete column is honored on read but no deletion route/service exists; no data-export endpoint (grep → none in auth module).
- **Current behavior:** Users cannot delete their account or export their data; operators have no supported deletion path.
- **Expected production behavior:** Account closure (soft + hard-delete/anonymization policy), data export, and correction paths consistent with the applicable privacy regime.
- **Risk:** Cannot honor data-subject requests; retention of PII (ORG-PR-043) with no deletion path.
- **Remediation:** Build deletion/export flows; define anonymization vs. hard-delete policy. **Legal review required** for scope/timelines.
- **Dependencies:** ORG-PR-015/016 (retention), legal. **Effort:** L. **Validation:** deletion/export integration tests; PII fully removed/anonymized. **Roadmap:** Phase 5 / legal gate. **Standards:** ASVS V8 (data protection). **Threats:** T-PRIV.

<a id="org-pr-026"></a>
### ORG-PR-026 — No failure-injection / degraded-dependency integration tests
- **Class / Sev / Conf:** Reliability risk · P2 · Medium · Verified fact (absence).
- **Evidence:** Degraded paths are only unit-mocked (`readiness.test.ts:35` stubbed probe; `rate-limit.test.ts:68` mocked Redis throw). `readiness.integration.test.ts` asserts only the healthy path. No test kills a live DB/Redis mid-request or a down SMTP against live services.
- **Current behavior:** Real-stack behavior under dependency failure is unverified.
- **Expected production behavior:** Integration tests exercising DB-down, Redis-down (fail-open path), and SMTP-down behavior against live services.
- **Risk:** Degradation behavior (fail-open limits, readiness, error mapping) is asserted only in mocks; production surprises likely.
- **Remediation:** Add failure-injection integration suites.
- **Dependencies:** ORG-PR-009 (fail-closed option). **Effort:** M. **Validation:** suites pass with dependencies toggled. **Roadmap:** Phase 6 (E2E & verification). **Standards:** SSDF PW.8. **Threats:** T-DOS, T-OPS.

<a id="org-pr-027"></a>
### ORG-PR-027 — No production operations documentation
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** Doc census: deploy, rollback, backup/restore, secret rotation, and production incident response are absent; `docs/roadmap.md` catalogs each as a gap. Migration-apply and local diagnosis are covered; production operations are not.
- **Current behavior:** A future maintainer cannot learn production configuration, deploy, rollback, backup/restore, rotation, or incident response from the docs.
- **Expected production behavior:** An operations guide covering all of the above, cross-linked from the README.
- **Risk:** Operability depends on tribal knowledge; slow, error-prone production changes.
- **Remediation:** Author production ops docs as the infra/reliability work lands (pairs with ORG-PR-005/006/008).
- **Dependencies:** ORG-PR-001/005/007. **Effort:** M. **Validation:** a new operator completes a deploy + restore drill from docs alone. **Roadmap:** Phase 5. **Standards:** SSDF PO.3/RV. **Threats:** T-OPS.

<a id="org-pr-028"></a>
### ORG-PR-028 — No migration rollback / recovery strategy
- **Class / Sev / Conf:** Operational gap · P2 · High · Verified fact.
- **Evidence:** `packages/db/migrations/` contains only forward `0000-0007.sql`; no down/`.down.sql` files (find → none). Migrations are additive and transactional (`_journal.json` breakpoints=true), but there is no documented recovery for a bad migration.
- **Current behavior:** Recovery from a bad migration = restore/reset only; no rehearsed procedure.
- **Expected production behavior:** A documented forward-only recovery strategy (compensating migrations + restore), rehearsed against the backup path.
- **Risk:** A failed production migration has no rehearsed rollback; pairs with the missing restore capability (ORG-PR-005).
- **Remediation:** Document the forward-only recovery model and rehearse it with the restore drill.
- **Dependencies:** ORG-PR-005. **Effort:** S. **Validation:** a bad-migration recovery is rehearsed in staging. **Roadmap:** Phase 4 / Phase 5. **Standards:** SSDF PO.3. **Threats:** T-MIG.

<a id="org-pr-029"></a>
### ORG-PR-029 — Quota ceilings are TOCTOU-racy under concurrency
- **Class / Sev / Conf:** Data-integrity risk · P3 (P2 if quotas become billing-enforced) · High · Verified fact.
- **Evidence:** For creation, the quota is checked in the service *outside* the write transaction and not re-verified under a lock: projects (`entitlement.service.ts:184-191` + `project.repo.ts` separate tx), API keys (`api-key.service.ts:196-208`), invitation reservation (`invitation.service.ts:335-341`). Invitation *acceptance* counts inside the tx but locks only the invitation row, so two distinct tokens/users race under READ COMMITTED (`invitation.acceptance.ts:142-158`). No DB constraint caps the counts. No concurrency tests (grep).
- **Current behavior:** Two concurrent authorized creates can each pass the ceiling check and both write, exceeding the plan limit by a small margin.
- **Expected production behavior:** Atomic enforcement (row-lock the plan/counter, conditional insert, or a DB constraint) so concurrent creates at the ceiling cannot exceed it.
- **Risk:** Bounded ceiling overrun; not a tenant/auth breach today, but becomes material if quotas gate billing.
- **Remediation:** Serialize the count+insert (lock plan row or use an atomic conditional write); add concurrency tests.
- **Dependencies:** none. **Effort:** M. **Validation:** concurrent-create integration tests cannot exceed the ceiling. **Roadmap:** Phase 3. **Standards:** ASVS V11.1 (business-logic limits). **Threats:** T-QUOTA.

<a id="org-pr-030"></a>
### ORG-PR-030 — User enumeration on registration
- **Class / Sev / Conf:** Security risk · P3 · High · Verified fact.
- **Evidence:** `auth.service.ts — register` (L388-391) pre-checks the email and throws distinct `409 EMAIL_ALREADY_REGISTERED` (`auth.errors.ts:25`) vs. a 201 success. Login is enumeration-hardened (uniform error + dummy-hash timing) but register is not.
- **Current behavior:** Registration discloses which emails already have accounts.
- **Expected production behavior:** Generic "check your email" response driven through email verification, removing the existence oracle.
- **Risk:** Account enumeration feeding targeted credential-stuffing/phishing.
- **Remediation:** Return a generic response and signal existence only via the (to-be-built) verification email (ORG-PR-024).
- **Dependencies:** ORG-PR-024. **Effort:** S. **Validation:** test that register does not distinguish existing vs. new. **Roadmap:** Phase 3. **Standards:** ASVS V2.1/V3. **Threats:** T-ENUM.
- **Status (Sprint 17, 2026-07-20): OPEN — materially advanced, NOT closed.** The oracle is now bounded and observed, not removed: a per-normalized-email-digest rate limit (`RATE_LIMIT_REGISTER_PER_EMAIL_MAX`, counted before the lookup and identically for known/unknown addresses) throttles probing independent of the attacker's IP pool, and each duplicate attempt writes a durable `auth.registration_duplicate_email` security event (ANONYMOUS actor, null user id, coarse `reason` metadata — the unproven caller is never represented as the account owner, and no email or email digest is stored; request context rides on the event row's sanitized IP/UA/request-id fields). The `409 EMAIL_ALREADY_REGISTERED` response itself is unchanged and still distinguishable: registration synchronously returns a live session (`201 { user, tokens }` + cookie), so a duplicate cannot be answered uniformly without fabricating credentials or converting to the verification-required, email-first registration this remediation envisions — a product redesign out of Sprint 17 scope. The public password-recovery flow (Sprint 17) is fully enumeration-safe; login hardening is unchanged. Follow-up: full closure requires the generic-response registration redesign (signal existence only via email). Evidence: `credential-change.routes.test.ts — registration duplicate-email behavior` (conflict contract, probe event, per-email throttle, no-oracle bucket counting). Design note: [credential-management.md](../credential-management.md#registration-de-enumeration-org-pr-030--design-note).

<a id="org-pr-031"></a>
### ORG-PR-031 — No idempotency keys on create operations
- **Class / Sev / Conf:** Reliability risk · P3 · Medium · Verified fact (absence).
- **Evidence:** No `Idempotency-Key` handling anywhere (grep `idempoten` → only comments about naturally-idempotent logout/revoke). Create-org/project/api-key/invitation each produce a new row (api-key mints a new secret; invitation sends a new email) on retry.
- **Current behavior:** A client retry after a dropped response silently duplicates.
- **Expected production behavior:** Idempotency-key support on unsafe create operations (dedup store keyed by client-supplied key).
- **Risk:** Duplicate resources, duplicate invitation emails, orphaned secrets on network retries.
- **Remediation:** Add idempotency-key middleware for creates.
- **Dependencies:** none. **Effort:** M. **Validation:** duplicate-submit test returns the original result. **Roadmap:** Phase 3. **Standards:** ASVS V11 (business logic). **Threats:** T-INV.

<a id="org-pr-032"></a>
### ORG-PR-032 — Spammable authenticated mutations lack rate limits
- **Class / Sev / Conf:** Security risk · P3 · High · Verified fact.
- **Evidence:** No rate limit on `POST …/invitations` (sends an email each call — `invitation.routes.ts`), `POST …/api-keys`, `POST /v1/organizations`, or project/member mutations. Only auth + external surfaces are limited (grep `.consume(`).
- **Current behavior:** A member can loop invitation emails up to the reservation ceiling and spam key/resource creation.
- **Expected production behavior:** Per-actor rate limits on mutation surfaces, especially email-sending ones.
- **Risk:** Email-abuse/reputation damage, resource spam.
- **Remediation:** Apply per-actor limits to mutations (pairs with ORG-PR-012 global limiter).
- **Dependencies:** ORG-PR-012. **Effort:** M. **Validation:** limiter tests on invitation/key create. **Roadmap:** Phase 3. **Standards:** ASVS V11.1. **Threats:** T-INV, T-DOS.

<a id="org-pr-033"></a>
### ORG-PR-033 — No structured-logger redaction backstop
- **Class / Sev / Conf:** Maintainability issue (security-adjacent) · P3 · Medium · Verified fact.
- **Evidence:** `app.ts:136` configures pino with only `{ level }`; no `redact` paths. Audit/security-event metadata is sanitized (`lib/security-metadata.ts`) but the HTTP logger has no redaction. Fastify's default serializers don't log headers, so current exposure is low.
- **Current behavior:** Any future `log.info({ headers })` or error log including tokens would emit them in cleartext.
- **Expected production behavior:** A logger `redact` config for Authorization/Cookie/secret paths as defense-in-depth.
- **Risk:** Latent secret leakage into logs on any future logging change.
- **Remediation:** Add pino `redact` paths.
- **Dependencies:** none. **Effort:** S. **Validation:** log-capture test confirms redaction. **Roadmap:** Phase 3. **Standards:** ASVS V7.1 (log content). **Threats:** T-LOG.

<a id="org-pr-034"></a>
### ORG-PR-034 — "Best-effort" last-used / auth-event writes are not isolated
- **Class / Sev / Conf:** Reliability risk · P3 · Medium · Verified fact.
- **Evidence:** `api-key.authenticator.ts` awaits `apiKeys.touchLastUsed(...)` (L245-247) and each `recordAuthEvent(...)` with no try/catch; repo methods have no internal try/catch (`api-key.repo.ts:211-238`). Comments claim these are "best-effort … must never break a valid request," but a throw propagates and 500s the request.
- **Current behavior:** A transient DB hiccup on a bookkeeping write fails an otherwise-valid external API request.
- **Expected production behavior:** These writes are genuinely best-effort (wrapped/deferred) so they cannot fail the request.
- **Risk:** Availability dips on the external API from non-critical write failures; documented intent contradicts behavior.
- **Remediation:** Wrap bookkeeping writes in try/catch (log-and-continue) or defer them.
- **Dependencies:** none. **Effort:** S. **Validation:** test that a throwing `touchLastUsed`/`recordAuthEvent` does not fail the request. **Roadmap:** Phase 3. **Standards:** ASVS V7. **Threats:** T-OPS.

<a id="org-pr-035"></a>
### ORG-PR-035 — No CSP / security meta in the web demo
- **Class / Sev / Conf:** Security risk · P3 · Medium · Verified fact.
- **Evidence:** `apps/web-demo/index.html` has only `charset`/`viewport` meta; no CSP. `vite.config.ts` has no `build.sourcemap` (defaults off — good). Token is in-memory, so XSS containment matters.
- **Current behavior:** No CSP unless the serving layer adds one (unknown).
- **Expected production behavior:** A CSP (server-set or meta) constraining script/connect origins, aligned with the API header work (ORG-PR-011).
- **Risk:** XSS would expose the in-memory access token; no CSP containment.
- **Remediation:** Serve a CSP from the static host/proxy; align with API headers.
- **Dependencies:** ORG-PR-011. **Effort:** S. **Validation:** response CSP present and effective. **Roadmap:** Phase 3 / Phase 4. **Standards:** ASVS V14.4. **Threats:** T-XSS.

<a id="org-pr-036"></a>
### ORG-PR-036 — Frontend UX/robustness gaps
- **Class / Sev / Conf:** Developer-experience issue · P3 · High · Verified fact.
- **Evidence:** Invitation revoke fires with no confirmation (`InvitationsPage.tsx:53-55`), unlike Members/Projects/ApiKeys which use `window.confirm`. Deep-link not preserved: `ProtectedRoute.tsx:22` redirects without `from`; Login/Register hard-navigate to `/app/overview`. Session-expiry resets to unauthenticated with no messaging (`client.ts:133-136`). A11y: the "New team" popover (`OrganizationSwitcher.tsx:65-88`) is not a dialog (no focus trap/Escape/outside-click); no focus management on route change. Overview swallows permission/plan query errors (`OverviewPage.tsx:44-65`).
- **Current behavior:** Demo-quality UX with the above rough edges.
- **Expected production behavior:** Confirmations on all destructive actions, deep-link return, explicit session-expiry messaging, and baseline a11y.
- **Risk:** Mis-clicks (irreversible revoke), lost destination, confusing expiry, reduced accessibility.
- **Remediation:** Add revoke confirmation, `from`-state redirect, expiry toast, dialog semantics/focus management. Preserve the thin-consumer pattern.
- **Dependencies:** none. **Effort:** M. **Validation:** component tests for each. **Roadmap:** Phase 3 (frontend hardening, parallelizable). **Standards:** ASVS V14; WCAG (a11y). **Threats:** T-OPS.

<a id="org-pr-037"></a>
### ORG-PR-037 — `reset-test` destructive guard weaker than documented
- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `packages/db/scripts/reset-test.ts:11-12` comment claims the guard is "NODE_ENV=test + explicit TEST_DATABASE_URL," but `packages/db/src/env.ts — requireTestDatabaseUrl` (L31-42) checks only that `TEST_DATABASE_URL` is set and differs from `DATABASE_URL`; `NODE_ENV` is never consulted.
- **Current behavior:** If an operator points `TEST_DATABASE_URL` at a real DB that merely differs from `DATABASE_URL` (e.g. staging), the guard passes and the schema is dropped.
- **Expected production behavior:** The guard matches its documentation (also require `NODE_ENV=test`) or the docstring is corrected to the true, weaker guarantee.
- **Risk:** Accidental destruction of a non-test database that satisfies the URL-difference check.
- **Remediation:** Strengthen the guard (add `NODE_ENV=test`) or fix the docstring; the safer fix is the stronger guard.
- **Dependencies:** none. **Effort:** S. **Validation:** test that reset refuses when `NODE_ENV!=='test'`. **Roadmap:** Phase 3. **Standards:** SSDF PW.5. **Threats:** T-OPS.

<a id="org-pr-038"></a>
### ORG-PR-038 — "One personal workspace per user" invariant unenforced
- **Class / Sev / Conf:** Data-integrity risk · P3 · Medium · Verified fact.
- **Evidence:** `type:'personal'` is created exactly once in the registration transaction (`auth.repo.ts:110`) and no other path creates personal orgs, but there is no unique constraint (e.g. partial unique on `organizations(created_by_user_id) WHERE type='personal'`) and no app pre-check.
- **Current behavior:** The invariant holds by convention only.
- **Expected production behavior:** DB-enforced (partial unique) so no future code path or backfill can create a second personal workspace.
- **Risk:** A future/edited code path silently creates duplicate personal workspaces.
- **Remediation:** Add a partial unique index in a forward migration.
- **Dependencies:** none. **Effort:** S. **Validation:** migrate-from-scratch test asserts the constraint rejects a second personal org. **Roadmap:** Phase 3. **Standards:** ASVS V11 (data integrity). **Threats:** T-QUOTA.

<a id="org-pr-039"></a>
### ORG-PR-039 — No password-change / email-change flows
- **Class / Sev / Conf:** Product completeness gap · P3 · High · Verified fact (absence).
- **Evidence:** Grep for change-password/change-email routes/services (excl. tests) → none. No web surfaces (`apps/web-demo` has only Login/Register/Logout).
- **Current behavior:** Authenticated users cannot change their password or email.
- **Expected production behavior:** Password change (re-auth + session invalidation) and email change (verify new address).
- **Risk:** No way to rotate a compromised password or fix an email without admin/DB intervention.
- **Remediation:** Build both flows on existing auth primitives (+ verification for email change).
- **Dependencies:** ORG-PR-024 (email change), ORG-PR-002. **Effort:** M. **Validation:** integration tests. **Roadmap:** Phase 2. **Standards:** ASVS V2.1. **Threats:** T-CRED.
- **Resolution (Sprint 17, 2026-07-20): CLOSED.** Both flows implemented on the existing auth primitives, as the remediation specified. `POST /v1/auth/change-password` (Bearer): mandatory current-password re-auth against the stored Argon2id hash, shared password policy (`newPasswordSchema` — the same schema registration and reset completion parse), current-password-reuse rejection, and one transaction (`auth.repo.ts — changePasswordKeepingCurrentSession`) that swaps the hash, keeps ONLY the caller's server-resolved session, and revokes every other session + its refresh tokens. `POST /v1/auth/change-email` (Bearer): mandatory current-password re-auth, shared normalization, duplicate → the registration 409, and one transaction that swaps the address, clears `email_verified_at`, and invalidates all outstanding verification tokens, followed by a best-effort verification email to the NEW address (Sprint 16 mail-failure semantics; account stays usable under the advisory policy). Wrong current password → `INVALID_CREDENTIALS` at 400 (session-valid, so 401 would mimic expiry). Per-user rate limits on both. Evidence: `credential-change.routes.test.ts` (23 route tests), `password-recovery.integration.test.ts` (SQL-layer keep-current-session policy + email-change verification reset), web-demo `account-security.test.tsx` (10 tests). Web surface: `/app/account`. Docs: [credential-management.md](../credential-management.md).

<a id="org-pr-040"></a>
### ORG-PR-040 — `noUncheckedIndexedAccess` disabled
- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `tsconfig.base.json` sets `strict: true` and many strict flags but not `noUncheckedIndexedAccess` (nor `exactOptionalPropertyTypes`). Repos/mappers index arrays/records throughout.
- **Current behavior:** Index access is typed as always-defined; undefined-at-index bugs pass `tsc`.
- **Expected production behavior:** `noUncheckedIndexedAccess` on, with resulting sites fixed.
- **Risk:** Latent undefined-access runtime bugs the type system currently hides.
- **Remediation:** Enable the flag and remediate fallout. **Not implemented during the Sprint 14 audit** (would touch production code).
- **Dependencies:** none. **Effort:** M. **Validation:** `pnpm typecheck` clean with the flag on. **Roadmap:** Phase 6 / hardening. **Standards:** SSDF PW.5. **Threats:** T-OPS.

<a id="org-pr-041"></a>
### ORG-PR-041 — Mailpit / live SMTP path never exercised in CI
- **Class / Sev / Conf:** Operational gap · P3 · High · Verified fact.
- **Evidence:** `.github/workflows/ci.yml:79-82` intentionally omits Mailpit; no integration test exercises live SMTP. The mailer has unit coverage only.
- **Current behavior:** A broken SMTP integration ships green.
- **Expected production behavior:** CI (or staging) asserts the live email-delivery path once a real provider exists.
- **Risk:** Email delivery regressions undetected until manual testing.
- **Remediation:** Add a CI Mailpit service + delivery assertion, and a staging real-provider check.
- **Dependencies:** ORG-PR-002. **Effort:** S. **Validation:** CI asserts a delivered invitation. **Roadmap:** Phase 6. **Standards:** SSDF PW.8. **Threats:** T-INV.

<a id="org-pr-042"></a>
### ORG-PR-042 — Docker infra images pinned by floating tags
- **Class / Sev / Conf:** Maintainability issue · P3 · High · Verified fact.
- **Evidence:** `infra/docker-compose.yml` uses `postgres:16-alpine`, `redis:7-alpine`, and `axllent/mailpit:latest` — floating tags, no `@sha256` digests. (Local-dev only; no app Dockerfiles yet.)
- **Current behavior:** Non-reproducible local infra; `latest` can change under you.
- **Expected production behavior:** Digest-pinned images for any production infra; pin dev images to at least patch tags.
- **Risk:** Non-reproducible environments; surprise breakage. Bounded impact today (dev-only).
- **Remediation:** Pin production images by digest; tighten dev tags.
- **Dependencies:** ORG-PR-001. **Effort:** S. **Validation:** images referenced by digest in production manifests. **Roadmap:** Phase 4. **Standards:** SLSA (reproducibility). **Threats:** T-DEP.

<a id="org-pr-043"></a>
### ORG-PR-043 — PII in audit/security metadata with no retention
- **Class / Sev / Conf:** Compliance dependency · P3 · Medium · Verified fact. **Legal review required.**
- **Evidence:** `login_failed` events store `normalizedEmail` (`auth.service.ts:507,522`); invitation events store `invitedEmailNormalized` (`invitation.acceptance.ts:221,233`, `invitation.repo.ts:126,250`). The sanitizer denylist (`lib/security-metadata.ts:22-36`) has no `email` entry, so these survive to reads/storage. No retention (ORG-PR-015).
- **Current behavior:** Email addresses persist indefinitely in `security_events`/audit metadata, readable by any holder of `audit_events.read`.
- **Expected production behavior:** A retention/minimization policy for PII in event metadata, consistent with the privacy regime.
- **Risk:** Indefinite PII retention; email disclosure to auditors. Likely intended for auditing but must be policy-bounded.
- **Remediation:** Define retention + access policy; enforce via cleanup (ORG-PR-015). **Legal review required.**
- **Dependencies:** ORG-PR-015, legal. **Effort:** S. **Validation:** retention job removes/anonymizes aged PII. **Roadmap:** Phase 5 / legal gate. **Standards:** ASVS V8; privacy. **Threats:** T-PRIV, T-AUDIT.

<a id="org-pr-044"></a>
### ORG-PR-044 — Narrow concurrency test coverage
- **Class / Sev / Conf:** Reliability risk · P3 · High · Verified fact.
- **Evidence:** The only real-DB race tests are refresh-token double-refresh (`session-lifecycle.integration.test.ts:152`) and Last-Owner demotion (`member.integration.test.ts:193`). No concurrency tests for quotas (ORG-PR-029) or concurrent invitation acceptance across distinct tokens.
- **Current behavior:** Most concurrency-sensitive invariants are untested under real parallelism.
- **Expected production behavior:** Concurrency tests for each identified race (quotas, cross-invitation acceptance).
- **Risk:** Regressions in race-safety land undetected.
- **Remediation:** Add targeted concurrency integration tests alongside ORG-PR-029 fixes.
- **Dependencies:** ORG-PR-029. **Effort:** M. **Validation:** the new suites pass and fail if locking is removed. **Roadmap:** Phase 3 / Phase 6. **Standards:** SSDF PW.8. **Threats:** T-QUOTA.

<a id="org-pr-045"></a>
### ORG-PR-045 — No MFA/passkeys and no security notifications
- **Class / Sev / Conf:** Product completeness gap · P3 · High · Verified fact (absence).
- **Evidence:** No MFA/TOTP/WebAuthn anywhere (grep → none). Security events are DB-only with no email/notification dispatch (no mailer call in the auth module).
- **Current behavior:** Single-factor auth; no user notification on new login/new device/credential change.
- **Expected production behavior:** Optional MFA (TOTP/passkeys) and security notifications on sensitive events.
- **Risk:** Weaker account protection; users unaware of takeover attempts. Explicitly a deferred non-goal today.
- **Remediation:** Add MFA and notification dispatch (depends on email).
- **Dependencies:** ORG-PR-002. **Effort:** L. **Validation:** MFA enrol/verify tests; notification-send tests. **Roadmap:** Phase 2 / post-launch. **Standards:** ASVS V2.2 (MFA). **Threats:** T-CRED, T-TOKEN.

<a id="org-pr-046"></a>
### ORG-PR-046 — Stale/contradictory subsystem documentation
- **Class / Sev / Conf:** Developer-experience issue · P4 · High · Verified fact.
- **Evidence:** `docs/database-foundation.md` is frozen at Sprint 4 — lists 3 schema files/auth+org tables while source has 9 schema files / 16 tables (contradicts `architecture.md`). `docs/rbac-permissions.md:156-159` calls `invitations.*/projects.*/api_keys.*/audit_events.read/plan.*` "reserved for modules not built" though all shipped. `docs/api-conventions.md` enumerates error codes only through Sprint 4. `docs/api-surface.md:46` lists `org.read` on `GET /v1/organizations/:id` but the code enforces membership only (also ORG-PR-053). (Correction from the refinement pass: `docs/evaluation-guide.md:135` "489 unit tests / 19 web-demo tests" is **accurate** — `pnpm validate` reports exactly 489 unit + 19 web-demo tests — so it is not a staleness item.)
- **Current behavior:** Several docs under-describe or misdescribe current behavior.
- **Expected production behavior:** Accurate current docs (or clear historical labeling).
- **Risk:** Maintainer confusion; wrong mental model of schema/permissions.
- **Remediation:** Refresh the stale sections. Per Sprint 14 scope these are recorded as findings, not rewritten here (except this package's own clarifications).
- **Dependencies:** none. **Effort:** S. **Validation:** docs match source on re-audit. **Roadmap:** Phase 6 / docs. **Standards:** n/a. **Threats:** n/a.

<a id="org-pr-047"></a>
### ORG-PR-047 — `COOKIE_SECRET` required but never used (unsigned cookies)

> **Status: CLOSED (Sprint 15, 2026-07-18).** The Evidence/Current behavior
> lines below describe the **Sprint 14 audit baseline**, preserved as recorded;
> `COOKIE_SECRET` no longer exists in the configuration. See the **Resolution**
> line at the end of this entry for the current state.

- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact.
- **Evidence:** `COOKIE_SECRET` validated (`schema.ts:75-77`) and plumbed (`config/index.ts:50`) but has no consumer; the refresh cookie is written unsigned (`lib/cookies.ts — serializeCookie`, plain `name=value`).
- **Current behavior:** Operators may assume cookies are signed/tamper-evident; they are not.
- **Expected production behavior:** Either sign cookies with it or remove the config to avoid a false sense of protection.
- **Risk:** Misleading security assumption; dead required config.
- **Remediation:** Remove or actually use `COOKIE_SECRET`.
- **Dependencies:** none. **Effort:** S. **Validation:** config no longer requires an unused secret, or signing is tested. **Roadmap:** Phase 3. **Standards:** ASVS V3 (session). **Threats:** T-CONF.
- **Resolution (Sprint 15, 2026-07-18): CLOSED — removed because unused.** A repository-wide search re-confirmed no code path signs or verifies cookies (refresh cookie remains deliberately unsigned; its integrity model is the hashed, rotated, high-entropy token itself). Removed: the `COOKIE_SECRET` schema field (`packages/config/src/schema.ts`), the `Config.auth.cookieSecret` property (`packages/config/src/index.ts`), fixtures (`packages/config/src/config.test.ts`, `apps/api/src/testing/build-test-app.ts`), the CI env value (`.github/workflows/ci.yml`), the `.env.example` line, and doc references (`docs/validation.md`, `docs/troubleshooting.md`, `docs/roadmap.md`). Signed-cookie behavior was **not** introduced to justify keeping the variable. Evidence: `packages/config/src/config.test.ts` — `does not require COOKIE_SECRET and does not expose a cookieSecret` (a stale value in an operator's `.env` is ignored). Historical sprint artifacts retain their original mentions by design.

<a id="org-pr-048"></a>
### ORG-PR-048 — `email_verification_tokens` dead schema shipped

> **Status: CLOSED (Sprint 16, 2026-07-18).** The lines below describe the
> **Sprint 14 audit baseline**, preserved as recorded. See the **Resolution**
> line at the end of this entry.

- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact.
- **Evidence:** Table + indexes migrated (`0001`) but never read/written (grep → schema/tests/snapshots only). `users.email_verified_at` never set.
- **Current behavior:** Dead schema implying an email-verification flow that does not exist.
- **Expected production behavior:** Implement (ORG-PR-024) or remove the scaffolding.
- **Risk:** Confusion; implies a non-existent feature.
- **Remediation:** Tie to ORG-PR-024 or drop in a forward migration.
- **Dependencies:** ORG-PR-024. **Effort:** S. **Validation:** either used by the verification flow or removed. **Roadmap:** Phase 2. **Standards:** n/a. **Threats:** n/a.
- **Resolution (Sprint 16, 2026-07-18): CLOSED via ORG-PR-024.** The table is active product behavior: written by issuance (invalidate-then-insert), consumed transactionally by completion, and read for classification. Migration `0008` added `invalidated_at` so consumed (`used_at`) and retired-unused (`invalidated_at`) states are explicit rather than overloading one column. Lifecycle-tested at the SQL layer by `email-verification.integration.test.ts`.

<a id="org-pr-049"></a>
### ORG-PR-049 — HS256 symmetric JWT with no `kid`/rotation path
- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `packages/auth-core/src/access-token.ts` — `SIGNING_ALGORITHM='HS256'` (L18), no `kid`/issuer/audience/versioned-secret (grep). Rotating `JWT_SECRET` invalidates all live access tokens (acceptable given 15-min TTL) but there is no graceful rotation.
- **Current behavior:** Single shared secret, no key id, no rotation window.
- **Expected production behavior:** Optional `kid` + versioned-secret (or asymmetric EdDSA/RS256) if verification ever leaves the issuer; enables graceful rotation (ORG-PR-006).
- **Risk:** Disruptive secret rotation; no path if a verifier is externalized.
- **Remediation:** Add `kid`/versioned secrets or move to asymmetric signing.
- **Dependencies:** relates to ORG-PR-006. **Effort:** M. **Validation:** rotation test with overlapping keys. **Roadmap:** Phase 3 / later. **Standards:** ASVS V6.4. **Threats:** T-TOKEN-FORGE.

<a id="org-pr-050"></a>
### ORG-PR-050 — Concurrent legitimate refresh revokes family + session
- **Class / Sev / Conf:** Reliability risk · P4 · High · Verified fact.
- **Evidence:** `auth.repo.ts:239-264` + `auth.service.ts:607-628`: two near-simultaneous refreshes of the same cookie serialize on the `FOR UPDATE` lock; the loser is classified reuse and the whole family + session are revoked, logging the user out everywhere.
- **Current behavior:** Multi-tab or retry double-refresh can force a full logout.
- **Expected production behavior:** A short grace window accepting the just-issued successor to avoid punishing benign double-refresh, while preserving true reuse detection.
- **Risk:** Availability/UX hazard (unexpected logout); security behavior is correct.
- **Remediation:** Add a small grace/idempotency window on the immediate parent.
- **Dependencies:** none. **Effort:** M. **Validation:** test that benign double-refresh keeps the session while true reuse still revokes. **Roadmap:** Phase 3 / later. **Standards:** ASVS V3.3 (session). **Threats:** T-RTOKEN.

<a id="org-pr-051"></a>
### ORG-PR-051 — Redundant unique index duplicates PK on `role_permissions`
- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `packages/db/src/schema/permissions.ts:83-88` declares both `primaryKey([roleId, permissionId])` and `uniqueIndex('uq_role_permissions_role_permission').on(roleId, permissionId)` — identical columns (migration `0002`).
- **Current behavior:** A redundant unique index duplicates the PK.
- **Expected production behavior:** Drop the redundant index (the PK already enforces uniqueness).
- **Risk:** Negligible write/storage overhead; cleanliness only.
- **Remediation:** Remove in a forward migration if desired.
- **Dependencies:** none. **Effort:** S. **Validation:** schema-drift + migrate-from-scratch pass. **Roadmap:** optional. **Standards:** n/a. **Threats:** n/a.

<a id="org-pr-052"></a>
### ORG-PR-052 — Minor API disclosures
- **Class / Sev / Conf:** Maintainability issue · P4 · Medium · Verified fact.
- **Evidence:** `/ready` returns dependency names + latency unauthenticated (`lib/readiness.ts`); `app.ts:137 requestIdHeader` trusts inbound `x-request-id` verbatim (the safe validator `shared/request-id.ts — resolveRequestId` exists but is unused); `server.ts:188` awaits `app.close()` with no timeout.
- **Current behavior:** Minor infra fingerprinting via `/ready`; client-forgeable request IDs in logs; unbounded shutdown wait.
- **Expected production behavior:** Optionally minimize `/ready` for unauthenticated callers; validate/replace inbound request IDs; bound `app.close()` with a shutdown timeout.
- **Risk:** Low — fingerprinting, log-correlation spoofing, and a possible stuck SIGTERM past the orchestrator grace period.
- **Remediation:** Use `resolveRequestId`; add a shutdown timeout; consider gating `/ready` detail.
- **Dependencies:** none. **Effort:** S. **Validation:** tests for request-id sanitization and bounded shutdown. **Roadmap:** Phase 4. **Standards:** ASVS V7.3, V14. **Threats:** T-LOG, T-OPS.

<a id="org-pr-053"></a>
### ORG-PR-053 — Two read paths skip the permission gate
- **Class / Sev / Conf:** Maintainability issue · P4 · High · Verified fact (no current gap).
- **Evidence:** `organization.service.ts — readOrganization` (L154-157) uses `resolveOrganizationContext` (membership only), not `requirePermission(org.read)`, diverging from the canonical membership→permission pattern (also surfaced as doc drift in ORG-PR-046). `org-rbac.service.ts — getEffectivePermissions` (L75-84) is membership-only by design. Harmless today (all roles hold `org.read`).
- **Current behavior:** Two read paths authorize on membership alone.
- **Expected production behavior:** Consistent membership→permission enforcement, or an explicit documented exception, so future permission narrowing doesn't silently mis-authorize.
- **Risk:** Latent — becomes a real gap only if `org.read` is ever narrowed.
- **Remediation:** Add the explicit permission check (or document the exception) for consistency.
- **Dependencies:** none. **Effort:** S. **Validation:** test asserts the permission is enforced. **Roadmap:** Phase 3. **Standards:** ASVS V4.1. **Threats:** T-BOLA.

<a id="org-pr-054"></a>
### ORG-PR-054 — `esbuild` moderate dev-only advisory (via `drizzle-kit`)
- **Class / Sev / Conf:** Optional enhancement · P4 · High · Verified fact.
- **Evidence:** `pnpm audit` → 2 moderate: `esbuild <=0.24.2` (dev-server request exposure) via `packages__db>drizzle-kit>...>esbuild`. Dev/build-time only; not in the runtime path.
- **Current behavior:** A transitive dev dependency carries a moderate advisory.
- **Expected production behavior:** Resolved on the dependency track or documented as dev-only, not shipped.
- **Risk:** Low — affects only the local dev server, not production runtime.
- **Remediation:** Address on the dependency-update track (ORG-PR-020). **Not upgraded here** per scope.
- **Dependencies:** ORG-PR-020. **Effort:** S. **Validation:** `pnpm audit` clean or documented acceptance. **Roadmap:** Phase 3. **Standards:** SSDF PW.4. **Threats:** T-DEP.
