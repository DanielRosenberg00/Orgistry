# Orgistry Production Readiness Audit (Sprint 14)

This directory is the authoritative production-readiness assessment for Orgistry.
It establishes the repository's real current state, records evidence-backed
production gaps, classifies their severity, and defines a dependency-ordered
roadmap from the current portfolio-grade state to a production launch.

This is an **audit and planning** deliverable. No production code was changed and
no production fixes were implemented during the Sprint 14 audit itself (see
[Limitations](#limitations)).

> **Post-audit status (Sprint 15, 2026-07-18): Sprint 15 is COMPLETE.**
> ORG-PR-003 and ORG-PR-047 are closed (production config guard +
> `COOKIE_SECRET` removal — see
> [docs/production-config-guard.md](../production-config-guard.md)), and
> **DG-1, DG-2, and DG-5 were ratified by the Project Owner on 2026-07-18**;
> DG-3/DG-4 remain open as permitted
> ([sprint-15-decisions.md](sprint-15-decisions.md),
> [sprint-15-artifact-package.md](sprint-15-artifact-package.md)).
>
> **Post-audit status (Sprint 16, 2026-07-18): Sprint 16 is COMPLETE** in its
> repository scope. ORG-PR-024 and ORG-PR-048 are closed (full
> email-verification lifecycle, tested); ORG-PR-002 is **materially advanced
> but still open** — the production-shaped SMTPS adapter and fail-closed mail
> config exist, but external-provider delivery has not been validated (no
> credentials available). See
> [docs/email-and-verification.md](../email-and-verification.md) and
> [sprint-16-artifact-package.md](sprint-16-artifact-package.md). Five P1
> blockers remain open (ORG-PR-001/002/004/005/006); the repository is still
> **not ready for staging or production** — sprint completion is not launch
> clearance.
>
> **Post-audit status (Sprint 17, 2026-07-20): Sprint 17 is COMPLETE** in its
> repository scope. ORG-PR-004 and ORG-PR-039 are closed (password recovery
> with full session/refresh revocation; current-password-gated password and
> email change; lifecycle-tested incl. the concurrent reset-completion race);
> ORG-PR-030 is **materially advanced but still open** (registration
> duplicate-email 409 is throttled per email digest and recorded as a probe
> event, but remains distinguishable — full closure needs a
> verification-first registration redesign). See
> [docs/credential-management.md](../credential-management.md) and
> [sprint-17-artifact-package.md](sprint-17-artifact-package.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006); the repository is still
> **not ready for staging or production**. Because ORG-PR-030 stays open, the
> recommended next work is a **focused account-lifecycle follow-up that
> closes ORG-PR-030** (verification-first registration) **before Sprint 18 —
> Edge and Application Security Hardening**.
>
> **Post-audit status (Sprint 18, 2026-07-20): Sprint 18 is COMPLETE** in its
> repository scope. **ORG-PR-030 is closed**: public registration is now
> verification-first — the request endpoint answers one contract-identical
> generic acceptance for every post-validation account state (no
> duplicate-email error, no authentication state, no account creation), and
> accounts are created only by the emailed single-use completion token
> (created email-verified, with the personal workspace, Owner membership,
> session, and refresh token in one transaction). Invitation-based
> registration is preserved under the same model, with a documented
> completion-time invitation-unavailable policy. Closure is proven by a
> public response-equality test matrix plus DB-backed issuance- and
> completion-concurrency tests; a residual timing side channel is documented
> and accepted (see the finding's Resolution). See
> [docs/auth-foundation.md](../auth-foundation.md) and
> [sprint-18-artifact-package.md](sprint-18-artifact-package.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006); the repository is still
> **not ready for staging or production**. Recommended next: **Sprint 19 —
> Edge and Application Security Hardening** (the roadmap's edge-hardening
> sprint, renumbered after this inserted account-lifecycle sprint).
> A **refinement pass (2026-07-21)** corrected the remaining Sprint 18
> invitation contract — private invitation-validation failures on public
> registration now return the same generic acceptance (proven by a ten-row
> equality matrix) instead of explicit `INVITATION_*` errors — added the
> web-demo invitation landing/registration flow, and runtime-validated the
> demo seed. See the refinement record in
> [sprint-18-artifact-package.md](sprint-18-artifact-package.md) and the
> ORG-PR-030 refinement note in the findings register.
>
> **Post-audit status (Sprint 19, 2026-07-21): Sprint 19 is COMPLETE** in its
> repository scope — the edge and application security hardening sprint.
> Seven findings are closed: ORG-PR-010 (typed `TRUST_PROXY`; forwarded
> headers ignored unless explicitly trusted), ORG-PR-011 (security headers on
> every response, HSTS `includeSubDomains` only under `NODE_ENV=production`;
> the SPA CSP remains ORG-PR-035), ORG-PR-012 (global per-trusted-IP rate
> limit plus `invitations/inspect` throttled per IP and per token-derived
> digest), ORG-PR-013 (durable failed-auth `security_events` writes bounded
> per source IP), ORG-PR-032 (per-actor throttling of spammable authenticated
> mutations), ORG-PR-033 (centralized pino logger redaction), and ORG-PR-052
> (inbound request-id sanitization, coarse production `/ready`, bounded
> idempotent shutdown). ORG-PR-009 is **materially advanced but still open**
> — sensitive rate-limit buckets fail closed under the production-default
> `RATE_LIMIT_FAILURE_MODE=closed`, but the finding's alerting half depends
> on ORG-PR-007 (observability). `pnpm validate` and `pnpm validate:integration`
> exit 0 (2026-07-21). See
> [sprint-19-artifact-package.md](sprint-19-artifact-package.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006); the repository is still
> **not ready for staging or production** — the state remains
> **C — Ready to continue production implementation**.
>
> **Post-audit status (Sprint 20, 2026-07-21): Sprint 20 is COMPLETE** in its
> repository scope — authorization and concurrency correctness. Six findings
> are closed: ORG-PR-017 (ratified DG-2 Owner-transition policy enforced
> in-transaction against the locked active-owner set — an Admin can no longer
> grant or remove Owner), ORG-PR-029 (every quota-protected creation
> serializes its ENTIRE quota decision — the current plan ceiling resolved
> through the same transaction via a FOR SHARE plan-row snapshot, the count,
> the comparison, and the insert — under a per-organization, per-quota-kind
> advisory lock; projects, API keys, invitation seat reservation, and every
> member-capacity path including distinct-token acceptance and invited
> registration completion; repository contracts carry no pre-resolved
> ceilings), ORG-PR-044 (five
> real-PostgreSQL concurrency races that fail deterministically if the lock
> is removed), ORG-PR-038 (AT MOST one active personal workspace per user is DB-enforced
> by partial unique index; the provisioning transaction — tested — creates
> the one each user has), ORG-PR-053 (org read enforces
> `org.read`; effective-permissions is the one documented membership-only
> exception), and ORG-PR-014 (composite `(organization_id, created_at, id)`
> index backing the audit read path). ORG-PR-015 (retention) remains open —
> Sprint 20 documents retention readiness only; documentation and indexes are
> not enforcement. `pnpm validate` and `pnpm validate:integration` exit 0
> (2026-07-21). See
> [sprint-20-artifact-package.md](sprint-20-artifact-package.md) and
> [sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006); the repository is still
> **not ready for staging or production** — the state remains
> **C — Ready to continue production implementation**. Recommended next:
> **Sprint 21 — Supply Chain and CI Hardening**.
>
> **Post-audit status (Sprint 21, 2026-07-26): Sprint 21 repository
> implementation is complete** — supply-chain and CI hardening. The
> distinction matters: the code, workflows, and configuration are done and
> locally validated, but the new scanners' *enforcement* is not yet proven,
> because they have never executed on GitHub-hosted CI. Four findings closed:
> ORG-PR-018 (`drizzle-orm` 0.45.2, the advisory fix release, validated
> against live PostgreSQL incl. the ≥0.44 `DrizzleQueryError` guard
> adaptation), ORG-PR-054 (all vulnerable `esbuild` copies eliminated),
> ORG-PR-019 (every workflow action full-SHA pinned; explicit least-privilege
> `permissions:` on all three workflows; `concurrency`; Dependabot pin
> updates), and ORG-PR-040 (`noUncheckedIndexedAccess` ON for every project;
> 297 errors fixed with zero suppressions). Two findings open, materially
> advanced: **ORG-PR-020 remains open pending first remote CI execution and
> negative-path enforcement evidence** (pnpm audit gates + Gitleaks + CodeQL
> + Dependabot are configured and locally validated where a local equivalent
> exists) and ORG-PR-042 (exact patch tags everywhere; digest pinning
> deferred to the ORG-PR-001 artifact track). Two dependency advisories accepted with documented
> reachability analyses (react-router RSC-only CSRF; brace-expansion
> dev-only DoS). `pnpm validate` and `pnpm validate:integration` exit 0
> (2026-07-26). See
> [sprint-21-artifact-package.md](sprint-21-artifact-package.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006, plus ORG-PR-015); the
> repository is still **not ready for staging or production** — the state
> remains **C — Ready to continue production implementation**. Recommended
> next: **Sprint 22 — Deployable artifact & pipeline** (Phase 4).
>
> **Post-audit status (Sprint 22, 2026-07-26): CodeQL alert triage and CI gate
> closure — complete.** Sprint 21 shipped scanners; Sprint 22 turned them into
> a control. All **41** High alerts from CodeQL's first operational run were
> individually triaged with source/sink evidence and given individual GitHub
> dispositions: **3 fixed defects**, 13 covered by endpoint-specific controls
> the query cannot model, 19 covered by the global limiter, 6 false positives
> (framework-model + high-entropy-token), **0 accepted risks**. Zero alerts
> were bulk-dismissed and zero true positives were left unresolved — see
> [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md).
> **ORG-PR-020 is CLOSED**: all three workflows ran green remotely on
> `c33a150f`; a temporary branch proved the Gitleaks job actually *fails* on a
> seeded synthetic secret (run 30207672121 — branch deleted, never merged);
> and a `main` ruleset now makes the CI, Security, and CodeQL checks required,
> so a scanner failure blocks the merge instead of merely being visible. The
> triage opened two findings of its own: **ORG-PR-055** (the audit-log read
> scanned an entire tenant's event history on an un-indexed `targetId` filter
> — now bounded by per-user and per-organization buckets; the scan cost itself
> stays open) and **ORG-PR-056** (the demo bootstrap's one-time secret print
> — first mitigated with a loopback-target guard, then fully remediated by
> removing API-key creation from the bootstrap entirely, so it now prints no
> credential of any kind). `pnpm validate` and
> `pnpm validate:integration` exit 0 (2026-07-26). See
> [sprint-22-artifact-package.md](sprint-22-artifact-package.md). Four P1
> blockers remain open (ORG-PR-001/002/005/006); the repository is still
> **not ready for staging or production** — the state remains
> **C — Ready to continue production implementation**. Recommended next:
> **Sprint 23 — Deployable artifact & pipeline** (Phase 4).

> **Sprint 23 update (2026-08-23) — deployable artifact. COMPLETE — Sprint
> 23 DoD MET:** merged as PR #28 (7/7 checks successful, implementation
> commit `37a586c`); post-merge `main` (`6019db8`) workflows all green (CI
> 32650121796, Security 32650121899, CodeQL 32650121792); and
> `Artifacts (build + smoke)` is registered as a required check in ruleset
> 19769611 (API-verified — the artifact gate is branch-enforced).
> Implemented: production-shaped
> non-root container artifacts for the API (esbuild bundle of the existing
> `server.ts`/`migrate.ts` entrypoints + lockfile-exact hoisted production
> node_modules on `node:22.23.2-bookworm-slim`) and the web demo (Vite build
> on nginx-unprivileged with SPA fallback); an explicit one-shot migration
> entrypoint (`node dist/migrate.mjs` — migrations never run at API boot); a
> production-like compose validation reference
> (`infra/compose.production-like.yml`, fake guard-passing config only); and
> a deterministic smoke gate (`tooling/artifact-smoke.sh`, the CI
> `artifacts` job — green locally, on PR #28, and on `main`) proving
> production-mode boot,
> health/readiness (incl. fail-closed on a
> Redis stop), non-root UIDs, read-only application tree, artifact hygiene,
> secret absence from logs and web assets, config-guard rejection of dev
> secrets, and exit-0 SIGTERM shutdown — all from the packaged artifacts.
> **ORG-PR-042 is CLOSED** (every active image reference pinned exact patch
> tag + manifest-list digest). **ORG-PR-001 remains open, materially
> advanced** (no deployment environment, pipeline, or registry publishing);
> **ORG-PR-006 remains open** (runtime injection boundary enforced; no
> secrets manager, no rotation). `pnpm validate`, `pnpm validate:integration`,
> and `pnpm artifact:smoke` exit 0 (2026-08-23). See
> [sprint-23-artifact-package.md](sprint-23-artifact-package.md) (final
> closing artifact) and
> [../deployment-artifacts.md](../deployment-artifacts.md). Four P1 blockers
> remain open (ORG-PR-001/002/005/006); the repository is still **not ready
> for staging or production** — the state remains **C — Ready to continue
> production implementation**. Sprint 23 remote closure succeeded, so the
> gateway condition is met — recommended next: **Sprint 24 — Runtime
> Secrets and External Email Validation** (binding Sprint 23 specification;
> ORG-PR-002, ORG-PR-006).

## Audit context

- **Execution date:** 2026-07-02
- **Repository revision audited:** `d0b2f97` (`main`), tree clean at audit start.
- **Auditor role:** Staff Engineer / Production Readiness Auditor / Security &
  Reliability Reviewer / Principal Technical Writer (single execution).
- **Method:** whole-repository census, seven parallel domain investigations
  reading source (not documentation) as the source of truth, self-verification of
  load-bearing claims, then synthesis. See [Audit Method](#audit-method).

## Navigation index

| Document | Purpose |
| --- | --- |
| [production-target.md](production-target.md) | The production profile readiness is assessed against; assumptions and decision gates. |
| [repository-inventory.md](repository-inventory.md) | Complete inventory of apps, packages, routes, tables, migrations, config, scripts, CI, tests, docs, with maturity classification. |
| [product-gap-analysis.md](product-gap-analysis.md) | Original v1 capability matrix vs. actual status; frontend page classification. |
| [security-assessment.md](security-assessment.md) | Cross-domain security posture with references into the findings register. |
| [threat-model.md](threat-model.md) | Orgistry-specific assets, trust boundaries, threats, controls, residual risk. |
| [standards-matrix.md](standards-matrix.md) | ASVS / SSDF / SAMM / SLSA practice-level mappings with limitations. |
| **[findings-register.md](findings-register.md)** | **Authoritative source for all findings (`ORG-PR-NNN`).** |
| [production-scorecard.md](production-scorecard.md) | Domain maturity, blocker status, largest gap, confidence. |
| [production-roadmap.md](production-roadmap.md) | Sequenced phases, critical path, decision gates, the one recommended next sprint, launch gate. |
| [launch-checklist.md](launch-checklist.md) | Five-stage checklist with finding/roadmap traceability. |
| [sprint-14-artifact-package.md](sprint-14-artifact-package.md) | The official Sprint 14 closing artifact. |
| [sprint-15-decisions.md](sprint-15-decisions.md) | Decision-gate record (DG-1…DG-5) as of Sprint 15. |
| [sprint-15-artifact-package.md](sprint-15-artifact-package.md) | The Sprint 15 closing artifact (production config guard). |
| [sprint-16-artifact-package.md](sprint-16-artifact-package.md) | The Sprint 16 closing artifact (production email + email verification). |
| [sprint-17-artifact-package.md](sprint-17-artifact-package.md) | The Sprint 17 closing artifact (password recovery + credential management). |
| [sprint-18-artifact-package.md](sprint-18-artifact-package.md) | The Sprint 18 closing artifact (verification-first registration; ORG-PR-030 closure). |
| [sprint-19-artifact-package.md](sprint-19-artifact-package.md) | The Sprint 19 closing artifact (edge and application security hardening). |
| [sprint-20-artifact-package.md](sprint-20-artifact-package.md) | The Sprint 20 closing artifact (authorization and concurrency correctness). |
| [sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md) | The Sprint 20 quota-race map: per-path pre-change state, serialization primitive, lock order. |
| [sprint-21-artifact-package.md](sprint-21-artifact-package.md) | The Sprint 21 closing artifact (supply-chain & CI hardening: pinning, scanners, advisory remediation, `noUncheckedIndexedAccess`). |
| [sprint-22-artifact-package.md](sprint-22-artifact-package.md) | The Sprint 22 closing artifact (CodeQL alert triage, gate policy + ruleset enforcement, ORG-PR-020 closure). |
| [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md) | Per-alert triage of all 41 baseline CodeQL High alerts: evidence, root-cause groups, classifications, dispositions. |
| [sprint-23-artifact-package.md](sprint-23-artifact-package.md) | The Sprint 23 closing artifact (deployable API/web artifacts, migration entrypoint, smoke gate, image policy; ORG-PR-042 closure). |

## Source-of-truth hierarchy

1. **Repository source code and migrations** — the ultimate authority. Where docs
   and code disagree, code wins and the disagreement is recorded as a finding.
2. **[findings-register.md](findings-register.md)** — authoritative for every
   finding's ID, title, severity, classification, and evidence. All other
   documents in this package reference it and must not restate a different
   severity or title.
3. This package's other documents — derived views over the register.
4. Pre-existing repository docs (`docs/*.md`) — treated as claims to reconcile,
   not as authority. Stale or contradictory docs are recorded as findings
   (see [ORG-PR-046](findings-register.md#org-pr-046)), not silently rewritten.

## Evidence conventions

Every material claim cites concrete evidence in the form
`path — symbol (approx line)`, a route `METHOD /path`, a table/constraint/index
name, a test name, a CI job, or a config key. Line numbers are approximate and
paired with a stable symbol name so they survive minor drift. Absence claims
state what was searched (command/pattern), where, and what related code does
exist — never a bare "X does not exist."

Content is separated into: **verified fact**, **evidence-backed inference**,
**explicit assumption**, **unknown**, and **externally unverifiable item**.
Assumptions and unknowns are labeled inline and consolidated per document.

## Finding severity conventions

| Severity | Meaning |
| --- | --- |
| **P0** | Immediate critical risk (actively exploitable now). |
| **P1** | Production launch blocker. |
| **P2** | Required shortly before or after launch. |
| **P3** | Hardening / maturity improvement. |
| **P4** | Optional enhancement. |

**Blocker semantics (overriding rule):** *Any unresolved P0 or P1 prevents a
production-ready result regardless of the maturity of other domains.* Severity
reflects exploitability, impact, target profile, and dependency position — not
"is it a missing feature." Not every missing feature is P1, and P1 severity is
**not** reduced merely because the project is not yet serving production traffic.

Classifications used: Production blocker · Security risk · Reliability risk ·
Data-integrity risk · Operational gap · Product completeness gap · Compliance
dependency · Maintainability issue · Developer-experience issue · Optional
enhancement · Not applicable.

## Audit method

1. **Baseline & census** — recorded Git state, enumerated all 338 tracked files,
   read the root README, `package.json`, CI, Compose, and `.env.example`.
2. **Production target** — selected a profile from repository evidence
   ([production-target.md](production-target.md)).
3. **Domain investigation** — seven parallel read-only investigations covering
   auth/crypto, authorization/tenancy/concurrency, invitations/API-keys/audit,
   database/migrations, API platform/contracts, web-demo frontend, and
   testing/CI/supply-chain, plus a documentation-reconciliation pass.
4. **Validation** — ran the required commands and recorded exact outcomes
   ([Validation evidence](sprint-14-artifact-package.md#7-validation-evidence)).
5. **Self-verification** — independently re-checked the config-guard, external-API
   pre-auth write, and proxy/header claims that P1/P2 findings depend on.
6. **Synthesis** — one findings register, then scorecard, roadmap, and checklist
   derived from it, then a cross-document consistency pass.

## Limitations

- **Single audit pass** by one auditor; no independent second reviewer. An
  external security review remains required before launch
  ([ORG-PR-018](findings-register.md#org-pr-018), standards-matrix).
- **No production environment exists**, so all deployment, backup, scaling, and
  observability findings are assessed structurally from the repository, not from
  a running system.
- **Integration validation** ran against a throwaway alternate-port PostgreSQL
  because host port 5432 is occupied by an unrelated database on the audit
  machine; this is an environment limitation, not a repository defect.
- **`pnpm audit`** results depend on the advisory database reachable at audit
  time; they are reported verbatim, not independently triaged for exploitability.
- Legal/compliance determinations are marked **Legal review required** and are
  not resolved here.

## Document relationships

`findings-register.md` is the hub. `product-gap-analysis.md`,
`security-assessment.md`, `threat-model.md`, and `standards-matrix.md` each view
the findings through one lens and link back by ID. `production-scorecard.md`,
`production-roadmap.md`, and `launch-checklist.md` are derived *from* the register
(findings first, then sequencing — not the reverse). `sprint-14-artifact-package.md`
summarizes the whole and is the closing record.
