# Launch Checklist

Traceable, staged checklist derived from [findings-register.md](findings-register.md)
and [production-roadmap.md](production-roadmap.md). Every item links a finding and
a roadmap sprint. Status at the Sprint 14 audit baseline was **Open** for all
items (no production work was performed during the audit itself); the Status
column now carries later per-item updates (e.g. Sprint 15). A Sprint-column
value of `TBD` marks work mapped to the roadmap's unnumbered later-phase
placeholders; it receives a sprint number when actually scheduled. Owner
types:
**Eng** (engineering), **SecEng** (security), **Ops** (operations/SRE),
**Legal**, **Product**.

## Stage 1 — Mandatory before staging

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-1.1 | Ratify production target & decision gates DG-1…DG-5 | (target) | 15 | signed decision record | Product | **Closed (S15):** DG-1/DG-2/DG-5 ratified by the Project Owner 2026-07-18 ([sprint-15-decisions.md](sprint-15-decisions.md)); DG-3/DG-4 deliberately remain open (legal / product follow-ups) and are tracked by LC-2.9 and the register |
| LC-1.2 | Production config guards: reject dev-default secrets, force `COOKIE_SECURE`, quality floor (length + placeholder/degenerate rejection; not an entropy proof) | ORG-PR-003 | 15 | boot-refusal unit test | Eng | **Closed (S15):** `production configuration guard` suite in `packages/config/src/config.test.ts` |
| LC-1.3 | Resolve or remove unused `COOKIE_SECRET` | ORG-PR-047 | 15 | config change + test | Eng | **Closed (S15):** removed as unused; test proves it is neither required nor exposed |
| LC-1.4 | SHA-pin CI actions + add `permissions:` block | ORG-PR-019 | 21 | workflow diff | SecEng | **Closed (S21):** all `uses:` are verified full commit SHAs; workflow-level `contents: read` with `security-events: write` scoped to the CodeQL job only; `concurrency` groups; actionlint exit 0 |
| LC-1.5 | Add dependency/secret/SAST scanning to CI | ORG-PR-020 | 21/22 | CI runs scanners | SecEng | **Closed (S22):** all three workflows green remotely on `c33a150f` (runs 30205303375 / 30205303370 / 30205303373); the Gitleaks job proved to FAIL on a seeded synthetic secret (run 30207672121, `generic-api-key`, redacted, temporary branch deleted and never merged); CodeQL's 41 baseline alerts fully triaged with individual dispositions; `main` ruleset makes the checks required |
| LC-1.6 | Build deployable non-root artifacts + pipeline to staging | ORG-PR-001 | 23 | tagged build deploys to staging | Eng/Ops | Open — advanced (Sprint 23): non-root API/web artifacts, one-shot migration entrypoint, production-like compose reference, and the CI `artifacts` build+smoke gate exist ([../deployment-artifacts.md](../deployment-artifacts.md)); the pipeline-to-staging half remains open, to be scheduled separately (see roadmap Phase 4) |
| LC-1.7 | Security headers + `trustProxy` + DB timeouts | ORG-PR-011, 010, 021 | 18/23 | header/proxy/timeout tests | Eng | Open — advanced (Sprint 19): security headers on every response (`apps/api/src/plugins/security-headers.ts`) and typed `TRUST_PROXY` shipped with tests (ORG-PR-010/011 closed); DB/pool/statement timeouts (ORG-PR-021) remain open (not addressed in Sprint 23; scheduling TBD) |

## Stage 2 — Mandatory before production data

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-2.1 | **Backups + PITR configured** | ORG-PR-005 | TBD/25 | backup job runs; PITR verified | Ops | Open — half met (S25): **PITR VERIFIED** by `pnpm drill:pitr` (base backup + archived WAL + recovery target, post-target damage undone) and a repeatable backup command exists (`pnpm db:backup`), but **no backup job runs anywhere** — no scheduler, no remote/encrypted storage, no continuous WAL archiving on a long-lived database, no provider-managed PITR (needs ORG-PR-001) |
| LC-2.2 | **Backup restore drill executed & passing** (mandatory) | ORG-PR-005, 028 | TBD/25 | restore reconstructs DB to a timestamp + passes readiness/integration | Ops | Open — drill exists and passes against synthetic data (S25): `pnpm drill:restore -- --with-artifact` restores into a fresh database, verifies schema/migration ledger/entities, re-runs migrations as a no-op, and drives the packaged API to `/health` + `/ready` + an authenticated read of restored data; PITR reconstructs to a target timestamp. **Not yet executed against a real environment or production-sized data**, and no RPO/RTO measured |
| LC-2.3 | Secrets manager + rotation runbook | ORG-PR-006 | 24 | no committed secrets in non-local env; rehearsed rotation | Ops/SecEng | Open — advanced (S24): rotation runbooks written ([runtime-secrets](../runtime-secrets.md), [rotation-runbook](../rotation-runbook.md)); runtime env/file secret sources validated before the production guard; graceful JWT key rotation test-proven. Still missing the **manager** and the **rehearsed** rotation (needs a deployment environment, ORG-PR-001) |
| LC-2.4 | Least-privilege DB roles (runtime vs migration) | ORG-PR-022 | 23 | runtime role cannot DDL | Ops | Open |
| LC-2.5 | Production email provider live | ORG-PR-002 | 16, 24 | external-inbox delivery in staging | Eng | Open — advanced (S16): adapter + fail-closed config shipped; (S24): SMTP credentials on the runtime secret boundary, failure-mode credential-redaction proofs, per-family delivery matrix, and a documented operator validation procedure. External delivery, inbox receipt, and SPF/DKIM/DMARC all still pending provider credentials, a verified sending domain, and a test mailbox |
| LC-2.6 | Retention/expiry jobs + audit-read/org indexes | ORG-PR-015, 016, 014 | 20/25/TBD | jobs observable; `EXPLAIN` index use | Eng/Ops | Open — substantially advanced: the audit-read org index shipped (S20, `ix_security_events_org_created_id`, ORG-PR-014 closed with index-existence + EXPLAIN evidence); the retention POLICY and a tested, index-backed, batched cleanup command shipped (S25, ORG-PR-015 **closed**; four additive cleanup indexes in migration `0012`). Remaining: nothing SCHEDULES the cleanup and no run is observable — no scheduler, no metrics, no failure alerting (ORG-PR-016) |
| LC-2.7 | Role-transition policy enforced (per DG-2) | ORG-PR-017 | 20 | allow/block promotion tests | Eng | **Done (S20)** — in-transaction Owner-authority guard on role change AND removal; full allowed/forbidden matrix in route + live-DB suites |
| LC-2.8 | Atomic quota enforcement + concurrency tests | ORG-PR-029, 044 | 20 | concurrent-create cannot exceed ceiling | Eng | **Done (S20)** — org+kind advisory-lock serialization on every quota-protected create/accept/complete; five real-PostgreSQL races prove exact ceilings and fail if the lock is removed |
| LC-2.9 | Data-subject deletion/export path (per DG-3) | ORG-PR-025 | TBD | deletion/export integration tests | Eng/Legal | Open |

## Stage 3 — Mandatory before public launch

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-3.1 | Password recovery flow | ORG-PR-004 | 17 | reset integration tests (expiry/reuse/enum) | Eng | **Done (S17)** — route + live-DB suites cover expiry, reuse, concurrency, enumeration, revocation |
| LC-3.2 | Email verification + register de-enumeration | ORG-PR-024, 030 | 16/17/18 | verification tests; no register oracle | Eng | **Done (S18)** — verification lifecycle (S16) + verification-first registration (S18): the register oracle is removed (contract-identical generic acceptance for all account states, proven by an equality-matrix test); a residual timing side channel is documented in the findings register |
| LC-3.3 | Global/edge rate limiting + bound pre-auth writes + throttle inspect | ORG-PR-012, 013, 032 | 18 | limiter tests; load test bounds writes | SecEng | **Done (Sprint 19)** — global per-trusted-IP limiter, `invitations/inspect` per-IP + per-token-digest throttling, per-actor mutation buckets, and failed-auth `security_events` writes bounded per source IP (DB-backed storm test `api-key.failed-auth.integration.test.ts`) |
| LC-3.4 | Rate-limit fail-closed option + alerting | ORG-PR-009 | 18/TBD | fail-closed test + alert | SecEng/Ops | Open — advanced (Sprint 19): fail-closed implemented, tested, and production-default (`RATE_LIMIT_FAILURE_MODE`; guard refuses `open` in production); the alerting half awaits ORG-PR-007 (the observability work) |
| LC-3.5 | Observability: metrics/tracing/dashboards/alerts | ORG-PR-007 | TBD | dashboard + synthetic-failure alert | Ops | Open |
| LC-3.6 | Incident process + production runbooks + ops docs | ORG-PR-008, 027 | TBD | tabletop passes; docs published | Ops | Open |
| LC-3.7 | External security review / pentest + DAST | ORG-PR-018, 020 | TBD | report with no unresolved high | SecEng | Open |
| LC-3.8 | Failure-injection + E2E + live SMTP CI | ORG-PR-026, 041, 044 | TBD | suites green | Eng | Open |
| LC-3.9 | Frontend hardening (error boundary, CSP, confirmations, a11y) | ORG-PR-023, 035, 036 | FE | component tests + CSP present | Eng | Open |
| LC-3.10 | Legal/privacy review (regime, retention, subprocessors, breach) | ORG-PR-025, 043 | 15/TBD | legal sign-off | Legal | Open |

## Stage 4 — Mandatory shortly after launch

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-4.1 | PII retention enforcement in event metadata | ORG-PR-043, 015 | TBD/25 | aged PII removed/anonymized | Eng/Legal | Open — partially served (S25): `security_events` rows past `RETENTION_SECURITY_EVENT_DAYS` (default 180) are deleted by the retention cleanup, which bounds how long metadata PII persists. That is growth control, not erasure: there is no per-subject deletion, no anonymization of retained rows, and no legal-review-driven window (ORG-PR-043) |
| LC-4.2 | JWT `kid`/rotation path | ORG-PR-049, 006 | 23+ | overlapping-key rotation test | SecEng | Open |
| LC-4.3 | Best-effort writes isolated | ORG-PR-034 | 18 | throwing bookkeeping write doesn't fail request | Eng | Open |
| LC-4.4 | Multi-tab refresh grace window | ORG-PR-050 | 18 | benign double-refresh keeps session | Eng | Open |
| LC-4.5 | Refresh subsystem doc refresh (stale docs) | ORG-PR-046 | TBD | docs match source | Eng | Open |

## Stage 5 — Optional maturity improvements

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-5.1 | MFA/passkeys + security notifications | ORG-PR-045 | post-launch | enrol/verify + notification tests | Eng | Open |
| LC-5.2 | Remove redundant index / dead scaffolding | ORG-PR-051, 048 | as convenient | schema-drift passes | Eng | Open |
| LC-5.3 | `/ready` disclosure + shutdown timeout | ORG-PR-052 | as convenient | minimized `/ready`; bounded shutdown | Eng | **Done (Sprint 19)** — `/ready` coarse in production (ready/not-ready only), shutdown idempotent with a 10s bounded force-exit timer, plus inbound `x-request-id` sanitization (ORG-PR-052 closed) |
| LC-5.4 | PostgreSQL RLS as defense-in-depth | (roadmap) | post-launch | RLS blocks a missing app-scope | Eng | Open |

## Launch gate summary

The public-launch gate (Stage 3) cannot close until **every Stage 1 and Stage 2
item is closed**, the **LC-2.2 restore drill has passed**, and **LC-3.7 external
review** reports no unresolved high-severity issue. Stages 4–5 are tracked but do
not block launch.
