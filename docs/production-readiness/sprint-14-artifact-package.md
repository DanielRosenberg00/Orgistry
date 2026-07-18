# Sprint 14 Artifact Package — Full Repository Production Readiness Audit

Official closing artifact for Sprint 14. Authoritative detail lives in the linked
package documents; this is the executive record.

## 1. Executive summary

Orgistry is a genuinely well-engineered identity/access foundation whose
**implemented surface is correct, tenant-isolated, and well-tested** — but it is
**not production-ready**. A whole-repository audit found **54 evidence-backed
findings** (6 P1 blockers, 22 P2, 17 P3, 9 P4, no P0). The blockers are not defects
in the existing logic; they are the *absence* of the production envelope around it:
no deployment artifact or pipeline, no production email, no production
configuration guards, no account-recovery flow, no backups/restore, and no secrets
management. The security core (Argon2id, hash-only rotating sessions with reuse
detection, permission-first authorization, uniform cross-tenant 404s, hash-only
machine credentials, sanitized audit) is a real strength to build on, not rebuild.
The correct state is **C — Ready to begin production implementation**: the audit
and roadmap are sufficient to start closing the P1 blockers, beginning with a
focused configuration-safety sprint. State C is not a claim of staging or
production readiness — the six P1 blockers remain open.

## 2. Sprint objective & scope

Audit the entire tracked repository as one system; establish real current state;
identify evidence-backed production gaps; classify severity; produce a
dependency-aware roadmap and launch gate; recommend exactly one next sprint.
**No production code was implemented or changed** (documentation-only). In-scope:
the full repository across all listed domains. Out-of-scope (per the Sprint 14
brief): implementing any fix, upgrading dependencies for remediation, cloud infra,
deployment, or any certification/production claim.

## 3. Repository revision audited

`d0b2f97` on `main` (tree clean at audit start). 338 tracked files. No tags exist.

## 4. Production target summary

Self-hosted, single-region, low-scale multi-tenant B2B identity foundation,
operated by a small team; simplest architecture (reverse proxy + TLS + 2 API
replicas + managed Postgres/Redis + real SMTP + scheduler + secrets manager) —
**not Kubernetes**. Objectives: ~99.5% availability, p95 < 300 ms, RPO ≤ 1h / RTO
≤ 4h before production data, no billing. Five decision gates (DG-1…DG-5) remain
open. Full detail: [production-target.md](production-target.md).

## 5. Audit method

Whole-repo census → seven parallel read-only domain investigations (auth/crypto,
authz/tenancy/concurrency, invitations/keys/audit, database/migrations, API
platform/contracts, frontend, testing/CI/supply-chain) + a documentation
reconciliation pass → required validation commands → self-verification of the
load-bearing P1/P2 claims → synthesis into one findings register, then scorecard,
roadmap, and checklist derived from it → cross-document consistency review.

## 6. Coverage statement

Every app (2), package (5), API module (8), route group (12), database table (16),
migration (0000–0007), CI workflow (1), root/DB script, Docker/Compose file, test
class (67 files), and production-relevant document is represented in
[repository-inventory.md](repository-inventory.md). Absence findings document what
was searched, where, and what related code exists.

## 7. Validation evidence

Exit codes below are the **actual command exit status**, captured by redirecting
each command's output to a file and reading `$?` immediately — not via a
`… | tail` pipeline (which, without `pipefail`, would report `tail`'s exit code,
not the command's). An earlier pass reported `pnpm audit` as exit 0 through such a
pipeline; the true exit code is **1**, corrected here.

| Command | Exit | Classification | Result / evidence |
| --- | --- | --- | --- |
| `pnpm validate` | **0** | Passing validation | typecheck + ESLint + unit (53 files / 489 tests) + web-demo (5 files / 19 tests) + web build + schema-drift ("migrations are in sync") + whitespace — all green. |
| `pnpm validate:integration` | **0** | Passing validation (environment-adjusted) | `db:reset:test` succeeded; DB migrate-from-scratch: 1 file / 13 tests; API integration: 8 files / 38 tests — all passed. Env overrides: `DATABASE_URL`/`TEST_DATABASE_URL` → `postgres://orgistry:orgistry@localhost:55432/…`, `REDIS_URL=redis://localhost:6379`, `NODE_ENV=test`. |
| `pnpm audit` | **1** | Vulnerability findings (NOT a pass) | 3 vulnerabilities: **1 high** `drizzle-orm <0.45.2` GHSA-gpj5-g38j-94v9 (ORG-PR-018) + **2 moderate** `esbuild <=0.24.2` via `drizzle-kit>@esbuild-kit/*` and `drizzle-kit>esbuild`, GHSA-67mh-4wv8-2f99, dev-only (ORG-PR-054). |
| `pnpm audit --prod` | **1** | Vulnerability findings (NOT a pass) | **1 high** only — the `drizzle-orm` advisory; the moderate `esbuild` findings are dev-dependency-only and absent from the prod tree. |
| `git diff --check` | **0** | Clean | No whitespace/conflict errors in tracked changes. |
| `git status --short` | **0** | Documentation-only | `M README.md` + untracked `docs/production-readiness/`. |

**Environment limitation (not an application defect):** host port 5432 on the
audit machine is held by an unrelated PostgreSQL, so integration validation ran
against a uniquely-named throwaway container `orgistry-pg-sprint14-refine` on port
**55432** (the scenario documented in `docs/runbook.md`). Only that throwaway
container was created and then removed; the pre-existing `vocab_postgres`,
`orgistry-redis-1`, and `orgistry-mailpit-1` containers were not modified or
stopped. CI validates the default-port path. This is an **environment
limitation**, not a network limitation or a validation failure.

`pnpm audit` **executed successfully but is not "passing"** — it exited non-zero
because vulnerabilities were found; the advisories are recorded above and routed
to the roadmap (ORG-PR-018/054). No package was upgraded (out of scope). No
command was represented as passing that was not run.

## 8. Highest-severity findings

**P1 (production blockers):**
- **ORG-PR-001** — No production deployment automation (Dockerfiles/IaC/pipeline).
- **ORG-PR-002** — No production email provider (Mailpit-only).
- **ORG-PR-003** — Dev-default secrets accepted & `COOKIE_SECURE` unenforced under
  `NODE_ENV=production` (threat T-CONF, Critical).
- **ORG-PR-004** — No password recovery flow.
- **ORG-PR-005** — No database backup / PITR / tested restore.
- **ORG-PR-006** — No secrets management or rotation procedure.

**Representative P2s:** ORG-PR-009 (fail-open limits), 010 (`trustProxy`), 011 (no
security headers), 012/013 (edge rate limiting / pre-auth audit writes), 014
(audit-read index), 015/016 (retention / background runtime), 017 (Admin→Owner),
018 (drizzle advisory), 019/020 (CI pinning / no scanning), 022 (DB superuser),
023 (no error boundary), 024/025 (verification / data-subject rights), 007/008
(observability / incident readiness). Full register:
[findings-register.md](findings-register.md).

## 9. Production readiness state

**Not production-ready.** Six independent P1 blockers, any one of which is
disqualifying under the blocker-semantics rule. The implemented feature set is
production-*quality* in correctness and testing but sits without a production
envelope.

## 10. Scorecard summary

Strengths at maturity **3**: authorization, tenant isolation, documentation.
Gating domains at **0–1**: infrastructure, backup & recovery, observability,
operations, reliability, frontend (target: demo). Security-relevant **2**s:
authentication, application security, supply chain, testing, CI/CD. Overall
indicator preserves blocker semantics — high domain scores are not launch
clearance. Detail: [production-scorecard.md](production-scorecard.md).

## 11. Critical path

`Sprint 15 (config-safety) → Sprint 16 (production email + verification) →
Sprint 21 (deployable artifact + pipeline + secrets + least-privilege DB) →
Sprint 22 (backups + restore drill + background jobs) → Sprint 24 (E2E + external
security review) → Launch`. Sprints 17/18/19 are near-critical; Sprint 20
(supply-chain/CI) and the frontend track run in parallel off the critical path.
Backup/restore is the longest-pole reliability item and gates production data.

## 12. Recommended next sprint (exactly one)

**Sprint 15 — Production Configuration and Secret Safety.** (Sprint 14 already
selected a usable production target; this sprint implements the config blocker, it
is not another planning sprint.)
- **Why first:** the cheapest, most dangerous security blocker — ORG-PR-003 lets a
  production process boot with the shipped guessable `JWT_SECRET` and a non-Secure
  refresh cookie (threat T-CONF, rated Critical). It has no dependencies and is an
  **S**-effort config-plus-tests change; infrastructure (Sprint 21) should not be
  built on a config layer that still accepts unsafe production values.
- **Closes:** **ORG-PR-003** (production config secret guards) and **ORG-PR-047**
  (unused `COOKIE_SECRET`). It does not by itself close ORG-PR-001/002/004/005/006
  — it only ratifies the implementation-relevant decision gates (DG-1/DG-2/DG-5)
  that scope those later sprints.
- **Depends on:** nothing — can start immediately.
- **Blocks until done:** production infrastructure design (Sprint 21) and any
  staging deploy.
- **Exit criteria:** a config with dev-default secrets or `COOKIE_SECURE=false`
  fails to boot under `NODE_ENV=production` (test-proven); `COOKIE_SECRET`
  resolved; DG-1/DG-2/DG-5 recorded with owners; `pnpm validate` green.

Full sprint spec: [production-roadmap.md](production-roadmap.md#recommended-next-sprint-sprint-15--production-configuration-and-secret-safety).

## 13. Remaining unknowns

- Which `InvitationMailer` `server.ts` instantiates in a production build (Mailpit
  vs. a real adapter) — confirm during Sprint 16 (ORG-PR-002).
- Whether a reverse proxy/WAF fronts the API in the target deployment (sets the
  real severity of ORG-PR-010/012/013).
- Production PostgreSQL isolation level and connection-role privileges (affects
  ORG-PR-029/022 real-world behavior).
- Actual production runtime table volumes (all "unbounded growth" findings are
  structural).
- Runtime `CORS_ORIGINS` contents (CSRF defense depends on the allow-list).

## 14. External verification required

- Independent **security review / penetration test** and **DAST** against staging
  (ORG-PR-018/020; standards-matrix).
- **Legal/privacy review** for data-subject rights, retention, subprocessors, and
  breach obligations (ORG-PR-025/043; DG-3).
- **Authoritative standards re-map** (ASVS/SSDF/SAMM/SLSA exact identifiers) —
  the current matrix is explicitly practice-level, not verbatim.
- Triage of the `drizzle-orm` advisory's exploitability in this codebase.

## 15. Documentation index

| Document | Purpose | Authority level | Primary audience | Relation to findings register |
| --- | --- | --- | --- | --- |
| [README.md](README.md) | Package overview: context, conventions, method, limitations | Navigational / conventions | All readers | Defines the register's severity conventions and hub role |
| [production-target.md](production-target.md) | Target profile, assumptions, decision gates DG-1…DG-5 | Authoritative for the target profile | Product / Eng | Findings are assessed against this target |
| [repository-inventory.md](repository-inventory.md) | Complete repository inventory with maturity classification | Descriptive evidence base | Eng | Evidence base the findings cite |
| [product-gap-analysis.md](product-gap-analysis.md) | v1 capability matrix vs. actual status | Derived view | Product / Eng | Views product-completeness findings by ID |
| [security-assessment.md](security-assessment.md) | Cross-domain security posture | Derived view | SecEng | Views security findings by ID |
| [threat-model.md](threat-model.md) | Assets, trust boundaries, threats, controls, residual risk | Authoritative for threat IDs (T-\*) | SecEng | Findings tag threats; threats map back to finding IDs |
| [standards-matrix.md](standards-matrix.md) | Practice-level standards mapping (explicitly no certification) | Informative only | SecEng / external reviewers | Rows reference finding IDs |
| [findings-register.md](findings-register.md) | All 54 findings with evidence and remediation | **Authoritative** | All readers | Is the register |
| [production-scorecard.md](production-scorecard.md) | Domain maturity, blocker status, confidence | Derived view | Leadership / Eng | Scores derived from the register |
| [production-roadmap.md](production-roadmap.md) | Sequenced phases, critical path, next sprint, launch gate | Authoritative for sequencing | Eng / Product | Every P1/P2 mapped to a phase/sprint |
| [launch-checklist.md](launch-checklist.md) | Five-stage launch gate checklist | Derived tracker | Ops / Eng | Every item traces to a finding and sprint |
| [sprint-14-artifact-package.md](sprint-14-artifact-package.md) | Official Sprint 14 closing artifact (this document) | Executive record | Leadership | Summarizes; the register remains authoritative |

**`findings-register.md` is the authoritative source for finding IDs, titles,
classifications, severities, confidence, remediation, and roadmap mapping.** All
other documents are derived views and must not restate different values.

## 16. Confidence assessment

**High** overall. Findings are grounded in direct source reading across seven
independent investigations that mutually corroborated (e.g. fail-open limits, the
absent recovery surface, and the missing production envelope surfaced from
multiple angles). The three most load-bearing P1/P2 claims (config guards, the
external-API pre-auth `security_events` write, and the missing `trustProxy`/
`helmet`) were independently re-verified by the auditor. Confidence is **Medium**
where noted: exploitability of ORG-PR-018, the production mailer wiring, and
production isolation-level behavior. Legal determinations are deferred, not
assessed.

## 17. Remaining risks

- **Environment-adjusted integration validation** (alternate DB port) — the pass
  is genuine but not on the default port; CI validates the default path.
- **Advisory-database dependence** of `pnpm audit` results at audit time.
- **Single-auditor pass** — no independent second reviewer; external review is a
  launch gate, not a completed step.
- **Structural (not empirical) infra/reliability findings** — assessed from the
  repository, not a running system.

## 18. Readiness for the next sprint

Sprint 14 is complete. Orgistry is in state **C — Ready to begin production
implementation**. The approved next sprint is **Sprint 15 — Production
Configuration and Secret Safety**. The audit output is specific enough that
Sprint 15's spec is already written (§12 / roadmap) and future sprint specs can
be generated directly from the roadmap and findings register without repeating
the repository-wide audit. Sprint 15 has zero dependencies and can start
immediately.

## 19. Sprint iteration changelog

Records the actual work performed (one substantive pass with internal refinement,
not fabricated iterations):

1. **Initial audit pass** — repository census; seven parallel domain
   investigations + documentation reconciliation; required validation commands
   executed and recorded.
2. **Evidence reconciliation** — cross-checked overlapping claims across domains
   (fail-open limits, secrets, retention, quota races, trustProxy); independently
   re-verified the config-guard, external-API pre-auth write, and proxy/header
   claims underpinning P1/P2 findings.
3. **Severity refinement** — calibrated severities to exploitability, target
   profile, and dependency position; confirmed no P0 on a risk basis (no active
   compromise, no exposed production secret, no data-loss event, no immediately
   exploitable critical flaw); held the recovery/infra/backup items at P1 as
   launch blockers, per the blocker-semantics rule.
4. **Roadmap refinement** — derived phases and the single next sprint from the
   register (findings-first), mapped every P1/P2 to a sprint and checklist item,
   and identified the critical path, parallel tracks, and decision/legal/security
   gates.
5. **Final consistency review** — reconciled all `ORG-PR-###` IDs, severities,
   and titles across every document; verified roadmap and launch-checklist
   references resolve; corrected the finding-count total to 6 P1 / 22 P2 / 17 P3 /
   9 P4; confirmed the final Git diff is documentation-only.
6. **Validation-integrity & consistency refinement** — re-ran all
   required commands capturing true exit codes without pipeline masking (revealing
   `pnpm audit` exits **1**, not 0); recorded exact test totals and env overrides;
   corrected the readiness state from B to **C** with justification; reworded the
   P0 rationale to a risk basis; converted the standards matrix to an explicit
   repository-evidence mapping (removed unverified exact control identifiers);
   tightened production-target fact-vs-assumption boundaries; refined the next
   sprint to **Sprint 15 — Production Configuration and Secret Safety**; added a
   repository-coverage reconciliation table; and validated every Markdown link,
   anchor, and `ORG-PR-###` reference. Also corrected the ORG-PR-046 sub-claim: the
   real unit-test count is **489** (matching `docs/evaluation-guide.md`), so that
   count is accurate, not drifting.
7. **Final closure verification (this pass)** — re-verified all 12 artifacts
   exist and are indexed; re-confirmed the finding totals (54 = 6 P1 / 22 P2 /
   17 P3 / 9 P4) with summary-vs-detail severity agreement; re-validated every
   Markdown link, anchor, and `ORG-PR-###` reference; unified the Sprint 15
   title to the exact form "Sprint 15 — Production Configuration and Secret
   Safety" in the roadmap heading; and expanded this package's documentation
   index with per-document authority, audience, and register relationships. No
   audit content, severity, state, or recommendation was changed.

## Final readiness decision

**State: C — Ready to begin production implementation.**

- **Why C is selected:** the audit package is complete, the roadmap is actionable,
  exactly one next implementation sprint is defined, and no unresolved audit or
  decision prerequisite prevents starting it — Sprint 15 has zero dependencies and
  can begin immediately. The implemented surface is type-checked, linted, and
  unit-/integration-tested with correct tenant isolation, permission-first
  authorization, and hash-only credentials, giving the production program a sound
  foundation to build on. C means exactly this: the audit and roadmap are
  sufficient to begin closing the launch blockers.
- **What C explicitly does not mean:** C is **not** ready for staging (D) or
  production (E), and it does **not** override the six P1 launch blockers
  (ORG-PR-001, 002, 003, 004, 005, 006). It means implementation can start, not
  that the system may serve real users or data.
- **Why D/E are not justified:** the six P1 blockers mean the system cannot be
  deployed, cannot send production email, can boot with unsafe secrets, cannot
  recover accounts, and cannot be backed up or restored. D additionally requires a
  provisioned staging environment, the launch-blocking P2s, and a passing restore
  drill — none of which exist. E requires the full launch gate including an
  external security review. Passing validation commands is explicitly not
  sufficient for D/E.
- **Why not B:** B would be correct only if a concrete unresolved audit or
  decision prerequisite blocked the start of production implementation. None does
  — the roadmap, findings register, and a dependency-free next sprint are all in
  place — so the higher state C is justified and B is not retained.
- **Why not A:** the project is not merely a portfolio/reference artifact; it is a
  coherent, well-tested foundation ready to enter a defined production program.
- **Findings that must close before advancing past C (to D/E):** ORG-PR-001, 002,
  003, 004, 005, 006 (P1), then the launch-blocking P2s and the mandatory restore
  drill; E additionally requires the external security review.
- **Confidence in the decision:** High.
