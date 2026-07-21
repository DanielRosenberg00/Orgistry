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
| Authorization | 3 | Partly | Permission-first, path-derived tenancy, negative tests | Admin→Owner unguarded | ORG-PR-017 | High |
| Tenant isolation | 3 | No | Repo org-scoping, uniform 404, real-DB tests | Read-path divergence (latent) | ORG-PR-053 | High |
| Data integrity | 2 | Partly | Partial-unique invariants, Last-Owner locking | Quota TOCTOU; workspace invariant | ORG-PR-029, 038 | High |
| Application security | 2 | Yes | Safe error handler, no DTO leaks, in-mem token | No headers/proxy/global limit | ORG-PR-010, 011, 012, 013 | High |
| Frontend | 1 | No (target: demo) | Exemplary token/secret handling | No error boundary/CSP | ORG-PR-023, 035, 036 | High |
| Testing | 2 | Partly | 67 files, strong negative/isolation coverage | No failure-injection/E2E/concurrency breadth | ORG-PR-026, 044 | High |
| CI/CD | 2 | Yes | Two-job CI mirrors validation | No release pipeline; pinning/permissions | ORG-PR-001, 019 | High |
| Supply chain | 2 | Yes | Lockfile, `onlyBuiltDependencies` | Unscanned; high advisory in range | ORG-PR-018, 020 | Medium |
| Infrastructure | 0 | Yes | (local Compose only) | No deploy artifact/IaC | ORG-PR-001, 022 | High |
| Reliability | 1 | Yes | Graceful shutdown; readiness probes | No backups/DR; fail-open | ORG-PR-005, 009 | High |
| Backup & recovery | 0 | Yes | (none) | No backup/PITR/restore drill | ORG-PR-005, 028 | High |
| Observability | 1 | Yes | Structured logs + request IDs | No metrics/tracing/alerts | ORG-PR-007 | High |
| Operations | 1 | Yes | Local runbook, strong DX | No incident process/prod runbook | ORG-PR-008, 027 | High |
| Privacy | 1 | Partly | Sanitized metadata, soft-delete | No export/delete; retention unenforced | ORG-PR-025, 043, 015 | Medium |
| Documentation | 3 | No | Honest, thorough, extension recipes | Stale subsystem docs; no prod ops docs | ORG-PR-027, 046 | High |

## Reading the scorecard

- **Authorization/tenant isolation/documentation (level 3)** are genuine strengths
  and must not regress during remediation. They are *not* launch clearance.
- **Infrastructure / backup & recovery (level 0)** and **reliability /
  observability / operations (level 1)** are the domains gating any real
  deployment — all downstream of the Phase 4/5 roadmap work.
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
