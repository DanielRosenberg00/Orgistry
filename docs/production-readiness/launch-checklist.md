# Launch Checklist

Traceable, staged checklist derived from [findings-register.md](findings-register.md)
and [production-roadmap.md](production-roadmap.md). Every item links a finding and
a roadmap sprint. Status at the Sprint 14 audit baseline was **Open** for all
items (no production work was performed during the audit itself); the Status
column now carries later per-item updates (e.g. Sprint 15). Owner types:
**Eng** (engineering), **SecEng** (security), **Ops** (operations/SRE),
**Legal**, **Product**.

## Stage 1 — Mandatory before staging

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-1.1 | Ratify production target & decision gates DG-1…DG-5 | (target) | 15 | signed decision record | Product | **Closed (S15):** DG-1/DG-2/DG-5 ratified by the Project Owner 2026-07-18 ([sprint-15-decisions.md](sprint-15-decisions.md)); DG-3/DG-4 deliberately remain open (legal / product follow-ups) and are tracked by LC-2.9 and the register |
| LC-1.2 | Production config guards: reject dev-default secrets, force `COOKIE_SECURE`, quality floor (length + placeholder/degenerate rejection; not an entropy proof) | ORG-PR-003 | 15 | boot-refusal unit test | Eng | **Closed (S15):** `production configuration guard` suite in `packages/config/src/config.test.ts` |
| LC-1.3 | Resolve or remove unused `COOKIE_SECRET` | ORG-PR-047 | 15 | config change + test | Eng | **Closed (S15):** removed as unused; test proves it is neither required nor exposed |
| LC-1.4 | SHA-pin CI actions + add `permissions:` block | ORG-PR-019 | 20 | workflow diff | SecEng | Open |
| LC-1.5 | Add dependency/secret/SAST scanning to CI | ORG-PR-020 | 20 | CI runs scanners | SecEng | Open |
| LC-1.6 | Build deployable non-root artifacts + pipeline to staging | ORG-PR-001 | 21 | tagged build deploys to staging | Eng/Ops | Open |
| LC-1.7 | Security headers + `trustProxy` + DB timeouts | ORG-PR-011, 010, 021 | 18/21 | header/proxy/timeout tests | Eng | Open — advanced (Sprint 19): security headers on every response (`apps/api/src/plugins/security-headers.ts`) and typed `TRUST_PROXY` shipped with tests (ORG-PR-010/011 closed); DB/pool/statement timeouts (ORG-PR-021) remain for Sprint 21 |

## Stage 2 — Mandatory before production data

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-2.1 | **Backups + PITR configured** | ORG-PR-005 | 22 | backup job runs; PITR verified | Ops | Open |
| LC-2.2 | **Backup restore drill executed & passing** (mandatory) | ORG-PR-005, 028 | 22 | restore reconstructs DB to a timestamp + passes readiness/integration | Ops | Open |
| LC-2.3 | Secrets manager + rotation runbook | ORG-PR-006 | 21 | no committed secrets in non-local env; rehearsed rotation | Ops/SecEng | Open |
| LC-2.4 | Least-privilege DB roles (runtime vs migration) | ORG-PR-022 | 21 | runtime role cannot DDL | Ops | Open |
| LC-2.5 | Production email provider live | ORG-PR-002 | 16 | external-inbox delivery in staging | Eng | Open — advanced (S16): adapter + fail-closed config shipped; external delivery still pending credentials/staging |
| LC-2.6 | Retention/expiry jobs + audit-read/org indexes | ORG-PR-015, 016, 014 | 22/19 | jobs observable; `EXPLAIN` index use | Eng/Ops | Open |
| LC-2.7 | Role-transition policy enforced (per DG-2) | ORG-PR-017 | 19 | allow/block promotion tests | Eng | Open |
| LC-2.8 | Atomic quota enforcement + concurrency tests | ORG-PR-029, 044 | 19 | concurrent-create cannot exceed ceiling | Eng | Open |
| LC-2.9 | Data-subject deletion/export path (per DG-3) | ORG-PR-025 | 22 | deletion/export integration tests | Eng/Legal | Open |

## Stage 3 — Mandatory before public launch

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-3.1 | Password recovery flow | ORG-PR-004 | 17 | reset integration tests (expiry/reuse/enum) | Eng | **Done (S17)** — route + live-DB suites cover expiry, reuse, concurrency, enumeration, revocation |
| LC-3.2 | Email verification + register de-enumeration | ORG-PR-024, 030 | 16/17/18 | verification tests; no register oracle | Eng | **Done (S18)** — verification lifecycle (S16) + verification-first registration (S18): the register oracle is removed (contract-identical generic acceptance for all account states, proven by an equality-matrix test); a residual timing side channel is documented in the findings register |
| LC-3.3 | Global/edge rate limiting + bound pre-auth writes + throttle inspect | ORG-PR-012, 013, 032 | 18 | limiter tests; load test bounds writes | SecEng | **Done (Sprint 19)** — global per-trusted-IP limiter, `invitations/inspect` per-IP + per-token-digest throttling, per-actor mutation buckets, and failed-auth `security_events` writes bounded per source IP (DB-backed storm test `api-key.failed-auth.integration.test.ts`) |
| LC-3.4 | Rate-limit fail-closed option + alerting | ORG-PR-009 | 18/23 | fail-closed test + alert | SecEng/Ops | Open — advanced (Sprint 19): fail-closed implemented, tested, and production-default (`RATE_LIMIT_FAILURE_MODE`; guard refuses `open` in production); the alerting half awaits ORG-PR-007 (Sprint 23) |
| LC-3.5 | Observability: metrics/tracing/dashboards/alerts | ORG-PR-007 | 23 | dashboard + synthetic-failure alert | Ops | Open |
| LC-3.6 | Incident process + production runbooks + ops docs | ORG-PR-008, 027 | 23 | tabletop passes; docs published | Ops | Open |
| LC-3.7 | External security review / pentest + DAST | ORG-PR-018, 020 | 24 | report with no unresolved high | SecEng | Open |
| LC-3.8 | Failure-injection + E2E + live SMTP CI | ORG-PR-026, 041, 044 | 24 | suites green | Eng | Open |
| LC-3.9 | Frontend hardening (error boundary, CSP, confirmations, a11y) | ORG-PR-023, 035, 036 | FE | component tests + CSP present | Eng | Open |
| LC-3.10 | Legal/privacy review (regime, retention, subprocessors, breach) | ORG-PR-025, 043 | 15/22 | legal sign-off | Legal | Open |

## Stage 4 — Mandatory shortly after launch

| ID | Action | Findings | Sprint | Evidence to close | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LC-4.1 | PII retention enforcement in event metadata | ORG-PR-043, 015 | 22 | aged PII removed/anonymized | Eng/Legal | Open |
| LC-4.2 | JWT `kid`/rotation path | ORG-PR-049, 006 | 21+ | overlapping-key rotation test | SecEng | Open |
| LC-4.3 | Best-effort writes isolated | ORG-PR-034 | 18 | throwing bookkeeping write doesn't fail request | Eng | Open |
| LC-4.4 | Multi-tab refresh grace window | ORG-PR-050 | 18 | benign double-refresh keeps session | Eng | Open |
| LC-4.5 | Refresh subsystem doc refresh (stale docs) | ORG-PR-046 | 24 | docs match source | Eng | Open |

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
