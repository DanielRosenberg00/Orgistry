# Sprint 21 Artifact Package — Supply Chain and CI Hardening

Closing artifact for Sprint 21 (executed 2026-07-26). Objective: harden
Orgistry's CI and software supply-chain trust boundary before production
deployment automation begins. Addresses ORG-PR-018, 019, 020, 040, 042, 054.

Authoritative finding statuses live in
[findings-register.md](findings-register.md); this artifact records the
implementation, evidence, and decisions.

> **Follow-up cross-reference (added 2026-07-26, after Sprint 22 — not known
> at Sprint 21 closure).** This artifact records Sprint 21 as it stood when it
> closed: ORG-PR-020 left open because the workflows had never executed on
> GitHub-hosted CI, and "configuration is not enforcement until it has run".
> That judgement was correct and is preserved above unchanged. Sprint 22
> supplied the missing evidence — first green remote runs of all three
> workflows on this sprint's commit `c33a150f`, a remote negative-path proof
> that the Gitleaks job FAILS on a seeded synthetic secret (run 30207672121),
> full triage of the 41 CodeQL alerts this configuration produced, and a
> `main` ruleset making the checks required — and **ORG-PR-020 is now
> Closed**. See
> [sprint-22-artifact-package.md](sprint-22-artifact-package.md) and
> [sprint-22-codeql-alert-inventory.md](sprint-22-codeql-alert-inventory.md).
> Nothing in the Sprint 21 record below has been rewritten to appear as
> though it were known earlier.

## 1. Sprint objective

Establish a trustworthy CI/supply-chain baseline: immutable action pins,
least-privilege workflow tokens, enforceable dependency/secret/SAST scanning,
dependency-update automation, honest triage of the open `drizzle-orm` and
`esbuild` advisories, image-tag pinning for the current infrastructure scope,
and repo-wide `noUncheckedIndexedAccess`.

## 2. Scope boundaries (held)

Not implemented, by design: production deployment automation, production
Dockerfiles, IaC, staging/production environments, release automation,
package/container publishing, registry integration, artifact signing, SLSA
provenance, secrets-manager integration, secret/JWT rotation, backup/PITR,
production SMTP validation, retention jobs, worker runtimes, observability
platforms, application features, unrelated frontend work. No attempt was made
to close ORG-PR-001/002/005/006/015. No commit/push/PR/publish/deploy was
performed; no remote repository settings were modified.

## 3. Supply-chain baseline inventory (pre-sprint)

- **Workflows:** one (`ci.yml`), two jobs. `uses:` references: `actions/checkout@v4`,
  `pnpm/action-setup@v4`, `actions/setup-node@v4` (mutable major tags). No
  `permissions:` block (default token scope), no `concurrency`, no
  `pull_request_target` anywhere, triggers `push:main` + `pull_request`.
  Frozen-lockfile installs already in place. CI secret surface: none beyond
  the default `GITHUB_TOKEN` and a CI-only literal `JWT_SECRET`
  (`ci-jwt-secret-value-1234`, a known-development value the production
  config guard rejects).
- **Scanning:** none (no audit gate, no secret scan, no SAST, no
  Dependabot/Renovate).
- **Package manager:** pnpm 10.29.3 via `packageManager` field; single
  workspace lockfile `pnpm-lock.yaml`.
- **Advisories at baseline** (osv-scanner 2.4.0 against the lockfile, plus
  OSV API detail queries):
  - `drizzle-orm` 0.38.4 — GHSA-gpj5-g38j-94v9 / CVE-2026-39356 (HIGH, SQL
    injection via unescaped identifier delimiters in `sql.identifier()`/
    `.as()`), fixed 0.45.2. Production dependency of `packages/db` and
    `apps/api` (direct in both).
  - `esbuild` 0.18.20 and 0.19.12 — GHSA-67mh-4wv8-2f99 (MODERATE, dev-server
    CORS), fixed 0.25.0; both copies dev-only via `drizzle-kit` 0.30.6
    (`@esbuild-kit` chain + direct). The 0.25.12 (vite) and 0.28.1 (tsx)
    copies were already ≥ the fix.
  - Additional HIGH advisories surfaced by the baseline scan (all with
    in-range fixes except the last two): `find-my-way` 9.6.0 (prod, fastify
    router), `fast-uri` 3.1.2 (prod, ajv chain), `brace-expansion`
    1.1.15/5.0.6 (dev, eslint chains), `postcss` 8.5.15 (dev, vite),
    `shell-quote` 1.8.4 (via drizzle's auto-installed `gel` peer),
    `react-router` 7.18.0 (web demo; fix only in major 8.3.0).
- **TypeScript:** `strict: true` in `tsconfig.base.json`, inherited by all 8
  projects; `noUncheckedIndexedAccess` absent everywhere. Measured failure
  surface with the flag: 297 errors (292 `apps/api` — ~250 in tests, ~40 in
  production code; 3 `packages/db`; 1 `packages/shared`; 1 `apps/web-demo`).
- **Images:** `postgres:16-alpine`, `redis:7-alpine` (compose + CI services),
  `axllent/mailpit:latest` (compose); same floating tags echoed in
  `docs/runbook.md` (current docs; historical sprint artifacts excluded as
  records).

## 4. Implementation summary

1. **Advisory remediation:** `drizzle-orm` → 0.45.2, `drizzle-kit` → 0.31.10,
   scoped override `"@esbuild-kit/core-utils>esbuild": "^0.25.0"`, and
   in-range transitive updates (`pnpm update -r --depth Infinity find-my-way
   fast-uri brace-expansion postcss shell-quote`). Adapted the five
   unique-violation guards to drizzle ≥0.44's `DrizzleQueryError` wrapping
   via one shared helper (`apps/api/src/lib/pg-errors.ts`, new unit suite).
2. **Workflow hardening:** SHA-pinned every action, added workflow-level
   `permissions: contents: read` + `concurrency` to `ci.yml`, pinned CI
   service images.
3. **New scanning workflows:** `security.yml` (pnpm audit gates + Gitleaks)
   and `codeql.yml` (JS/TS, source-only), both SHA-pinned and read-only
   except the CodeQL SARIF upload.
4. **Dependency automation:** `.github/dependabot.yml` (npm, github-actions,
   docker-compose; weekly; minor/patch grouped; no auto-merge).
5. **Secret-scan hygiene:** rewrote realistic-looking committed fixtures to
   unmistakable fakes; added `.gitleaks.toml` with a narrow annotated
   allowlist; added `pnpm scan:secrets`.
6. **Exception plumbing:** `pnpm.auditConfig.ignoreGhsas` +
   `osv-scanner.toml`, two entries, mirrored and documented.
7. **`noUncheckedIndexedAccess`:** enabled in `tsconfig.base.json`; fixed all
   297 errors (helpers `requireRow`/`requireDefined`, local narrowing,
   loop restructuring); zero suppressions added.
8. **Image pinning:** exact patch tags in compose, CI services, and docs.
9. **Documentation:** validation guide (CI security policy, scanner matrix,
   pin-update procedure), known limitations, runbook, README, findings
   register, roadmap (incl. renumbering the future sprints displaced by this
   one), scorecard, standards matrix, launch checklist, repository inventory,
   production-readiness README, this artifact.

## 5. Changed workflow inventory

| File | Status | Jobs | Triggers |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | hardened | `validate`, `integration` | push:main, PR |
| `.github/workflows/security.yml` | new | `dependency-audit`, `secret-scan` | push:main, PR, weekly cron, dispatch |
| `.github/workflows/codeql.yml` | new | `analyze` | push:main, PR:main, weekly cron |
| `.github/dependabot.yml` | new | (config) | weekly |

## 6. GitHub Actions pinning matrix

Every SHA resolved from the upstream repository via `git ls-remote`
(annotated tags dereferenced with `^{}` to the commit); none invented.

| Action | Pinned SHA | Version | Used by |
| --- | --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 | ci (×2), security (×2), codeql |
| `pnpm/action-setup` | `0ebf47130e4866e96fce0953f49152a61190b271` | v6.0.9 | ci (×2), security |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0 | ci (×2), security |
| `github/codeql-action/init` + `/analyze` | `e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81` | v4.37.3 | codeql |
| `gitleaks/gitleaks-action` | `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` | v3.0.0 | security |

Zero mutable `uses:` references remain (verified by repo-wide search).
Update procedure: [docs/validation.md → Updating pinned actions](../validation.md).

## 7. Workflow permissions summary and rationale

- All three workflows: workflow-level `permissions: contents: read`.
- The single non-read grant in the repository: `security-events: write` on the
  CodeQL `analyze` job — required to upload SARIF results to code scanning —
  plus `actions: read` (CodeQL action requirement on private repositories;
  read-only). Documented inline in the workflow.
- No `contents: write`, `packages: write`, `id-token: write`, or `write-all`
  anywhere. No OIDC (nothing deploys).

## 8. Workflow trigger review

- `pull_request` (not `pull_request_target`) everywhere: fork PRs get a
  read-only token and no repository secrets; no untrusted code runs in a
  privileged context. `pull_request_target` is absent from the repository.
- Scheduled scanner runs are read-only (audit queries the registry from the
  lockfile; Gitleaks reads git content; CodeQL uploads SARIF only) and mutate
  no repository state.
- `workflow_dispatch` exists only on `security.yml`; it re-runs scanners and
  bypasses nothing (CI validation runs independently of it).
- No scanner requires a production secret; the only secret referenced is the
  default `GITHUB_TOKEN` (read scope + the scoped SARIF write above).
- Accepted trigger risks: none identified beyond the standard note that
  scheduled runs execute on `main` as-is.

### Gitleaks scan and token semantics (verified against the pinned action source)

- **Checkout depth:** the secret-scan job checks out with `fetch-depth: 0`
  (full history).
- **Scan range per event** (`src/index.js`/`src/gitleaks.js` at the pinned
  commit): push → `gitleaks detect` restricted to the pushed commit range
  (`--log-opts base^..head`); pull_request → the PR's commit range;
  schedule / workflow_dispatch → `gitleaks detect` with no `--log-opts`, i.e.
  the **full git history** of the checkout (this is what requires
  `fetch-depth: 0`; it also supplies range scans' base commits). The local
  `pnpm scan:secrets` equals the scheduled full-history scan.
- **Redaction:** the action always passes `--redact -v`; findings print with
  `REDACTED` in place of the secret.
- **Token:** `GITHUB_TOKEN` is hard-required by the action (it exits 1 on PRs
  without it) for two **read-only** API calls: an account-type lookup (its
  license check — free for personal accounts; a `GITLEAKS_LICENSE` secret
  becomes required only if the repository moves into an organization) and
  the PR commit listing.
- **Write behavior:** none. PR review comments (the only write path, which
  would need `pull-requests: write`) are explicitly disabled with
  `GITLEAKS_ENABLE_COMMENTS: 'false'`; the job is a pure pass/fail gate. The
  redacted `results.sarif` job artifact and job summary use the runner's
  runtime token, not GITHUB_TOKEN scopes.
- **Fork PRs:** behave identically to same-repo PRs — the fork's read-only
  token satisfies the two read calls, and no write is ever attempted.
- **Untracked local state** (`.tokensave/`, caches, build output) cannot
  influence any scan: CI scans a clean checkout and both CI and the local
  command use git-aware scanning of tracked content only.

## 9. Scanner matrix

| Scanner | Purpose | Trigger | Local command | Failure threshold |
| --- | --- | --- | --- | --- |
| `pnpm audit --prod` | production dependency advisories | push/PR/weekly/dispatch | `pnpm scan:deps` | high/critical fail |
| `pnpm audit --dev` | development dependency advisories | same | `pnpm scan:deps` | high/critical fail |
| osv-scanner | local mirror of the audit policy (lockfile-based) | local only | `pnpm scan:deps:local` | any unignored finding fails |
| Gitleaks | committed-secret detection | push/PR = event commit range; schedule/dispatch = full history; local = full history | `pnpm scan:secrets` | any suspected live secret fails (exit non-zero, redacted output, PR comments disabled) |
| CodeQL | JS/TS SAST | push/PR/weekly | none (GitHub-hosted only) | findings reported to code scanning; triage documented |

## 10. Scanner failure policies

- Unaccepted high/critical dependency advisories fail CI (prod and dev jobs
  both gate at `--audit-level high`; moderate/low print only).
- Secret scan fails on any suspected live secret; output is redacted.
- No scanner step uses `|| true`, `continue-on-error`, or
  `--ignore-registry-errors`.
- Exceptions: per-GHSA only, mirrored in `pnpm.auditConfig.ignoreGhsas` and
  `osv-scanner.toml`, each with a reachability analysis in the findings
  register (see §22). Gitleaks allowlist: one fixture path + six exact-value/
  prose regexes, annotated in `.gitleaks.toml`.
- CodeQL findings are triaged in the code-scanning UI; high-confidence
  high-severity alerts must not be dismissed without a findings-register
  entry (policy in docs/validation.md).

## 11. Dependency update automation

Dependabot (chosen over Renovate: no existing Renovate usage, native
GitHub-Actions-pin and Docker support, zero extra trust surface):
npm (workspace root), github-actions, docker-compose (`infra/` — the
ecosystem that discovers `docker-compose.yml`; the repo has no Dockerfiles,
so the `docker` ecosystem would find nothing); weekly (Monday);
minor+patch grouped for npm, majors individual; security alerts surface at
platform speed; no labels assumed, no auto-merge (none configured anywhere),
human review required — pin-review procedure in docs/validation.md.

Known coverage gap (documented in docs/validation.md and the runbook): the CI
service-container images in `ci.yml` are not discovered by any Dependabot
ecosystem; they are bumped by hand in the same PR as each `docker-compose`
update to keep compose and CI in sync.

## 12. `drizzle-orm` advisory analysis (ORG-PR-018 — CLOSED)

- Installed 0.38.4 (direct in `packages/db` + `apps/api`); GHSA-gpj5-g38j-94v9
  (HIGH, CVE-2026-39356): identifier delimiters not escaped in dialect
  `escapeName()` — exploitable only where untrusted input reaches
  `sql.identifier()`/alias construction. Repo triage: static identifiers
  throughout (no dynamic sort-by-request-param patterns). Remediated anyway:
  fix release 0.45.2 is the current latest stable.
- Upgrade delta handled: drizzle ≥0.44 wraps driver errors in
  `DrizzleQueryError` (cause chain). Without adaptation, all five
  `error.code === '23505'` guards would silently stop matching — registration
  conflicts, duplicate pending invitations, email-change conflicts, and the
  active-membership backstop would surface as 500s. Fixed centrally in
  `apps/api/src/lib/pg-errors.ts` (bounded cause-chain walk; unit-tested for
  bare/wrapped/double-wrapped/cyclic errors), which also removed five
  duplicated local guards.
- `drizzle-kit` 0.30.6 → 0.31.10: schema-drift check clean (no snapshot or
  migration churn); `pnpm db:migrate` + migration-from-scratch integration
  test green.
- Evidence: osv-scanner reports no drizzle-orm finding; `pnpm validate` and
  `pnpm validate:integration` (82 live-PG tests incl. unique-violation and
  quota races) exit 0.

## 13. `esbuild` advisory analysis (ORG-PR-054 — CLOSED)

- GHSA-67mh-4wv8-2f99 (MODERATE): esbuild dev-server default CORS lets any
  website read dev-server responses; fixed 0.25.0. Vulnerable copies 0.18.20
  (`drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`) and
  0.19.12 (`drizzle-kit` direct + `esbuild-register`) — dev-only
  (`drizzle-kit` is a devDependency), never CI-build- or production-artifact-
  reachable (nothing starts esbuild's server; vite's dev server uses its own
  0.25.12 copy).
- Remediation: `drizzle-kit` 0.31.10 (esbuild ^0.25, `esbuild-register`
  dropped) + scoped override `"@esbuild-kit/core-utils>esbuild": "^0.25.0"`
  for the deprecated chain it still carries. `pnpm why -r esbuild` now shows
  only 0.25.12 and 0.28.1. The override path is exercised by the schema-drift
  check (drizzle-kit codegen) and migrations — both green.

## 14. Lockfile integrity status

All changes via pnpm (`pnpm add` / `pnpm update` / `pnpm install`); the
lockfile was never hand-edited. Churn: drizzle-orm/drizzle-kit upgrade
(removes the old kit's esbuild/@esbuild-kit subtree), five in-range
transitive advisory bumps, and the esbuild override — net −672 lockfile
lines, no unrelated version movement observed in the diff. CI installs remain
`--frozen-lockfile`; `packageManager: pnpm@10.29.3` and Corepack pinning
unchanged.

## 15. Docker and image pinning inventory

| Location | Before | After |
| --- | --- | --- |
| `infra/docker-compose.yml` postgres | `postgres:16-alpine` | `postgres:16.14-alpine` |
| `infra/docker-compose.yml` redis | `redis:7-alpine` | `redis:7.4.10-alpine` |
| `infra/docker-compose.yml` mailpit | `axllent/mailpit:latest` | `axllent/mailpit:v1.30.5` |
| `ci.yml` services | `postgres:16-alpine`, `redis:7-alpine` | `postgres:16.14-alpine`, `redis:7.4.10-alpine` |
| `docs/runbook.md` (table + example) | floating | pinned (matching) |

Tags verified against Docker Hub; `docker compose config` validates; same
majors, so local/dev usability and existing tests are unaffected (integration
suite green). **Digest pinning deferred** to the ORG-PR-001 deployable-
artifact track — residual: a tag can be re-pushed upstream. ORG-PR-042
remains open, materially advanced. Historical sprint artifacts retain their
original tag mentions by design.

## 16. `noUncheckedIndexedAccess` decision and change surface (ORG-PR-040 — CLOSED)

- Authoritative config: `tsconfig.base.json`; all 8 projects extend it, none
  overrides the flag. Enabled globally (preferred outcome; no partial
  rollout needed).
- Surface fixed: 297 errors. Production-code categories: `.returning()` /
  `.limit(1)` row unwrapping (repos, provisioning, acceptance) → `requireRow`
  with query context; byte-loop indexing in the two `randomBase32`
  implementations → iterate bytes directly; RBAC matrix record lookups →
  value iteration + an explicit `requireDefined` invariant on the matrix
  entry for a recognized role (the refinement pass replaced an initial
  silent `?.push` — a violated catalog invariant now throws instead of
  dropping permissions; unknown grant ids are still skipped, the
  pre-existing documented behavior, proven by `rbac.service.test.ts`);
  `split()[0]` / regex-group access → `?? fallback` / `?.[1]` with tested
  equivalence. Test categories: drizzle
  insert helpers → `requireRow`; captured-mail/fixture indexing →
  `requireDefined`; one-off `expect(rows[0]?.x)` narrowing only with positive
  matchers.
- Suppression review (diff-wide): zero new `!`, `as any`, `@ts-ignore`,
  `@ts-expect-error`; one pre-existing `match![1]` removed. Runtime behavior
  unchanged except louder invariant failures; new unit suite for
  `pg-errors`; existing 825-test unit suite and 82-test integration suite
  green.

## 17. Tests and validation evidence

Final tree (2026-07-26, after the refinement pass): `pnpm validate` exit 0
(typecheck with the flag on, lint, unit suites incl. the new
`rbac.service.test.ts` / `invariant.test.ts` / `pg-errors.test.ts`, web
tests, web build, schema drift, whitespace), `pnpm validate:integration`
exit 0 (live PostgreSQL + Redis), `git diff --check` clean, actionlint exit
0, osv-scanner exit 0 (2 documented ignores), gitleaks full-history scan
exit 0, `docker compose config -q` exit 0, `.github/dependabot.yml` parses.

**Negative-path scanner proof (disposable, outside Orgistry history):** in a
temporary git repository under the session scratchpad seeded with the final
`.gitleaks.toml`: (1) a freshly generated synthetic 40-hex "secret"
committed and scanned with `gitleaks git --redact` → **exit 1**, and with
`-v` (the CI action's argument) the output printed `REDACTED` and never the
raw value; (2) the exact allowlisted historical fixture value committed →
**exit 0** (allowlist honored); (3) the same value with ONE character
changed → **exit 1** (the allowlist is exact-value narrow). The temporary
repository was deleted afterwards; nothing was added to Orgistry's history.

**Audit-gate proof (local, final pass):** the exact CI commands executed
locally — `pnpm audit --prod --audit-level high` exit 0 (1 high found =
react-router GHSA-qwww-vcr4-c8h2, ignored per the documented acceptance) and
`pnpm audit --dev --audit-level high` exit 0 (1 high = brace-expansion
GHSA-mh99-v99m-4gvg, ignored likewise). Negative path: temporarily removing
the react-router GHSA from `pnpm.auditConfig.ignoreGhsas` made
`pnpm audit --prod --audit-level high` exit **1**; `package.json` was then
restored byte-identical (diff-verified against the pre-test backup). Note:
`pnpm audit` failed earlier the same day on this workstation with a
gzip-decode JSON parse error — an intermittent local network condition,
retained as a recorded failure; `pnpm scan:deps:local` (osv-scanner) is the
network-independent fallback.

Not executable locally: the CI workflows themselves (CodeQL has no local
equivalent at all) — first remote execution is documented outstanding
evidence (ORG-PR-020); no remote result is claimed.

## 18. Documentation index

Updated: `docs/validation.md` (scan commands, CI section, CI security
policy/contracts, pin-update procedure, failure table),
`docs/known-limitations.md` (remote-run gap, accepted advisories, tag-vs-
digest residual), `docs/runbook.md` (pinned image table/example),
`README.md` (workflow overview), `docs/production-readiness/`:
`findings-register.md` (Sprint 21 status update + 6 entries),
`production-roadmap.md` (Sprint 21 completion; future sprints renumbered
22–25 with the pre-existing numbering collision documented in-file as
corrective maintenance), `production-scorecard.md` (CI/CD + supply-chain
rows), `standards-matrix.md` (SSDF rows), `security-assessment.md` (Sprint
21 update block; supply-chain and CI/CD sections rewritten to current
state), `launch-checklist.md` (LC-1.4 closed, LC-1.5 advanced; Sprint
column reconciled to the corrected numbering),
`production-target.md` (DG-5 sprint reference reconciled),
`repository-inventory.md` (CI + Docker update notes — a point-in-time
audit record, so updates are appended rather than rewritten), `README.md`
(status block + doc index), and this artifact.

## 19. Findings closed

ORG-PR-018, ORG-PR-019, ORG-PR-040, ORG-PR-054 (evidence on each register
entry).

## 20. Findings materially advanced (open)

Sprint 21 repository implementation is complete; these two findings stay
open on evidence grounds, not implementation grounds:

- **ORG-PR-020 remains open pending first remote CI execution and
  negative-path enforcement evidence** — scanners + Dependabot configured
  and locally validated (incl. the disposable negative Gitleaks proof, §17);
  closure requires the first green remote runs of `security.yml` and
  `codeql.yml` plus a controlled finding failing the relevant remote job.
- **ORG-PR-042 remains open pending digest pinning** — exact patch tags
  shipped everywhere in current scope; digests are deferred to the
  ORG-PR-001 deployable-artifact track.

## 21. Findings remaining open (unchanged)

ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006 (P1); ORG-PR-015 (P2); all
other previously open findings untouched.

## 22. Accepted residual risks

1. **react-router GHSA-qwww-vcr4-c8h2** (HIGH, CSRF in unstable RSC APIs;
   fixed only in 8.3.0): not reachable — the web demo is a client-only Vite
   SPA (BrowserRouter; verified zero `unstable_`/RSC usage), no server
   rendering exists. Owner: SecEng; revisit on the react-router 8 upgrade.
   Pinned in `ignoreGhsas` + `osv-scanner.toml`.
2. **brace-expansion GHSA-mh99-v99m-4gvg** (HIGH, DoS; fixed only in 5.0.8):
   the 1.x copy is a dev-only eslint transitive (minimatch 3 pins ^1.1.7 — no
   compatible fixed release); lint-time expansion of repo-authored globs
   only. Owner: SecEng; revisit when the eslint chain leaves minimatch 3.
3. **Tag re-push window** on patch-pinned images (→ ORG-PR-042/001).
4. **First remote CI run outstanding** for all Sprint 21 workflows
   (→ ORG-PR-020).
5. **Gitleaks fixture allowlist** (one path + six exact values): a real
   secret pasted into `tls-fixtures.ts` specifically would be missed;
   accepted as narrow, annotated in `.gitleaks.toml`.

## 23. Scope-control confirmation

No deployment automation, Dockerfiles, IaC, staging/production environment,
release/publishing pipeline, registry integration, signing/provenance,
secrets-manager, rotation, backup, SMTP validation, retention jobs, worker
runtime, observability platform, or application feature was added. Runtime
behavior changes are limited to advisory remediation (drizzle upgrade + error
classification adaptation) and louder invariant failures. Nothing was
committed or pushed; no remote settings were touched.

## 24. Remaining P1 blockers

ORG-PR-001 (deployment), ORG-PR-002 (external email delivery), ORG-PR-005
(backup/PITR/restore), ORG-PR-006 (secrets management) — unchanged and
visible; ORG-PR-015 (retention) also open.

## 25. Final readiness classification

**C — Ready to continue production implementation. Not ready for staging.
Not ready for production.** CI hardening does not establish deployment
readiness.

## 26. Recommended next sprint

**Sprint 22 — Deployable artifact & pipeline** (Phase 4: ORG-PR-001/006/021/
022 + ORG-PR-042 digest completion), with one Sprint 21 residual to fold into
its first CI interaction: verify the first remote runs of `security.yml` and
`codeql.yml` (and a seeded-finding failure) to close ORG-PR-020 before
build/deploy automation extends the workflow surface.

## 27. Sprint changelog (iteration history)

1. **Baseline inventory** (§3): workflow/pin/permission audit, advisory
   scans, `noUncheckedIndexedAccess` failure-surface measurement, image and
   fixture inventory.
2. **Main implementation:** advisory remediation (drizzle 0.45.2 +
   `DrizzleQueryError` guard adaptation, esbuild elimination, in-range
   transitive bumps), workflow hardening + new scanner workflows +
   Dependabot, secret-fixture rewrites + `.gitleaks.toml`,
   `noUncheckedIndexedAccess` enablement (297 fixes, zero suppressions),
   image pinning, documentation sync.
3. **Refinement pass (same day) — correctness and evidence corrections:**
   - **Gitleaks semantics made precise and verified against the pinned
     action's source** (§8): per-event scan ranges, `fetch-depth: 0`
     rationale, GITHUB_TOKEN's two read-only calls, license behavior; PR
     review comments explicitly disabled (`GITLEAKS_ENABLE_COMMENTS:
     'false'`) so the job is a pure read-only gate that is fork-PR-safe.
     The earlier blanket "full history in CI" phrasing was corrected — only
     schedule/dispatch (and the local command) scan full history; push/PR
     scan the event's commit range.
   - **Dependabot Compose coverage fixed:** the `docker` ecosystem discovers
     only Dockerfiles (none exist); replaced with `docker-compose` for
     `infra/`, which actually reads `docker-compose.yml`. The uncovered CI
     service-container images are documented as a manual-sync gap (§11).
   - **RBAC invariant correction:** the initial `matrix[roleKey]?.push(...)`
     could silently drop permissions if the internal catalog invariant were
     ever violated; replaced with an explicit `requireDefined` guard that
     throws, keeping the documented skip-unknown-grant-ids behavior, with
     new focused tests (`rbac.service.test.ts`, `invariant.test.ts`).
   - **Roadmap renumbering documented as corrective maintenance:** the
     pre-existing collision (two different "Sprint 21" entries plus a stale
     "Sprint 20" supply-chain label) is now recorded in the roadmap itself,
     and the remaining stale cross-references (launch-checklist Sprint
     column + prose, production-target DG-5 note) were reconciled.
   - **Negative-path scanner proofs executed** (§17): Gitleaks in a
     disposable repository (fail/redact/allowlist-narrowness demonstrated
     without touching Orgistry history), and the pnpm audit gate proven to
     exit 1 on an unaccepted high (ignore entry temporarily removed,
     `package.json` restored byte-identical). Local `pnpm audit` also
     executed successfully in this pass — the earlier gzip failure is an
     intermittent local network condition, not a repo defect.
   - **Completion wording standardized** across the production-readiness
     docs: *Sprint 21 repository implementation is complete; ORG-PR-020
     remains open pending first remote CI execution and negative-path
     enforcement evidence.*
   - Full validation re-run on the corrected tree (§17).
4. **Commit-readiness review:** working tree audited file-by-file (80
   entries, all Sprint 21); `.gitignore` gained entries for the local
   assistant/tooling state directories (`.claude/`, `.tokensave/` — the
   latter's database WAL contains scanner-sensitive blobs and must never be
   committed); final validation battery re-run green, with one transient
   `pnpm validate` failure attributed to the pre-existing, documented
   web-demo test flake (three consecutive clean `test:web` re-runs).
