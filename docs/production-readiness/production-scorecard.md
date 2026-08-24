# Production Readiness Scorecard

Domain maturity against the [production target](production-target.md), derived
from [findings-register.md](findings-register.md).

## Maturity levels (defined)

- **0 — Absent:** capability does not exist.
- **1 — Prototype:** exists for local/demo use only; not production-shaped.
- **2 — Functional:** works and is tested, but has launch-blocking or material
  production gaps.
- **3 — Production-ready:** meets the target profile with no open P1/P2.
- **4 — Hardened:** production-ready plus maturity/observability depth.

## Overriding rule

**Any unresolved P0 or P1 prevents an overall production-ready result regardless
of individual domain maturity.** There are 6 open P1 findings; the overall state
is therefore **not production-ready**. Domain scores below are diagnostic, not an
average — do not read a high domain score as launch clearance.

## Scorecard

| Domain | Maturity | Launch-blocking? | Strongest evidence | Largest gap | P1/P2 findings | Conf |
| --- | --- | --- | --- | --- | --- | --- |
| Product completeness | 2 | Yes | Full org/RBAC/quota/keys/invitations/audit implemented & tested | No account recovery class | ORG-PR-004, 024, 025, 039, 045 | High |
| Authentication | 2 | Yes | Argon2id, hardened login, immediate revocation | Recovery absent; prod secret guards | ORG-PR-003, 004, 009 | High |
| Authorization | 3 | Partly | Permission-first, path-derived tenancy, DG-2 Owner-transition guard in-transaction (S20), negative tests | (Owner-transition gap closed S20) | — | High |
| Tenant isolation | 3 | No | Repo org-scoping, uniform 404, real-DB tests; read paths permission-aligned (S20) | (read-path divergence closed S20) | — | High |
| Data integrity | 3 | Partly | Partial-unique invariants (incl. at-most-one-active-personal-workspace, S20), Last-Owner locking, serialized quota transactions with in-tx plan snapshots and race proofs (S20), retention policy + tested batched cleanup with active-row preservation (S25, ORG-PR-015 closed) | Cleanup is operator-invoked; no scheduler | ORG-PR-016 | High |
| Application security | 2 | Yes | Safe error handler, no DTO leaks, in-mem token | No headers/proxy/global limit | ORG-PR-010, 011, 012, 013 | High |
| Frontend | 1 | No (target: demo) | Exemplary token/secret handling | No error boundary/CSP | ORG-PR-023, 035, 036 | High |
| Testing | 2 | Partly | Strong negative/isolation coverage + real-DB quota/authz concurrency races (S20) | No failure-injection/E2E | ORG-PR-026 | High |
| CI/CD | 4 | Yes | CI + security + CodeQL workflows: SHA-pinned actions, least-privilege permissions, frozen-lockfile installs (S21); all three green remotely, secret gate proved to FAIL on a seeded finding, `main` ruleset makes the checks required (S22); deployable-artifact build+smoke gate in CI (S23); release workflow that publishes to GHCR only after proving all six required checks succeeded for the exact release SHA, plus environment-scoped deployment-verification and deployment-rehearsal workflows — all executed remotely and green for `91664d0` (S26) | No artifact signing or SLSA provenance; nothing has been deployed to an environment | ORG-PR-001 | High |
| Supply chain | 3 | Yes | Advisories remediated (`drizzle-orm` 0.45.2, `esbuild` ≥0.25, in-range transitives, S21); audit gates + Gitleaks + Dependabot executing remotely and enforced as required checks, SAST findings fully triaged (S22); every active image reference tag+digest-pinned (S23, ORG-PR-042 closed); build-once/promote-by-digest enforced at four points and a schema-validated release manifest (S26); two documented advisory acceptances | No artifact signing or SLSA provenance attestation; published images are single-architecture amd64 | ORG-PR-001 | High |
| Infrastructure | 2 | Yes | Production-shaped non-root API/web artifacts + explicit migration entrypoint + production-like compose reference, all CI-smoke-validated (S23); single-host deployment topology, promote-by-digest deployment script with migrate-once + verified head, post-deploy smoke, evidence ledger, and rehearsed application rollback (S26) | **No deployment environment exists** — no host, provider account, or deployment credential, and nothing has been deployed to one; the `staging-like` GitHub Environment has no reviewer protection; no IaC; no TLS/DNS/proxy; no least-privilege DB roles | ORG-PR-001, 022 | High |
| Reliability | 2 | Yes | Graceful shutdown; readiness probes; tested recovery tooling (S25) | No scheduled backups; fail-open non-sensitive limiters | ORG-PR-005, 009, 016 | High |
| Backup & recovery | 2 | Yes | Repeatable logical backup + checksum + provenance; restore drill into a fresh DB reaching the packaged artifact incl. an authenticated read of restored data; **PITR VERIFIED** (base backup + archived WAL + recovery target); CI-gated; command-level runbooks (S25) | Nothing schedules a backup; no remote/encrypted storage; no continuous WAL archiving on a long-lived DB; no provider-managed PITR; no measured RPO/RTO; failed-migration recovery unrehearsed | ORG-PR-005, 028 | High |
| Observability | 1 | Yes | Structured logs + request IDs | No metrics/tracing/alerts | ORG-PR-007 | High |
| Operations | 1 | Yes | Local runbook, strong DX | No incident process/prod runbook | ORG-PR-008, 027 | High |
| Privacy | 1 | Partly | Sanitized metadata, soft-delete, bounded `security_events` history (S25) | No export/delete; retention is global growth control, not per-plan enforcement or erasure | ORG-PR-025, 043 | Medium |
| Documentation | 3 | No | Honest, thorough, extension recipes | Stale subsystem docs; no prod ops docs | ORG-PR-027, 046 | High |

## Reading the scorecard

- **Authorization/tenant isolation/documentation (level 3)** are genuine strengths
  and must not regress during remediation. They are *not* launch clearance.
- **Backup & recovery (level 2 since S25 — the capability is proven, nothing
  runs it)**, **infrastructure (still level 2 after S26 — artifacts and now a
  rehearsed deployment MECHANISM exist, an environment does not)**, and
  **observability / operations (level 1)** are the domains
  gating any real deployment — all downstream of the Phase 4/5 roadmap work.
  Backup & recovery moved 0 → 2, not to 3: a verified drill is a capability,
  and a capability nothing schedules is not a backup posture. Infrastructure
  stayed at 2 after Sprint 26 for the same reason: a rehearsed deployment
  pipeline with no target is a capability, not infrastructure. It reaches 3
  when a real environment has been deployed to and rolled back.
- **Authentication and application security (level 2)** carry the security-relevant
  P1/P2s that Phase 2/3 close.

## Overall indicator

**Not production-ready.** 6 open P1 blockers (ORG-PR-001, 002, 003, 004, 005,
006) span infrastructure, email, configuration, account lifecycle, and backup —
each independently disqualifying under the overriding rule. The correct current
readiness state is **C — Ready to begin production implementation**: the audit is
complete, the roadmap is actionable, and exactly one dependency-free next sprint
is defined, so the program to close those P1 blockers can begin immediately.
State C does **not** mean ready for staging or production — those remain gated by
the P1/P2 work and the launch gate (see
[production-roadmap.md](production-roadmap.md) and the final decision in
[sprint-14-artifact-package.md](sprint-14-artifact-package.md#final-readiness-decision)).

> **Status update (Sprints 15–16, 2026-07-18).** The table and indicator above
> are the Sprint 14 audit baseline, preserved as recorded. Since then:
> ORG-PR-003 closed (Sprint 15 config guard) and ORG-PR-024/048 closed
> (Sprint 16 email-verification lifecycle); ORG-PR-002 is materially advanced
> (production-shaped SMTPS adapter + fail-closed mail config) but stays open
> pending external-provider delivery evidence. **5 P1 blockers remain open
> (ORG-PR-001, 002, 004, 005, 006)** — the overriding rule still yields *not
> production-ready*, and the current state is
> **C — Ready to continue production implementation** (not ready for staging,
> not ready for production).

> **Status update (Sprint 17, 2026-07-20).** ORG-PR-004 (P1) and ORG-PR-039
> (P3) closed — the account-recovery/credential-lifecycle gap named as the
> "Product completeness" and "Authentication" largest-gap driver above is now
> implemented and lifecycle-tested. ORG-PR-030 (P3) is materially advanced
> (throttled + evented, still distinguishable). **4 P1 blockers remain open
> (ORG-PR-001, 002, 005, 006)** — all in the production envelope (deployment,
> external email evidence, backup/restore, secrets management), none in
> product code. The overriding rule still yields *not production-ready*; the
> state remains **C — Ready to continue production implementation** (not
> ready for staging, not ready for production).

> **Status update (Sprint 18, 2026-07-20).** ORG-PR-030 (P3) closed — public
> registration is verification-first and the registration account-existence
> oracle is removed (contract-identical generic acceptance for every
> post-validation account state; account creation only via the emailed
> single-use completion token; closure proven by a response-equality test
> matrix and DB-backed concurrency suites; a residual timing side channel is
> documented and accepted; a 2026-07-21 refinement pass additionally made
> invitation-carrying registration fully generic and closed the remaining
> invitation-state disclosure on the public register endpoint). No P1/P2
> movement — the sprint targeted a P3 security risk plus its product
> redesign. **4 P1 blockers remain open
> (ORG-PR-001, 002, 005, 006).** The overriding rule still yields *not
> production-ready*; the state remains **C — Ready to continue production
> implementation** (not ready for staging, not ready for production).

> **Status update (Sprint 19, 2026-07-21).** The edge and application
> security hardening sprint closed ORG-PR-010, 011, 012, 013 (P2),
> ORG-PR-032, 033 (P3), and ORG-PR-052 (P4) — the "No headers/proxy/global
> limit" largest-gap driver on the "Application security" row above is now
> implemented and test-proven: typed `TRUST_PROXY` (forwarded headers ignored
> unless explicitly trusted), security headers on every response with
> production-only HSTS `includeSubDomains`, a global per-trusted-IP rate
> limit plus `invitations/inspect` per-IP and per-token-digest throttling,
> failed-auth `security_events` writes bounded per source IP (DB-backed storm
> test), per-actor mutation buckets enforced after permission checks,
> centralized logger redaction, request-id sanitization, a coarse production
> `/ready`, and bounded idempotent shutdown. ORG-PR-009 (P2) is materially
> advanced — sensitive buckets fail closed under the production-default
> `RATE_LIMIT_FAILURE_MODE=closed` — but stays open for its alerting half
> (depends on ORG-PR-007). No P1 movement — the sprint targeted the
> P2–P4 edge-hardening surface. **4 P1 blockers remain open
> (ORG-PR-001, 002, 005, 006).** The overriding rule still yields *not
> production-ready*; the state remains **C — Ready to continue production
> implementation** (not ready for staging, not ready for production).

> **Status update (Sprint 23, 2026-08-23 — COMPLETE, DoD met: PR #28 merged,
> `main` @ `6019db8` workflows green, artifact check branch-required in
> ruleset 19769611).** The deployable-artifact
> sprint raised Infrastructure 0→2: production-shaped non-root container
> artifacts (API + web), an explicit one-shot migration entrypoint, a
> production-like compose validation reference, and a branch-required CI
> build+smoke gate (green locally, on PR #28, and on `main` — CI run
> 32650121796) now exist
> and are validated from the packaged artifacts (`pnpm artifact:smoke`).
> ORG-PR-042 closed (every active image reference pinned tag+digest);
> ORG-PR-001 and ORG-PR-006 advanced but open — there is still no deployment
> environment, pipeline, IaC, registry publishing, secrets manager, or
> rotation procedure. **4 P1 blockers remain open (ORG-PR-001, 002, 005,
> 006).** The overriding rule still yields *not production-ready*; the state
> remains **C — Ready to continue production implementation** (not ready for
> staging, not ready for production).

> **Status update (Sprint 24, 2026-08-23 — COMPLETE; Sprint 24 DoD MET.** All
> required remote checks are green for implementation commit `de6780f` on PR
> #33: CI `32663739832`, CodeQL `32663739811`, Security scans `32663739952`.**)**
> The runtime-secrets half landed: secrets resolve
> at process start from a direct environment value or a mounted `<NAME>_FILE`
> secret, **before** schema validation and onto the canonical variable name, so
> file-backed secrets cannot bypass a production guard (test-proven and
> artifact-validated); access-token keys rotate gracefully through an optional
> verification-only `JWT_PREVIOUS_SECRET`; credential redaction is proven
> across the startup, config, secret-file, SMTP-failure, and 401 paths; and
> manual rotation/incident runbooks exist. The external-email half was **not
> executable**: this environment has no email-provider credentials, no verified
> sending domain, and no readable test mailbox, so there is no
> provider-acceptance, inbox-receipt, or SPF/DKIM/DMARC evidence and none is
> claimed — the specification permits that condition to be met by a precisely
> documented blocker, so it is not a failed sprint deliverable, but it does
> leave ORG-PR-002 open and leaves Orgistry with **no evidence that production
> email works**. Secrets/Ops maturity improves; **Email delivery does not
> move** — adapter and credential plumbing are not delivery evidence. **No
> finding closed, which is a permitted sprint outcome, not a sprint failure.** ORG-PR-002, ORG-PR-006, and ORG-PR-049 are materially advanced but
> open — and ORG-PR-006's residual is a **real capability gap** (no secrets
> manager or platform store, no least-privilege secret access, no
> secret-access auditability, no automated rotation, no rehearsed rotation),
> not merely an external blocker — and those are finding-closure and
> production-maturity gaps rather than Sprint 24 DoD items. **4 P1 blockers remain open (ORG-PR-001,
> 002, 005, 006), plus ORG-PR-015 at P2.** The overriding rule still yields
> *not production-ready*; the state remains
> **C — Ready to continue production implementation** (not ready for staging,
> not ready for production). Recommended next: **Sprint 25 — Backup, PITR,
> Restore, and Retention Foundation**, with ORG-PR-002's external-email
> validation and ORG-PR-006's residual secrets-management capability running
> alongside it as outstanding workstreams.

> **Scorecard update (Sprint 25, 2026-08-24).** **Backup & recovery moves
> 0 → 2**: a repeatable logical backup with checksum and provenance, a restore
> drill that recovers into a fresh database and reaches the packaged API
> artifact through an API-key-authenticated read of restored data, and a
> **VERIFIED** PostgreSQL PITR drill (base backup + demonstrably-working WAL
> archiving + recovery to a target time, with post-target damage proven undone)
> — verified both locally and on GitHub Actions against `main`
> (`Data durability` run 32702918307), all CI-gated, with command-level
> runbooks. It does NOT reach 3: nothing
> schedules a backup, no artifact is stored remotely or encrypted, no
> long-lived database archives WAL, no provider-managed PITR exists, and no
> RPO/RTO has been measured. **Reliability moves 1 → 2** on the same evidence.
> **Data integrity keeps level 3 and loses its retention gap**: ORG-PR-015 is
> **closed** — policy, a dry-run-by-default one-shot cleanup runnable from both
> source and the deployable artifact, index-backed batched deletion, and
> PostgreSQL-backed safety tests; the residual is scheduling (ORG-PR-016).
> **Privacy stays at 1**: retention bounds growth, it is not erasure, and no
> export/delete capability exists. **4 P1 blockers remain open (ORG-PR-001,
> 002, 005, 006).** The overriding rule still yields *not production-ready*;
> the state remains **C — Ready to continue production implementation** (not
> ready for staging, not ready for production). Recommended next:
> **Sprint 26 — Deployment Environment, Promotion, and Rollback (ORG-PR-001)**,
> which is the prerequisite that unblocks the deployment-dependent half of
> ORG-PR-005 as well as ORG-PR-006's rehearsed rotation.

> **Scorecard update (Sprint 26, 2026-08-24).** **No domain changes maturity
> level, and no finding closes.** CI/CD, supply chain, and infrastructure all
> gain substantial evidence — a gated GHCR release workflow that publishes the
> images its own artifact gate produced, immutable commit-SHA tags with digest
> capture, a schema-validated release manifest, a deployment topology that
> structurally cannot rebuild source, an operator-run deployment with a
> migrate-exactly-once contract and a verified applied migration head,
> post-deployment smoke, an append-only evidence ledger, application rollback to
> the previous known-good digests, and an end-to-end rehearsal that executes the
> whole lifecycle and passes locally. The pipeline was then **executed
> remotely** against merged `main` `91664d0`: `Release` `32776576782` published
> both images to GHCR after proving all six required checks succeeded for that
> exact SHA, and `Deploy` `32777270537`, `Deployment rehearsal` `32777259951`,
> and `Data durability` `32777249673` all passed.
> **CI/CD moves 3 → 4** on executed release-authorization evidence.
> **Infrastructure deliberately stays at 2.**
> A deployment pipeline with no target is a capability, not
> infrastructure: no host, provider account, or deployment credential exists;
> **nothing has been deployed to any environment**; the `staging-like` GitHub
> Environment exists but carries zero protection rules; and rollback is
> validated only in the rehearsal, between two releases differing by an image
> label,
> against a throwaway database. Infrastructure reaches 3 when a real environment
> has actually been deployed to and rolled back. **Backup & recovery stays at
> 2**: the deployment integrates the Sprint 25 backup at the one point that
> matters (a labelled pre-migration backup whose recovery point is recorded,
> with an unexplained skip refused), which is integration, not a backup
> programme. **Secrets/Ops stays where it was**: deployment-side secret
> *handling* is enforced (0600 runtime configuration file, one secret read and
> never logged, credential-shape guards on manifests and evidence, no long-lived
> registry credential), but there is still no secret store, access control,
> auditing, or automated rotation. **4 P1 blockers remain open (ORG-PR-001,
> 002, 005, 006).** The overriding rule still yields *not production-ready*; the
> state remains **C — Ready to continue production implementation** (not ready
> for staging, not ready for production). Recommended next: **Deployment
> Pipeline Closure** — provision the smallest real staging-like target, run the
> release workflow so images actually exist in GHCR, deploy and roll back
> against that target, and close ORG-PR-001 on evidence. It is recommended over
> the email/secrets or backup-scheduling alternatives on dependency grounds:
> ORG-PR-001 blocks the deployment-dependent halves of ORG-PR-005, ORG-PR-006
> (a rehearsed rotation needs a real runtime), ORG-PR-007, and ORG-PR-008, and
> Sprint 26 leaves it needing exactly one thing the repository cannot supply —
> a host. Its prerequisite is an operator/procurement decision, not a code
> change; if that decision is not available, **External Email Provider Closure
> and Secrets Platform Integration (ORG-PR-002 + ORG-PR-006)** is the correct
> fallback.
