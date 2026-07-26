# Production Roadmap

Dependency-ordered path from the current state (**C — Ready to begin production
implementation**) to a production launch, derived from
[findings-register.md](findings-register.md). Findings were established first; this
sequencing follows from their dependencies — the roadmap was not written first and
back-filled.

## Sequencing principles

1. **Decisions before build.** Resolve the production target and policy gates
   (DG-1…DG-5) before infrastructure commits.
2. **Close blockers on the critical path first**; run independent hardening in
   parallel.
3. **Prefer root-cause fixes** that retire multiple downstream findings (e.g. a
   background runtime unlocks all retention jobs).
4. **Verification and restore drill gate the launch**, not passing unit tests.

## Dependency graph (text)

```
Phase 1: Target & Decisions (DG-1..DG-5)
      │
      ├──────────────┬───────────────────────────┐
      ▼              ▼                           ▼
Phase 2:        Phase 3:                    (parallel)
Account         Security & Data-Integrity    Frontend hardening
Lifecycle       Hardening                     (ORG-PR-023/035/036)
(needs email ── (ORG-PR-003/009/010/011/012/  Supply-chain/CI
 ORG-PR-002)     013/014/017/018/019/020/       (ORG-PR-019/020/018/042)
                 029/030/032/033/034/037/38/    — can start immediately
                 044/047/049/050/051/052/053)
      │              │
      └──────┬───────┘
             ▼
Phase 4: Production Infrastructure & Deployment
   (ORG-PR-001/006/021/022/042 ; needs Phase 1 decisions)
             │
             ▼
Phase 5: Reliability, Recovery & Operations
   (ORG-PR-005/007/008/015/016/025/027/028/043 ; needs Phase 4)
             │
             ▼
Phase 6: End-to-End Verification & Security Review
   (ORG-PR-026/040/041/044 + external pentest/DAST)
             │
             ▼
   ★ PRODUCTION LAUNCH GATE ★  (restore drill mandatory)
```

## Phases → proposed sprints

### Phase 1 — Production configuration safety & decision ratification
- **Sprint 15 (recommended next — see below).** Config-safety implementation
  (ORG-PR-003/047) + ratification of the implementation-relevant decision gates.
  The production target itself was selected in Sprint 14
  ([production-target.md](production-target.md)).

### Phase 2 — Account lifecycle completion
- **Sprint 16 — Production email + verification.** ✅ **Repository scope
  COMPLETE (2026-07-18)** — see
  [sprint-16-artifact-package.md](sprint-16-artifact-package.md). Delivered:
  the shared account-mailer boundary with a production-shaped SMTPS adapter
  and fail-closed driver selection, the full email-verification lifecycle
  (request/resend + public completion, hash-only single-use tokens,
  transactional race-safe consumption), and the web-demo flow. **Closed:
  ORG-PR-024, ORG-PR-048. ORG-PR-002 remains OPEN (materially advanced):**
  the original exit criterion "live send to external inbox in staging"
  requires provider credentials and a staging environment that do not exist
  yet; verification integration tests are done. Unblocks Sprint 17
  (ORG-PR-004).
- *(original Sprint 16 plan)* Objective: real mailer adapter,
  email verification, resend. Closes ORG-PR-002, 024, 048; unblocks 004. Deps:
  DG-1. Non-goals: MFA, OAuth. Exit: live send to external inbox in staging;
  verification integration tests.
- **Sprint 17 — Recovery & credential management.** ✅ **Repository scope
  COMPLETE (2026-07-20)** — see
  [sprint-17-artifact-package.md](sprint-17-artifact-package.md). Delivered:
  enumeration-safe password recovery (dedicated hash-only
  `password_reset_tokens` table, `FOR UPDATE` race-safe single-use completion,
  full session/refresh revocation, fragment-transported reset links),
  current-password-gated password change (keep-current-session policy) and
  email change (verification reset + re-issue), the shared password policy,
  registration per-email throttling + probe events, and the web-demo
  forgot/reset/account-security flows. **Closed: ORG-PR-004, ORG-PR-039.
  ORG-PR-030 remains OPEN (materially advanced):** the duplicate-email 409 is
  throttled and observed but still distinguishable; full closure requires a
  verification-first registration redesign. Exit criterion met:
  reset/change integration tests incl. expiry/reuse/enumeration
  (`password-recovery.integration.test.ts` + route suites). **Sequencing
  note:** because ORG-PR-030 is still open, a focused account-lifecycle
  follow-up sprint that closes it (the verification-first registration
  redesign) precedes Sprint 18 — the Sprint 17 spec requires the
  account-lifecycle delta to be closed before broad edge hardening.
- *(original Sprint 17 plan)* Password reset, password/email
  change, register de-enumeration. Closes ORG-PR-004, 039, 030. Deps: Sprint 16.
  Exit: reset/change integration tests incl. expiry/reuse/enumeration.
- **Sprint 18 — Verification-first registration (EXECUTED 2026-07-20;
  COMPLETE).** The focused account-lifecycle follow-up the Sprint 17
  sequencing note required. Public registration redesigned to
  verification-first: generic contract-identical acceptance for every
  post-validation account state, pending-registration staging
  (`pending_registrations`, hash-only token + Argon2id password hash,
  advisory-lock-serialized single-usable-generation issuance), account
  creation only via the emailed single-use completion token (account created
  email-verified, with workspace/membership/session/refresh token in one
  transaction), invitation registration preserved with a documented
  completion-time invitation-unavailable policy. **Closed: ORG-PR-030.** Exit
  criterion met: public response-equality matrix + DB-backed issuance- and
  completion-concurrency tests
  (`registration.routes.test.ts`, `registration.integration.test.ts`). A
  refinement pass (2026-07-21) additionally made invitation-carrying
  registration fully generic (no `INVITATION_*` errors escape the public
  register endpoint; ten-row equality matrix in
  `invitation.routes.test.ts`), added the web-demo invitation
  landing/registration flow, and runtime-validated the demo seed. See
  [sprint-18-artifact-package.md](sprint-18-artifact-package.md). This sprint
  was INSERTED before the edge-hardening sprint below, which renumbers to
  Sprint 19 in execution order.

### Phase 3 — Security & data-integrity hardening (largely parallelizable)
- **Sprint 19 (roadmap "Sprint 18") — Edge & app-security hardening.**
  ✅ **Repository scope COMPLETE (2026-07-21)** — see
  [sprint-19-artifact-package.md](sprint-19-artifact-package.md). Delivered:
  typed `TRUST_PROXY` applied at Fastify construction (forwarded headers
  ignored unless explicitly trusted; the literal `'true'` rejected at config
  load), security headers on every response with production-only HSTS
  `includeSubDomains` (`apps/api/src/plugins/security-headers.ts`), a global
  per-trusted-IP fixed-window limiter
  (`apps/api/src/plugins/global-rate-limit.ts`), `invitations/inspect`
  throttled per IP and per token-derived digest, per-actor buckets on
  spammable authenticated mutations (enforced after permission checks),
  bounded durable failed-auth `security_events` writes on the External API,
  centralized pino logger redaction (`apps/api/src/lib/logging.ts`),
  request-id sanitization (`packages/shared/src/request-id.ts`), coarse
  production `/ready`, and bounded idempotent shutdown. **Closed:
  ORG-PR-010, 011, 012, 013, 032, 033, 052. ORG-PR-009 remains OPEN
  (materially advanced):** sensitive buckets fail closed under the
  production-default `RATE_LIMIT_FAILURE_MODE=closed` (guard refuses `open`
  in production), but the finding's alerting half depends on ORG-PR-007
  (Sprint 24). Exit criteria met: proxy-trust/header/limiter test suites plus
  a DB-backed failed-auth storm test bounding pre-auth writes;
  `pnpm validate` and `pnpm validate:integration` exit 0 (2026-07-21).
- *(original plan)* Security headers, `trustProxy`,
  global/edge rate limiting, throttle `invitations/inspect`, per-actor mutation
  limits, bound pre-auth external writes, logger redaction, request-id
  sanitization. Closes ORG-PR-010, 011, 012, 013, 032, 033, 052. Exit: header/
  limiter/proxy tests; load test bounds pre-auth writes.
- **Authorization & concurrency correctness — DONE (executed as Sprint 20,
  2026-07-21).** Role-transition guard (per DG-2, in-transaction against the
  locked active-owner set), atomic quota enforcement (org+kind advisory-lock
  serialized count+insert) + five real-PostgreSQL concurrency suites,
  personal-workspace partial unique constraint, read-path permission
  consistency (one documented membership-only exception), `security_events`
  org index. Closed ORG-PR-017, 029, 038, 044, 053, 014. Exit criteria met:
  concurrency suites pass and fail without the lock; index existence +
  `EXPLAIN` evidence; schema-drift passes; `pnpm validate` and
  `pnpm validate:integration` exit 0 (2026-07-21). Artifact:
  [sprint-20-artifact-package.md](sprint-20-artifact-package.md).
- **Sprint 21 — Supply-chain & CI hardening. Repository implementation
  COMPLETE (2026-07-26); ORG-PR-020 subsequently CLOSED in Sprint 22 once
  remote execution and negative-path enforcement evidence existed.** Actions SHA-pinned + explicit least-privilege `permissions`
  + concurrency on every workflow; `security.yml` (pnpm audit high/critical
  gates, prod/dev separated; Gitleaks secret scan with rewritten fixtures and
  a narrow annotated allowlist) + `codeql.yml` (JS/TS, source-only) +
  Dependabot (npm / github-actions / docker-compose, weekly, no auto-merge); `drizzle-orm`
  0.38.4→0.45.2 (advisory fix release; `DrizzleQueryError` cause-chain guard
  adaptation, unit + integration tested) and all vulnerable `esbuild` copies
  eliminated (drizzle-kit 0.31.10 + scoped override); in-range vulnerable
  transitives updated; images pinned to exact patch tags;
  `noUncheckedIndexedAccess` ON repo-wide (297 errors fixed, zero
  suppressions). **Closed ORG-PR-018, 019, 040, 054. Left open, materially
  advanced: ORG-PR-020 (first remote scanner run + seeded-finding proof
  outstanding — both delivered in Sprint 22, which closed it), ORG-PR-042
  (digest pinning deferred to the ORG-PR-001 artifact track).** Exit evidence: `pnpm validate` +
  `pnpm validate:integration` exit 0; actionlint, osv-scanner, and gitleaks
  history scan exit 0 locally; two accepted advisories documented. Artifact:
  [sprint-21-artifact-package.md](sprint-21-artifact-package.md).
- **Sprint 22 — CodeQL alert triage & CI gate closure. COMPLETE
  (2026-07-26).** Sprint 21 shipped scanners; Sprint 22 turned them into a
  control. All 41 High alerts from CodeQL's first operational run triaged
  individually with source/sink evidence, grouped into ten root causes, and
  given individual GitHub dispositions (no bulk dismissal, no unresolved true
  positive). Found and fixed two genuine defects: the audit-log read scanned
  a tenant's entire event history on an un-indexed `targetId` filter
  (ORG-PR-055), and the demo bootstrap emitted a one-time API key secret to
  stdout (ORG-PR-056 — first mitigated with a loopback-target guard, then
  fully remediated by removing key creation from the bootstrap so no
  credential is printed at all; key minting moved to the existing web-demo
  API Keys page). Also extracted the byte→alphabet mapping behind an enforced
  uniformity assertion. Documented the CodeQL gate
  policy in `docs/validation.md` and made it enforceable with a `main`
  ruleset (required PR + required CI/Security/CodeQL checks + code-scanning
  merge protection). **Closed ORG-PR-020.** Exit evidence: all three
  workflows green remotely; the Gitleaks job proved to FAIL on a seeded
  synthetic secret (run 30207672121, temporary branch deleted and never
  merged); `pnpm validate` + `pnpm validate:integration` exit 0. Artifact:
  [sprint-22-artifact-package.md](sprint-22-artifact-package.md).

> **Numbering correction (Sprint 21 closure, 2026-07-26 — corrective
> maintenance, not a roadmap redesign).** Before this closure the roadmap
> carried a genuine pre-existing collision: Phase 3 listed “Sprint 21 (next) —
> Supply-chain & CI hardening” while Phase 4 ALSO used “Sprint 21 — Deployable
> artifact & pipeline”, and the parallelizable-work section still called the
> supply-chain sprint “Sprint 20” (which was actually the executed
> authorization/concurrency sprint). Recording Sprint 21’s completion without
> resolving this would have left two contradictory “Sprint 21” entries — one
> complete, one not. Resolution: the executed supply-chain sprint keeps the
> number 21 it ran under; the not-yet-started Phase 4–6 sprints shift by one
> (deployable artifact 21→22, backups/DR 22→23, observability 23→24,
> verification/review 24→25). Sprint scopes, content, ordering, dependencies,
> and phase structure are unchanged. Cross-references updated in this
> document, the launch checklist (Sprint column + prose), and
> production-target.md (DG-5 note); executed-sprint artifacts (14–20) are
> historical records and retain their original text.

> **Numbering correction (Sprint 22 closure, 2026-07-26 — corrective
> maintenance, not a roadmap redesign).** Sprint 22 was executed as CodeQL
> alert triage and CI gate closure rather than the deployable artifact this
> phase had reserved the number for, which left two "Sprint 22" entries: one
> COMPLETE in Phase 3 and one "(next)" here. Resolution follows the Sprint 21
> precedent — the executed sprint keeps the number it ran under, and the
> not-yet-started Phase 4–6 sprints shift by one (deployable artifact 22→23,
> backups/DR 23→24, observability 24→25, verification/review 25→26). Sprint
> scopes, content, ordering, dependencies, and phase structure are unchanged.
> Cross-references updated in this document and the launch checklist (Sprint
> column); executed-sprint artifacts (14–22) are historical records and retain
> their original text.

### Phase 4 — Production infrastructure & deployment
- **Sprint 23 (next) — Deployable artifact & pipeline.** Per-app non-root Dockerfiles,
  minimal IaC for the target profile, build→migrate→deploy pipeline with rollback,
  secrets manager + rotation, least-privilege DB roles, pool/statement/lock
  timeouts. Closes ORG-PR-001, 006, 021, 022, 042. Deps: Phase 1–3. Exit: a
  tagged build deploys reproducibly to staging; secret rotation rehearsed.

### Phase 5 — Reliability, recovery & operations
- **Sprint 24 — Backups, DR & background jobs.** Automated encrypted backups +
  PITR, **tested restore drill**, migration-recovery rehearsal, scheduler/worker,
  retention/expiry jobs, retention enforcement, account deletion/export.
  Closes ORG-PR-005, 015, 016, 025, 028, 043. Exit: restore drill reconstructs DB
  to a timestamp and passes checks; jobs observable & idempotent.
- **Sprint 25 — Observability & incident readiness.** Metrics + tracing +
  dashboards + alerts, production runbooks, incident process, ops documentation.
  Closes ORG-PR-007, 008, 027; supports ORG-PR-009 alerting. Exit: dashboard +
  synthetic-failure alert; tabletop against one runbook.

### Phase 6 — End-to-end verification & security review
- **Sprint 26 — Verification & external review.** Failure-injection integration
  tests, browser E2E, live SMTP CI assertion, external pentest + DAST, standards
  re-map. Closes ORG-PR-026, 041; verifies 044; addresses external-verification
  items. Exit: E2E + failure-injection green; pentest findings triaged.

### Frontend (parallel track, any time after Phase 1)
- **Sprint FE — Frontend hardening.** Error boundary, CSP alignment, destructive
  confirmations, deep-link return, session-expiry UX, a11y. Closes ORG-PR-023,
  035, 036. Independent of the backend critical path.

## Critical path

`Sprint 15 → Sprint 16 → Sprint 23 → Sprint 24 → Sprint 26 → Launch`, with
Sprints 17/18/19 as near-critical dependencies of the launch gate. Backup/restore
(Sprint 24) is the longest-pole reliability item and must precede production data.

## Parallelizable work

- **Sprint 21** (supply-chain/CI — complete 2026-07-26) and **Sprint FE**
  (frontend) run independent of the critical path.
- **Sprint 18** and **Sprint 19** (both Phase 3) can run concurrently by different
  owners.
- **Sprint 25** (observability) can begin once infra (Sprint 23) exists, in
  parallel with Sprint 24.

## Decision gates

- Status at Sprint 15 closure (see
  [sprint-15-decisions.md](sprint-15-decisions.md)): **DG-1 (distribution
  model), DG-2 (role-transition policy), and DG-5 (RPO/RTO) are RATIFIED by
  the Project Owner (2026-07-18).** Ratification is the product decision
  only — downstream implementation remains scheduled work (DG-2 enforcement
  in Sprint 19; DG-1/DG-5 infrastructure and backup work in Sprints 21/22).
  **DG-3 compliance regime (legal)** and **DG-4 quota-billing semantics**
  remain open — DG-3 requires legal/privacy review and additionally gates
  Phase 5 privacy scope; DG-4 requires a product/billing-semantics decision.
  Neither blocks Sprint 15.

## Dependency notes

- **Infrastructure dependency:** everything in Phases 4–6 depends on Sprint 22 (deployable artifact).
- **External service dependency:** a real email provider (Sprint 16) gates
  recovery/verification.
- **Legal dependency:** ORG-PR-025/043 scope is blocked on DG-3 legal review.
- **Security-review dependency:** launch is blocked on Sprint 25's external review.

## Production launch gate

Launch is permitted only when: **all P1 closed**; all launch-blocking P2 closed
(see [launch-checklist.md](launch-checklist.md)); the **restore drill has
passed**; an **external security review** is complete with no unresolved
high-severity issue; and observability + incident runbooks are live. Passing
`pnpm validate`/`validate:integration` is necessary but **not** sufficient.

## Recommended next sprint: Sprint 15 — Production Configuration and Secret Safety

Chosen from the findings, not from the spec's examples. Sprint 14 already selected
and documented a usable production target ([production-target.md](production-target.md));
this sprint **implements** the config-safety blocker and ratifies only the decision
gates that directly bear on that implementation — it is not another repository-wide
planning sprint.

- **Why first:** the cheapest, highest-leverage security blocker is the config
  layer — ORG-PR-003 lets a production process boot with the shipped guessable
  `JWT_SECRET` and a non-Secure refresh cookie (threat **T-CONF**, rated
  Critical). Fixing it is an **S**-effort config-plus-tests change that removes the
  most dangerous day-one misconfiguration. It has no dependencies, so it can start
  immediately, and production infrastructure (Sprint 22) should not be built on a
  config layer that still accepts unsafe production values.
- **P1 findings it closes:** **ORG-PR-003** (production config secret guards).
  Also closes **ORG-PR-047** (resolve/remove the unused `COOKIE_SECRET`). It does
  **not** by itself close ORG-PR-001/002/004/005/006 — those are separate sprints;
  this sprint only ratifies the decision gates that scope them.
- **Depends on:** nothing (can start immediately).
- **What cannot proceed safely before it:** production infrastructure design
  (Sprint 22) and any staging deploy (would otherwise boot with unsafe defaults).
- **Objective:** eliminate unsafe production configuration and ratify the
  implementation-relevant decision gates.
- **Scope:** (1) add a production `superRefine` to `packages/config` rejecting the
  known dev-default `JWT_SECRET`/`COOKIE_SECRET`, enforcing `COOKIE_SECURE=true`
  and an entropy floor under `NODE_ENV=production`; (2) resolve or remove
  `COOKIE_SECRET` (ORG-PR-047); (3) ratify DG-1 (distribution model), DG-2
  (role-transition policy — informs later sprints), and DG-5 (RPO/RTO) as they
  gate the infrastructure/backup sprints; DG-3 (legal) and DG-4 remain open gates.
  **Explicit non-goals:** building infrastructure, email, recovery, or backups;
  re-running any repository-wide audit or re-selecting the production target.
- **Deliverables:** config guard + unit tests; updated `.env.example` guidance; a
  short decision record for the ratified gates.
- **Required tests:** unit tests proving a config with a dev-default secret or
  `COOKIE_SECURE=false` fails to load under `NODE_ENV=production`, and that a
  valid production config loads.
- **Exit criteria:** a config with dev-default secrets or `COOKIE_SECURE=false`
  **fails to boot** under `NODE_ENV=production` (test-proven); `COOKIE_SECRET`
  resolved; DG-1/DG-2/DG-5 recorded with owners; `pnpm validate` green.
- **Relative effort:** S.
- **Work blocked until completion:** Sprint 22 (infrastructure) and any staging
  deployment.
- **Sprint 15 outcome (2026-07-18): COMPLETE.** The engineering
  implementation is complete and validated — ORG-PR-003 and ORG-PR-047 closed
  with test evidence (see the [findings register](findings-register.md)
  resolutions and
  [docs/production-config-guard.md](../production-config-guard.md)) — and the
  decision-gate exit criterion is met: **DG-1, DG-2, and DG-5 were ratified
  by the Project Owner on 2026-07-18**
  ([sprint-15-decisions.md](sprint-15-decisions.md)); DG-3/DG-4 remain open
  as the sprint specification permits. (Historical note: the sprint was
  briefly recorded as NOT COMPLETE while the gates awaited the owner
  decision.) See
  [sprint-15-artifact-package.md](sprint-15-artifact-package.md). Sprint 15
  completion is not staging or production readiness — five P1 blockers
  remain.
