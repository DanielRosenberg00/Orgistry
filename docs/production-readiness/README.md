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
>
> **Sprint 24 status (2026-08-23) — runtime secrets and external email
> validation. COMPLETE — Sprint 24 DoD MET.** All required remote checks are
> green for implementation commit `de6780f` on PR #33: CI `32663739832`,
> CodeQL `32663739811`, Security scans `32663739952` (7/7 checks pass).
> Implemented: a single runtime secret-source boundary
> (`packages/config/src/secret-source.ts`) giving `DATABASE_URL`, `REDIS_URL`,
> `JWT_SECRET`, `JWT_PREVIOUS_SECRET`, `SMTP_USERNAME`, and `SMTP_PASSWORD` an
> optional mounted-file source (`<NAME>_FILE`) alongside the direct environment
> value, with deterministic semantics (both-set fails closed; one terminal line
> ending stripped; empty, missing, directory, and unreadable files rejected
> without ever echoing contents); resolution ordered **before** schema
> validation and normalized onto the canonical variable name, so a file-backed
> secret receives byte-identical production validation and **cannot bypass a
> production guard** (test-proven, and re-proven against the packaged
> artifact); graceful access-token key rotation via an optional
> `JWT_PREVIOUS_SECRET` accepted at verification only (signing stays
> current-key-only, the two keys must differ, both are held to the production
> strength rules, an unrelated older key is rejected, expiry and authorization
> semantics are unchanged, and removing the previous key completes the cutover
> — proven at both the primitive and HTTP-route level); credential-redaction
> proofs across startup, config-validation, secret-file, SMTP-failure, and
> 401-envelope paths; six artifact-smoke checks covering the mounted-secret
> path with temporary files the harness creates and deletes; and two
> operational documents (`../runtime-secrets.md`, `../rotation-runbook.md`).
> Verified rather than assumed: **there is no refresh/session signing secret**
> — refresh tokens are opaque, unsigned, hash-only, and the cookie is
> deliberately unsigned — so rotating `JWT_SECRET` logs nobody out and sessions
> can only be invalidated in the database (no platform-wide API exists).
> Two remote runs failed first, each on a **Linux-only portability defect in a
> validation fixture** — never in the application, and neither fixed by
> weakening the production security model; the chain (`74f50e4` →`486bee8` →
> `de6780f`) is preserved in the artifact as evidence that CI worked.
> **No finding was closed, which is the specification-permitted outcome, not a
> sprint failure. ORG-PR-002 remains OPEN — materially advanced**: every
> repository-side prerequisite within Sprint 24's scope is done; the blocker is
> external provider, domain, and mailbox access, so no provider-acceptance,
> inbox-receipt, or SPF/DKIM/DMARC evidence exists and none is claimed —
> **Orgistry has no evidence that production email works**. **ORG-PR-006
> remains OPEN — materially advanced, with a genuine remaining capability
> gap**: runtime sources, rotation mechanics, and runbooks exist, but a secrets
> manager or platform secret store, least-privilege secret access control,
> secret-access auditability, automated rotation and expiry tracking, hot
> reload, and a rehearsed rotation against a real runtime (which needs
> ORG-PR-001's environment) are all still unbuilt; `<NAME>_FILE` support plus
> manual runbooks is a foundation, not secrets management. `pnpm validate`,
> `pnpm validate:integration`, `pnpm scan:deps`, `pnpm scan:deps:local`,
> `pnpm scan:secrets`, `actionlint`, and `tooling/artifact-smoke.sh` all pass
> locally on the validated tree. See
> [sprint-24-artifact-package.md](sprint-24-artifact-package.md) — the official
> Sprint 24 closing artifact; its DoD reconciliation records **34 PASS / 2
> satisfied by explicit external blocker / 0 pending / 0 fail-missing**.
> Four P1 blockers remain open (ORG-PR-001/002/005/006, plus ORG-PR-015 at P2);
> the repository is still **not ready for staging or production** — the state
> remains **C — Ready to continue production implementation**. Recommended
> next: **Sprint 25 — Backup, PITR, Restore, and Retention Foundation**
> (ORG-PR-005, with retention groundwork under ORG-PR-015). ORG-PR-002's
> external-email validation and ORG-PR-006's residual secrets-management
> capability remain outstanding workstreams alongside it, not inside it.
>
> **Sprint 25 status (2026-08-24) — backup, PITR, restore, and retention
> foundation. COMPLETE — Sprint 25 DoD MET.** Merged to `main` as PR
> [#34](https://github.com/DanielRosenberg00/Orgistry/pull/34) (merge commit
> `b267f70`, implementation commits `e7d5710` + `e55c5a8`) with all seven PR
> checks green — CI Validate/Integration/Artifacts
> ([32702593281](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702593281)),
> Security scans dependency audit + Gitleaks
> ([32702593268](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702593268)),
> CodeQL analyze
> ([32702593273](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702593273))
> and the CodeQL PR **security gate**
> ([97357238278](https://github.com/DanielRosenberg00/Orgistry/runs/97357238278)) —
> and the merged state of `main` independently re-validated green. The
> `Data durability` PITR workflow was then dispatched against `main` and
> **passed** ([32702918307](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702918307),
> job `97357955641`, 42 s), so PITR is verified locally **and** on GitHub
> Actions. Note for the record: the FIRST remote run failed on the CodeQL
> security gate (a test-side duplicate SHA-256 flow over an API-key fixture);
> it was corrected in `e55c5a8` by removing the redundant crypto — no
> suppression, no change to API-key or password hashing. Implemented: a persistent-data inventory
> establishing PostgreSQL as the sole durability boundary (Redis holds only
> TTL-bounded rate-limit counters; no object storage or upload path exists);
> a repeatable logical backup (`tooling/db-backup.sh`) producing a
> `pg_dump -Fc` artifact plus a SHA-256 sidecar and provenance metadata, with
> every PostgreSQL client tool run from the repository's own pinned image so
> client and server can never drift; a restore drill
> (`tooling/db-restore-drill.sh`) that exercises the real backup path,
> verifies the checksum, proves a truncated artifact is rejected, restores
> into a genuinely empty target, asserts schema/migration-ledger/entity/
> relational/API-key-hash survival, and requires re-running migrations against
> the restored database to be a no-op; an `--with-artifact` mode completing
> the recovery contract through the packaged API image to `/health`, `/ready`,
> and an **API-key-authenticated read of restored data**; and — the load-bearing
> result — **PITR VERIFIED** by `tooling/db-pitr-drill.sh`: base backup plus
> demonstrably-working WAL archiving plus `recovery_target_time`, with
> pre-target rows that exist only in archived WAL recovered, post-target
> `DELETE`/`DROP TABLE` damage undone, archived-WAL consumption asserted from
> the recovery log, and the schema left intact. Retention (ORG-PR-015) shipped
> as a six-category policy catalog, a dry-run-by-default one-shot cleanup
> command runnable from source AND from the deployable artifact, hard-floored
> typed configuration, four additive cleanup indexes (migration `0012`), and
> 54 retention tests including 21 against live PostgreSQL (plus 7 drill-fixture
> drift tests). `invitations` and `api_keys`
> are deliberately excluded from cleanup on their own schema contracts.
> **ORG-PR-015 is CLOSED** (policy + runnable enforcement + tested safety;
> scheduling remains under ORG-PR-016). **ORG-PR-005 remains OPEN — materially
> advanced**: the repository-controlled half is complete and verified, but
> nothing schedules a backup, no backup is stored remotely or encrypted, no
> long-lived database archives WAL, no provider-managed PITR exists, and no
> RPO/RTO has been measured — all dependent on ORG-PR-001. ORG-PR-001,
> ORG-PR-002, and ORG-PR-006 were explicitly out of scope and are untouched.
> See [sprint-25-artifact-package.md](sprint-25-artifact-package.md),
> [../backup-and-restore.md](../backup-and-restore.md),
> [../pitr.md](../pitr.md), and [../retention.md](../retention.md).
> Four P1 blockers remain open (ORG-PR-001/002/005/006). Sprint 25's own
> Definition of Done is MET and remote repository validation is complete;
> neither is launch clearance, and the binding readiness classification is
> unchanged:
>
> ```
> C — Ready to continue production implementation
> Not ready for staging
> Not ready for production
> ```
>
> **Sprint 26 status (2026-08-24) — production deployment environment and
> promotion pipeline. COMPLETE in its repository scope; NO FINDING CLOSED,
> which is the specification-permitted outcome for a sprint whose closure
> criteria depend on infrastructure that does not exist.** Not yet merged and
> not yet validated remotely at the time of writing.
> **Deployment target decision:** single-host Docker Compose, operator-executed,
> promoted by immutable image digest — following the ratified self-hosted
> profile ([production-target.md](production-target.md)), explicitly not
> Kubernetes. Kubernetes, a managed container platform, and an SSH-from-CI
> deploy job were considered and rejected with recorded reasons.
> Implemented: a gated GHCR release workflow that runs the artifact smoke gate
> itself and then publishes the images that gate produced under an immutable
> commit-SHA tag, capturing their registry digests (the API image is re-tagged,
> never rebuilt); a schema-validated **release manifest** whose migration head,
> count, and journal timestamp are DERIVED from the repository rather than
> supplied, and which is refused if it carries anything credential-shaped; a
> **build-once/promote-by-digest** contract enforced at four independent points
> (manifest schema, a digest assertion in the deployment, a deployment topology
> with no `build:` section anywhere, and a running-container image-ID check
> after startup); `infra/compose.deploy.yml` plus a two-file deployment
> configuration contract that keeps every secret in a 0600 operator file the
> deployment refuses to read if it is group-readable; `tooling/deploy.sh`, a
> thirteen-stage executor performing a labelled pre-migration backup and
> recording its recovery point, running migrations **exactly once** from the
> release's own image, verifying the applied migration head against the release
> through Drizzle's ledger, deploying API then web, waiting for readiness,
> proving the running containers are the released digests, and running smoke;
> `tooling/deploy-smoke.sh`, eight URL-only checks including coarse-readiness
> disclosure, the six-header security baseline, request-ID propagation, and
> reading the API origin back out of the SERVED web bundle; an append-only
> **deployment evidence ledger** that records failed deployments too, cannot
> claim a validated deployment without observed runtime digests, and keeps a
> copy of every deployed release manifest on the host; and
> `tooling/deploy-rollback.sh`, which restores the previous known-good digests
> — smoke passed, not currently deployed, and **not already rolled away from**,
> the rule that stops a rollback restoring the release the last rollback was
> escaping. `pnpm deploy:rehearsal` executes the entire lifecycle locally
> against a throwaway registry and throwaway services and **PASSES**, including
> a real rollback and three proven refusals (a tag-pinned manifest, a web image
> built for another API origin, and a group-readable runtime configuration
> file). 29 new unit tests pin the manifest and evidence contracts inside the
> required `Validate (offline)` check.
> Two latent defects in Sprint 25 tooling were found by the rehearsal and fixed
> (a backup of a database with no migration ledger — the first-deployment case
> — and `pg_start_server` under `set -u` on bash 3.2); all three durability
> drills were re-run locally afterwards and pass.
> **ORG-PR-001 remains OPEN — materially advanced for the second time.** Its
> closure criterion is "a tagged build deploys to a target environment
> reproducibly", and **no target environment exists**: no host, no provider
> account, no deployment credential, no GitHub Environment. The release
> workflow has never run, so **no Orgistry image has been published to any
> registry**; `Release`, `Deploy`, and `Deployment rehearsal` have never
> executed on GitHub Actions; and rollback is validated only in the local
> rehearsal. **ORG-PR-005 and ORG-PR-006 gained an integration boundary and a
> handling boundary respectively and are NOT closer to closure** — deployment-
> time backup integration is not a backup programme, and enforced secret
> handling is not secrets management. **ORG-PR-002 was out of scope and is
> untouched.** Deployment mechanics implemented, deployment target validated,
> staging readiness, and production readiness are four different things, and
> only the first is claimed. Four P1 blockers remain open (ORG-PR-001, 002,
> 005, 006); the binding readiness classification is unchanged:
>
> ```
> C — Ready to continue production implementation
> Not ready for staging
> Not ready for production
> ```
>
> **Refinement pass (same day).** A review found three release-integrity
> defects; all three are fixed, and **no finding status or readiness
> classification changed**. (1) The web image was environment-specific because
> `VITE_API_BASE_URL` was compiled into the bundle, so one validated web digest
> could not be promoted between environments — a contradiction of the sprint's
> own build-once invariant. The browser's public configuration now arrives at
> RUNTIME from container variables, `images.web.apiBaseUrl` is deleted from the
> manifest schema, and the schema refuses any deployment configuration on an
> image identity; promotability is proven by unit tests, by the artifact smoke
> test running ONE image as two API origins, and by the rehearsal promoting one
> release between two configurations with the running digests asserted
> unchanged. (2) A dirty-tree rehearsal could describe its images with a clean
> HEAD SHA behind only a printed warning; manifests now declare
> `release.type` and `source.provenance`, a dirty tree yields `working-tree`
> provenance with a content fingerprint and can never be deployable, a rehearsal
> never carries gate evidence, and a real environment refuses a non-deployable
> manifest. (3) Publication was not tied to the required checks for the release
> SHA; a dedicated `gates` job now proves all six required checks concluded
> `success` for the exact commit at job granularity, records their run IDs in the
> manifest, and treats a missing run as pending rather than a silent pass.
> Local validation was re-run in full and passes (1013 unit tests, 94 web tests,
> the artifact smoke gate, all three durability drills, and the rehearsal).
>
> See [sprint-26-artifact-package.md](sprint-26-artifact-package.md) and
> [../deployment.md](../deployment.md). Recommended next: **Deployment Pipeline
> Closure** — provision the smallest real staging-like target and execute what
> Sprint 26 built against it; its only prerequisite is an operator/procurement
> decision, and if that is unavailable, **External Email Provider Closure and
> Secrets Platform Integration** is the correct fallback.

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
| [sprint-24-artifact-package.md](sprint-24-artifact-package.md) | The official Sprint 24 closing artifact (runtime secret sources, JWT key rotation, redaction proofs, external-email evidence state, CI defect history; DoD MET, ORG-PR-002/006 remain open). |
| [sprint-25-artifact-package.md](sprint-25-artifact-package.md) | The official Sprint 25 closing artifact (persistent-data inventory, logical backup, restore drill, **PITR VERIFIED**, retention policy and cleanup, validation evidence; ORG-PR-015 closed, ORG-PR-005 open and materially advanced). |
| [sprint-26-artifact-package.md](sprint-26-artifact-package.md) | The official Sprint 26 closing artifact (deployment target decision, environment taxonomy, registry publishing, release manifest, promote-by-digest deployment, migration lifecycle, smoke, evidence, rollback, rehearsal evidence; **no finding closed**, ORG-PR-001 open and materially advanced). |

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
