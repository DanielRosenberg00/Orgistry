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
- **Sprint 23 — Deployable artifact. COMPLETE (2026-08-23; DoD met).**
  Merged as PR #28 (7/7 checks successful, implementation commit `37a586c`);
  post-merge `main` (`6019db8`) workflows all green (CI 32650121796 incl.
  the `Artifacts (build + smoke)` job, Security 32650121899, CodeQL
  32650121792); the artifact check is registered as a required check in
  ruleset 19769611 (API-verified — branch-enforced). Delivered:
  production-shaped non-root container
  artifacts for API (esbuild bundle of the existing entrypoints +
  lockfile-exact hoisted production node_modules;
  `node:22.23.2-bookworm-slim`) and web (Vite build on nginx-unprivileged,
  SPA fallback); explicit one-shot migration entrypoint
  (`node dist/migrate.mjs` — never at API boot); production-like compose
  validation reference with fake guard-passing config; deterministic smoke
  gate (`tooling/artifact-smoke.sh`) added as the CI `artifacts` job;
  tag+digest pinning across ALL active image references; runtime
  secret-injection boundary enforced (no build-time secrets, no `.env` in
  images, secrets absent from logs/web assets). **Closed ORG-PR-042
  (implementation evidence). Left open, materially advanced: ORG-PR-001
  (artifacts + CI gate exist; no deployment pipeline/environment),
  ORG-PR-006 (injection boundary only; no manager/rotation).** The
  deployment-automation, secrets-manager, least-privilege-DB-role, and
  timeout items of the former combined entry were NOT executed and are not
  rescheduled here — they remain open Phase 4 work (ORG-PR-001 residual,
  006, 021, 022) to be scheduled at a later sprint boundary. Local exit
  evidence: `pnpm validate`, `pnpm validate:integration`, and
  `pnpm artifact:smoke` exit 0. Closing artifact:
  [sprint-23-artifact-package.md](sprint-23-artifact-package.md);
  docs: [../deployment-artifacts.md](../deployment-artifacts.md).
- **Sprint 24 — Runtime Secrets and External Email Validation. ✅ COMPLETE
  (2026-08-23); Sprint 24 DoD MET.** All required remote checks green for
  implementation commit `de6780f` on PR #33 (CI `32663739832`, CodeQL
  `32663739811`, Security scans `32663739952`). Real external SMTP validation
  was **not performed** — the specification permits that condition to be met by
  a precisely documented blocker, which it is, so it is not a failed
  deliverable (it does keep ORG-PR-002 open, and it is not evidence that
  production email works). Delivered: a runtime secret-source boundary
  (`packages/config/src/secret-source.ts`) giving six secret variables an
  optional mounted-file source (`<NAME>_FILE`) alongside the direct
  environment value, resolved BEFORE schema validation and onto the canonical
  variable name so file-backed secrets cannot bypass a production guard;
  graceful access-token key rotation (optional `JWT_PREVIOUS_SECRET`, accepted
  at verification only, test-proven at the primitive and HTTP-route level);
  SMTP credentials on the same boundary with failure-mode credential-redaction
  proofs; six new artifact-smoke checks over the mounted-secret path; and two
  operational documents ([../runtime-secrets.md](../runtime-secrets.md),
  [../rotation-runbook.md](../rotation-runbook.md)). **Not delivered — the
  external-email half could not be executed:** no email-provider credentials,
  no verified sending domain, and no readable test mailbox exist in this
  environment, so there is no provider-acceptance, inbox-receipt, or
  SPF/DKIM/DMARC evidence. **No finding closed. Left open, materially
  advanced: ORG-PR-002** (every repository-side prerequisite within Sprint 24's
  scope done; blocked on external provider/domain/mailbox access) **and
  ORG-PR-006** (runtime sources + rotation mechanics + runbooks exist, but a
  **genuine capability gap remains** — no secrets manager or platform secret
  store, no least-privilege secret access control, no secret-access
  auditability, no automated rotation or expiry tracking, no hot reload, and no
  rehearsed rotation, the last of which needs ORG-PR-001's environment; these
  are finding-closure and production-maturity gaps, **not** Sprint 24 DoD
  items).
  ORG-PR-049 also materially advanced. Local exit evidence: `pnpm validate`,
  `pnpm validate:integration`, `pnpm scan:deps`, `pnpm scan:deps:local`,
  `pnpm scan:secrets`, `actionlint`, and `tooling/artifact-smoke.sh` all pass;
  remote validation green for `de6780f`. Two earlier remote runs failed, each on
  a **Linux-only portability defect in a validation fixture** (artifact-smoke
  secret-directory permissions, then an SMTP timeout test's address family) —
  never in the application, and neither fixed by weakening the production
  security model; the chain `74f50e4` → `486bee8` → `de6780f` is preserved as
  evidence that CI worked. Closing artifact:
  [sprint-24-artifact-package.md](sprint-24-artifact-package.md).
- **Sprint 25 (COMPLETE — DoD MET, merged to `main` 2026-08-24 as PR #34,
  merge commit `b267f70`) — Backup, PITR, Restore, and Retention Foundation.**
  All seven PR checks green, the merged state of `main` re-validated green, and
  the `Data durability` PITR workflow dispatched against `main` and passed
  (run 32702918307). Delivered: a persistent-data inventory
  fixing PostgreSQL as the only durability boundary; a repeatable logical
  backup (`tooling/db-backup.sh`) with checksum and provenance metadata, every
  PostgreSQL client tool run from the repository's own pinned image; a restore
  drill (`tooling/db-restore-drill.sh`) that exercises the real backup path,
  rejects a corrupted artifact, restores into a genuinely empty target, asserts
  schema/migration-ledger/entity/relational/API-key-hash survival, and requires
  a migration re-run to be a no-op — with an `--with-artifact` mode completing
  the recovery contract through the packaged API image to `/health`, `/ready`,
  and an API-key-authenticated read of restored data; and **PITR VERIFIED**
  (`tooling/db-pitr-drill.sh`): base backup + demonstrably-working WAL
  archiving + `recovery_target_time`, with pre-target rows that exist only in
  archived WAL recovered and post-target `DELETE`/`DROP TABLE` damage undone.
  Retention shipped as a six-category policy catalog, a dry-run-by-default
  one-shot cleanup runnable from source and from the deployable artifact,
  hard-floored typed configuration, four additive cleanup indexes (migration
  `0012`), and 54 retention tests including 21 against live PostgreSQL (plus 7
  drill-fixture drift tests).
  **ORG-PR-015 is CLOSED. ORG-PR-005 remains OPEN — materially advanced**: its
  repository-controlled half is complete and verified, locally and remotely; nothing schedules a
  backup, no artifact is stored remotely or encrypted, no long-lived database
  archives WAL, no provider-managed PITR exists, and no RPO/RTO has been
  measured — all dependent on Phase 4 (ORG-PR-001). ORG-PR-028's recovery
  MECHANISM now exists but its rehearsal does not. Two Sprint 24 residuals ran
  **alongside** Sprint 25 and were not absorbed into it: the operator-blocked
  **ORG-PR-002** external-email validation
  ([../rotation-runbook.md](../rotation-runbook.md#validate-external-email-delivery))
  and **ORG-PR-006**'s residual secrets-management capability. Neither is
  closed; both remain outstanding production-readiness work. Closing artifact:
  [sprint-25-artifact-package.md](sprint-25-artifact-package.md).
- **Sprint 26 (COMPLETE in its repository scope, 2026-08-24) — Production
  Deployment Environment and Promotion Pipeline (ORG-PR-001).** Delivered the
  promotion and deployment MECHANISM: a gated GHCR release workflow that
  publishes the images its own artifact gate produced under an immutable
  commit-SHA tag and captures their registry digests; a schema-validated
  release manifest whose migration identity is DERIVED from the repository
  journal; a build-once/promote-by-digest contract enforced at four independent
  points (schema, digest assertion, a deployment topology with no `build:`
  section, and a running-container digest check); a single-host deployment
  topology (`infra/compose.deploy.yml`) plus the deployment configuration
  contract; an operator-run deployment script with thirteen named stages,
  including a backup/recovery-point preflight, migrations exactly once from the
  release's own image, and verification of the applied migration head against
  the manifest; a reusable URL-only post-deployment smoke command; an
  append-only deployment evidence ledger; application rollback to the previous
  known-good digests; an environment-scoped, read-only deployment-verification
  workflow; and an end-to-end rehearsal (`pnpm deploy:rehearsal`) that executes
  the whole lifecycle — including a rollback and three refusals — and passes.
  A same-day refinement pass then corrected three release-integrity defects
  without changing the architecture: the web artifact became environment-neutral
  (public browser configuration applied at container start, so one validated web
  digest is promotable instead of rebuilt per environment); rehearsal manifests
  became schema-marked non-deployable with explicit `working-tree` provenance
  and a content fingerprint when the tree is dirty; and publication became
  authorised by proof that all six required checks succeeded for the exact
  release commit, with their run IDs recorded in the manifest.
  Merged as PR #38 (`91664d0`) and **validated remotely**: every required job
  green for that exact SHA, `Release` `32776576782` publishing both images to
  GHCR after exact-SHA gate authorization, `Deploy` `32777270537`,
  `Deployment rehearsal` `32777259951`, and `Data durability` `32777249673` all
  successful. **Sprint 26 DoD is MET.**
  **No finding closed** (the permitted outcome for a sprint whose closure
  criteria depend on infrastructure that does not exist). **ORG-PR-001 remains
  OPEN — materially advanced:** the pipeline is executed and both images are
  published, but there is still no deployment target of any kind, nothing has
  been deployed to one, the `staging-like` GitHub Environment has zero
  protection rules, and rollback is validated only in the rehearsal.
  ORG-PR-005 and ORG-PR-006 gained integration and handling boundaries
  respectively; neither moves toward closure. Closing artifact:
  [sprint-26-artifact-package.md](sprint-26-artifact-package.md); docs:
  [../deployment.md](../deployment.md).
- **Sprint 27 (IN PROGRESS — BLOCKED ON DURABLE EXTERNAL TARGET, 2026-08-25) —
  Deployment Pipeline Closure (ORG-PR-001).** The objective is to validate
  Sprint 26's mechanism against the first durable staging-like target. That has
  not happened, so **the Sprint 27 DoD is not met and the sprint remains open**;
  its evidence package is a living document updated in place, not a closing
  artifact. **No target is reachable from
  this environment** — no provider CLI installed, no SSH key material, no target
  hostname, DNS name, TLS certificate, or deployment credential. A blocker is an
  acceptable factual outcome; a fabricated deployment is not, and none was
  claimed. What the sprint delivered instead is the first real external
  reconnaissance the project has performed, which found two defects invisible to
  a rehearsal. **(1) The GHCR packages are public, not private as Sprint 26
  recorded** — proven by pulling both published digests with an empty Docker
  configuration directory. A deployment host therefore needs no registry
  credential at all; the staging blocker "a pull credential for the host" is
  **resolved**, and keeping the packages public is recorded as a deliberate
  decision with its implications. **(2) The deployment had no image/host
  architecture check.** The published images are single-architecture
  `linux/amd64` and a pull is architecture-agnostic, so an arm64 host would have
  pulled them and failed only at container start — surfacing four stages later
  as "the API container did not become healthy", **after the backup preflight
  and the migration had already run against the target's database**.
  `pnpm deploy:rehearsal` builds locally, so its images are always native and
  the failure mode is invisible to it by construction. Implemented:
  `deploy_assert_image_runs_on_host` and its platform helpers in
  `tooling/lib/deploy-common.sh`; a new **stage 5** in `tooling/deploy.sh` that
  refuses a mismatch before anything touches the database, with emulation
  accepted only on an exact opt-in that is written onto the deployment evidence
  as a limitation; `tooling/deploy-target-preflight.sh` (`pnpm deploy:preflight`)
  for host qualification; and ten unit tests driving the real shell functions
  inside the required `Validate (offline)` check. The lifecycle was then re-run
  against the **real published GHCR artifacts**: deploy `91664d0`, deploy the
  second compatible release `d51c76b`, roll back to `91664d0` by digest — 9/9
  smoke each time, running digests verified, migrations neither re-run nor
  reversed. Both releases already existed on `main`; none was manufactured.
  **No finding closed.** That run was a local rehearsal on a workstation with no
  durability, no TLS, no DNS, no public origin, and amd64 images under CPU
  emulation — evidence tier **published-artifact local rehearsal**, not target
  validation. ORG-PR-001 remains **OPEN — materially advanced**; ORG-PR-002
  untouched; ORG-PR-005 and ORG-PR-006 unchanged in substance. Living evidence
  package (not a closing artifact):
  [sprint-27-artifact-package.md](sprint-27-artifact-package.md); docs:
  [../deployment.md](../deployment.md).
- **Sprint 27 (COMPLETE, 2026-08-27) — Deployment Pipeline Closure
  (ORG-PR-001). ORG-PR-001 CLOSED on real-target evidence.** A durable staging-like target was provisioned by the operator and
  validated by this repository's own tooling: a DigitalOcean `linux/amd64` host
  (Ubuntu 24.04.4, Docker enabled at boot, containers `restart=unless-stopped`,
  PostgreSQL on a named volume) serving real public HTTPS origins
  (`https://staging.drsvp.com`, `https://api-staging.drsvp.com`) behind Caddy
  v2.11.4 with valid Let's Encrypt certificates, inbound exposure externally
  probed and confirmed as 22/80/443 only. Target preflight passed 0 failed /
  0 warned; the host pulled both release digests itself **with no registry
  credential present on it**; release `91664d0` deployed with a backup preflight
  (`taken`), a one-shot migration and applied head `0012_shocking_warbound`
  verified against the manifest, running container digests verified, and
  **public HTTPS smoke 9/9** — the pre-deployment 502s became 200. A restart
  check confirmed persistence (migration ledger 13 before and after). The second
  compatible release `d51c76b` deployed (public smoke 9/9), and a **real
  application rollback** restored `91664d0`'s exact digests with `--no-migrate`,
  passing public HTTPS rollback smoke 9/9 with the running images verified and
  the schema untouched. Deploy workflow run `33061763360` bound to the
  `staging-like` environment validated the manifest and resolved both digests.
  Three machine-generated evidence records live on the host, scanned free of
  secret material. Neither release was manufactured — both pre-existed on `main`
  with identical migration identity — and **no source was built on the target**.
  **ORG-PR-001 closed.** ORG-PR-002, ORG-PR-005, and ORG-PR-006 remain open;
  staging readiness is **NO** (account email does not work on the target; no
  observability) and production readiness is **NO**. Evidence:
  [sprint-27-artifact-package.md](sprint-27-artifact-package.md); docs:
  [../deployment.md](../deployment.md).
- **Sprint 27 repository-change validation (2026-08-27) — COMPLETE.** Published
  as **PR #40** (branch `sprint-27-deployment-pipeline-closure`, head
  `0b6e6967bb95f26f211df29671210926eb136b75`, merge state CLEAN). All six
  required checks passed — `Validate (offline)`, `Integration (PostgreSQL +
  Redis)`, `Artifacts (build + smoke)`, `Dependency audit (pnpm)`,
  `Secret scan (Gitleaks)`, `Analyze (javascript-typescript)` — plus the CodeQL
  rollup, plus a manually dispatched **Deployment rehearsal** (run
  `33065548416`) at the exact published head, required because Sprint 27 changed
  the deployment tooling and that workflow has no push trigger. **Data
  durability** was correctly not required and no new **Release** was needed.
  **Sprint 27 DoD met: YES.**
- **Next — Sprint 28: Backup and Recovery Operations Closure (ORG-PR-005).**
  With ORG-PR-001 closed, the environment dependency that blocked this finding's
  larger half is gone. Now executable against the real target: scheduled
  backups, off-host encrypted storage, continuous WAL archiving with
  archive-health monitoring, a measured RPO/RTO, and — the piece Sprint 27
  explicitly did not attempt — a **real-target restore and PITR drill**.
  Secondary candidates, in order: **external email provider closure
  (ORG-PR-002)**, which would also make the staging environment exercisable end
  to end; **secrets platform integration (ORG-PR-006)**; and **observability
  (ORG-PR-007/009)**, without which the staging environment cannot be operated
  as a production rehearsal. Multi-architecture publishing remains unnecessary —
  the target is amd64.
- **Superseded (recorded for continuity) — Deployment Pipeline Closure (ORG-PR-001).** Provision
  the smallest real staging-like target that satisfies the
  [staging blockers](../deployment.md#remaining-staging-blockers), run the
  release workflow so images genuinely exist in GHCR, create the GitHub
  Environment with its protections, deploy the release to that target, roll it
  back, and record the evidence. That converts every Sprint 26 mechanism from
  rehearsed to executed and closes ORG-PR-001 on its own criterion. It stays
  the single largest unblocker on the critical path: the deployment-dependent
  half of ORG-PR-005 (scheduled, encrypted, remotely-stored backups and
  continuous WAL archiving on a real database), ORG-PR-006's rehearsed
  rotation, ORG-PR-028's bad-migration rehearsal, and any RPO/RTO measurement
  all wait on it. **Its one prerequisite is not a code change** — it is an
  operator/procurement decision to provide a host and a mail provider. If that
  decision is unavailable, the correct parallel work is **External Email
  Provider Closure and Secrets Platform Integration (ORG-PR-002 + ORG-PR-006)**.
  The later Phase 5–6 work below keeps its content, ordering,
  dependencies, and exit criteria but carries no assigned sprint numbers
  yet — numbers are assigned when each item is actually scheduled.

### Phase 5 — Reliability, recovery & operations
- **Later sprint — Backups, DR & background jobs.** *Scope reduced by Sprint
  25.* Already delivered there: the backup command, the tested restore drill,
  the verified PITR capability, and retention policy + enforcement
  (ORG-PR-015 **closed**). **Remaining for this sprint:** automated, encrypted,
  remotely-stored backups on a real deployment; continuous WAL archiving with
  archive-health monitoring; a provider-managed or self-managed PITR window;
  measured RPO/RTO; a rehearsed migration-recovery
  (ORG-PR-028); a scheduler/worker to invoke the existing backup and retention
  commands with metrics and failure alerting (ORG-PR-016); and account
  deletion/export (ORG-PR-025, 043). Closes ORG-PR-005, 016, 025, 028, 043.
  Exit: a scheduled backup lands in encrypted remote storage, a restore from
  that artifact reconstructs the DB to a timestamp and passes checks, and the
  maintenance jobs are observable and idempotent.
- **Later sprint — Observability & incident readiness.** Metrics + tracing +
  dashboards + alerts, production runbooks, incident process, ops documentation.
  Closes ORG-PR-007, 008, 027; supports ORG-PR-009 alerting. Exit: dashboard +
  synthetic-failure alert; tabletop against one runbook.

### Phase 6 — End-to-end verification & security review
- **Later sprint — Verification & external review.** Failure-injection integration
  tests, browser E2E, live SMTP CI assertion, external pentest + DAST, standards
  re-map. Closes ORG-PR-026, 041; verifies 044; addresses external-verification
  items. Exit: E2E + failure-injection green; pentest findings triaged.

### Frontend (parallel track, any time after Phase 1)
- **Sprint FE — Frontend hardening.** Error boundary, CSP alignment, destructive
  confirmations, deep-link return, session-expiry UX, a11y. Closes ORG-PR-023,
  035, 036. Independent of the backend critical path.

## Critical path

`Sprint 15 → Sprint 16 → Sprint 23 → Sprint 24 (runtime secrets & email
validation) → the backups/DR work →
the verification/external-review work → Launch`, with
Sprints 17/18/19 as near-critical dependencies of the launch gate. Backup/restore
(ORG-PR-005, the backups/DR work) is the longest-pole reliability item and must
precede production data. Sprint 25 removed its repository-controlled half from
the critical path — the capability is built and verified — so what remains of
ORG-PR-005 now sits entirely BEHIND Phase 4 (ORG-PR-001): there is nothing left
to build here that does not require a real deployment target.

## Parallelizable work

- **Sprint 21** (supply-chain/CI — complete 2026-07-26) and **Sprint FE**
  (frontend) run independent of the critical path.
- **Sprint 18** and **Sprint 19** (both Phase 3) can run concurrently by different
  owners.
- **The observability work** (ORG-PR-007/008) can begin once infra
  (Sprint 23) exists, in parallel with the backups/DR work.

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

- **Infrastructure dependency:** everything in Phases 4–6 depends on Sprint 23 (deployable artifact).
- **External service dependency:** a real email provider (Sprint 16) gates
  recovery/verification.
- **Legal dependency:** ORG-PR-025/043 scope is blocked on DG-3 legal review.
- **Security-review dependency:** launch is blocked on the external
  security review (the Phase 6 verification/external-review work).

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
