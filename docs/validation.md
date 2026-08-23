# Validation Matrix

How to validate Orgistry locally and in CI, what each command proves, and how to
read a failure. This is the authoritative, current reference — it matches the
package scripts in `package.json`.

There are two tiers:

- **Offline validation** (`pnpm validate`) — no databases, no network services.
  Runs anywhere, including a fresh clone.
- **Integration validation** (`pnpm validate:integration`) — requires live
  PostgreSQL + Redis.

## Quick reference

| Command | Tier | Proves |
| --- | --- | --- |
| `pnpm typecheck` | offline | Strict `tsc --noEmit` across every package/app — no type errors. |
| `pnpm lint` | offline | ESLint gate (API + packages + web demo) — no lint errors. |
| `pnpm test` | offline | Unit tests (Vitest), no infrastructure. |
| `pnpm test:web` | offline | Web demo component/routing tests (jsdom). |
| `pnpm build:web` | offline | Web demo production build succeeds. |
| `pnpm db:check` | offline | Committed Drizzle migrations match the schema (no drift). |
| `pnpm check:whitespace` | offline | `git diff --check` — no whitespace errors in the working tree. |
| **`pnpm validate`** | **offline** | **All of the above, in order.** |
| `pnpm db:reset:test` | integration | Drops + recreates + migrates the **test** database. |
| `pnpm test:integration` | integration | DB migration-from-scratch + live API readiness/route tests. |
| **`pnpm validate:integration`** | **integration** | **`db:reset:test` then `test:integration`.** |
| `pnpm scan:deps` | scan (network) | Dependency audit via `pnpm audit` — fails on unaccepted high/critical advisories (prod and dev audited separately). |
| `pnpm scan:deps:local` | scan | Same policy via [osv-scanner](https://google.github.io/osv-scanner/) against `pnpm-lock.yaml` (`brew install osv-scanner`); use when the registry audit endpoint is unreachable. |
| `pnpm scan:secrets` | scan | Gitleaks full git-history secret scan (`brew install gitleaks`) — fails on any suspected live secret; run before pushing. |
| `pnpm artifact:build` | artifact (Docker) | Production API + web images build from their Dockerfiles. |
| **`pnpm artifact:smoke`** | **artifact (Docker)** | **Builds the production artifacts and runs the full smoke gate against the production-like compose reference (see [Artifact validation](#artifact-validation)).** |

## Offline validation: `pnpm validate`

```bash
pnpm install
pnpm validate
```

Runs, in order and failing fast on the first non-zero step:

1. `pnpm typecheck` — strict TypeScript across all workspaces.
2. `pnpm lint` — ESLint (see [ESLint gate](#eslint-gate)).
3. `pnpm test` — unit tests.
4. `pnpm test:web` — web demo tests.
5. `pnpm build:web` — web demo production build.
6. `pnpm db:check` — schema drift check.
7. `pnpm check:whitespace` — whitespace check.

Every step exits non-zero on failure, so `pnpm validate` is a reliable gate.
This is what a reviewer should run after `pnpm install`.

### ESLint gate

`pnpm lint` runs `eslint .` against the flat config in `eslint.config.js`. It
covers all hand-written TypeScript — the API, the shared packages, and the web
demo — using the typescript-eslint *recommended* rule set plus React hook
correctness rules for the web demo. It explicitly ignores generated SQL
migrations (`packages/db/migrations`), build outputs (`dist`/`build`),
coverage, and the lockfile. Formatting is intentionally not linted. The gate
fails on errors; a small number of advisory rules (e.g. `no-explicit-any`,
`react-hooks/exhaustive-deps`) are warnings.

### Schema drift check

`pnpm db:check` runs `tooling/check-schema-drift.mjs`: it snapshots the
content of `packages/db/migrations`, regenerates Drizzle migrations from the
schema (offline — no database needed), and fails if regeneration changed
anything. The comparison is **content before-vs-after generation, not git
status** — a correctly generated migration that is not yet committed is in
sync and passes; anything generation adds, rewrites, or removes is drift. CI
runs on a clean checkout, so a schema change committed without its migration
still fails there. If it fails locally, you edited the schema without
regenerating: run `pnpm db:generate`, review the new migration, and include
it with the schema change. The snapshot/diff helpers are unit-tested
(`tooling/check-schema-drift.test.ts`).

## Integration validation: `pnpm validate:integration`

Requires live PostgreSQL + Redis (start them with `pnpm infra:up`; see the
[runbook](./runbook.md)). Redis is MANDATORY for a valid integration pass:
the real-Redis limiter suite
(`apps/api/src/lib/rate-limit.redis.integration.test.ts`) fails hard — it
never skips — so `pnpm validate:integration` exits non-zero when Redis is
unreachable rather than reporting a green run that silently omitted the
Redis evidence. (The DB-backed suites are separately gated by
`db:reset:test`, which refuses to run without a reachable test database.) The relevant environment variables must be set
(`DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`NODE_ENV=test`); `cp .env.example .env` provides working local defaults.

```bash
pnpm infra:up                # PostgreSQL, Redis, Mailpit
pnpm db:reset:test           # (or run the combined command below)
pnpm validate:integration    # db:reset:test + test:integration
```

`pnpm validate:integration` runs:

1. `pnpm db:reset:test` — drops the `public` and `drizzle` schemas in the **test**
   database and re-applies the migration baseline from scratch. Guarded: it
   refuses to run unless `TEST_DATABASE_URL` is set and differs from
   `DATABASE_URL`, so it can never wipe your dev database.
2. `pnpm test:integration` — the DB migration-from-scratch test plus the live API
   readiness and route integration tests against PostgreSQL + Redis.

### What integration validation proves

- Migrations apply cleanly from an empty database and seed the fixed roles,
  permissions, role→permission matrix, and plan catalog exactly (no drift from
  the `@orgistry/contracts` source of truth).
- `/ready` reports healthy only when PostgreSQL **and** Redis are reachable.
- The auth, registration, organization, member, projects, entitlements, and
  invitations routes behave correctly against a real database (transactional
  invariants, tenant isolation, quota enforcement).
- The credential lifecycle (Sprint 17) holds at the SQL layer: hash-only reset
  tokens, `FOR UPDATE`-serialized reset completion (two concurrent completions
  can never both succeed), session + refresh-token revocation in the same
  transaction as the password swap, the keep-current-session password-change
  policy, and the email-change verification reset
  (`password-recovery.integration.test.ts`).
- The verification-first registration lifecycle (Sprint 18) holds at the SQL
  layer: advisory-lock-serialized issuance leaving exactly one usable pending
  generation per email, `FOR UPDATE`-serialized completion (exactly one of any
  set of concurrent completions succeeds), the one-transaction creation of the
  email-verified user + personal workspace + session, and the savepoint-scoped
  invitation re-check (`registration.integration.test.ts`; the route-level
  suite is `registration.routes.test.ts`, the invitation-state public
  equality matrix lives in `invitation.routes.test.ts`, and the web demo's
  registration flows — plain and invitation-aware — are covered by
  `registration.test.tsx` and `invitation-registration.test.tsx`).
- The Sprint 20 authorization & concurrency guarantees hold against live
  PostgreSQL: `quota-concurrency.integration.test.ts` fires 4–6 genuinely
  parallel attempts at a remaining capacity of ONE for project creation, API
  key creation, DISTINCT-token invitation acceptance, invited registration
  completion, and invitation-create seat reservation — asserting the exact
  success count, `QUOTA_EXCEEDED` (or the documented invitation-`unavailable`
  completion outcome) on the losers, final DB state (no ceiling overrun, no
  orphans), and success events matching committed mutations. The suite warms
  the connection pool first so the transactions genuinely overlap, and it
  fails deterministically if the quota lock is removed.
  `quota-plan-coherence.integration.test.ts` proves the quota decision uses
  the TRANSACTION-CURRENT plan (repository contracts carry no pre-resolved
  ceilings): a committed downgrade/upgrade is honored by the very next
  create/acceptance, an IN-FLIGHT plan change serializes against the create
  (`FOR SHARE` snapshot vs the plan mutation's `FOR UPDATE`), the API-key
  access gate and ceiling come from one coherent snapshot, and missing plan
  state fails safe inside the transaction.
  `migrate.integration.test.ts` additionally proves the Sprint 20 schema
  invariants: the at-most-one-active-personal-workspace partial unique index
  (with team-org and archived-lifecycle counter-cases), forward application
  of the exact committed 0011 DDL over a POPULATED pre-Sprint-20 dataset
  (preceded by the reviewer preflight duplicate-workspace query), and the
  `ix_security_events_org_created_id` audit-read index (definition + an
  `enable_seqscan = off` EXPLAIN). `member.integration.test.ts` proves DG-2
  transactionally (Admin can neither self-promote to Owner nor demote/remove
  one; Owner promotion + hand-off works).
- The Sprint 19 edge hardening holds: a failed-auth **storm** integration test
  proves the per-IP durable-write bound on external API-key auth failures
  (writes stop at the allowance while the uniform 401 contract holds). The
  rest of the edge-security surface is covered by unit/route suites in the
  offline tier: `TRUST_PROXY` parsing and client-IP resolution, the security
  headers on every response class, the global per-IP limiter and the
  mutation/invitation throttles (429 envelopes, fail-open/fail-closed
  behavior), request-id sanitization, and pino logger redaction.

### Integration tests skip safely

If `TEST_DATABASE_URL`/`DATABASE_URL` or `REDIS_URL` are unset, the integration
suites **skip with a printed warning** rather than silently passing. A green run
with skips is not a validated run — check the output.

## Artifact validation

Sprint 23 (ORG-PR-001). `pnpm artifact:smoke` runs
`tooling/artifact-smoke.sh`: it builds the production-shaped API and web
images (`apps/api/Dockerfile`, `apps/web-demo/Dockerfile`) and validates them
end to end against `infra/compose.production-like.yml` — a validation
topology, not a deployment (see
[deployment-artifacts.md](deployment-artifacts.md)). The script asserts:
one-shot migrations, `NODE_ENV=production` boot with fake guard-passing
config, `/health` + coarse `/ready` (including fail-closed readiness on a
Redis stop and recovery), web production serving + SPA fallback + baked-in
public API base URL, non-root runtimes, read-only application tree, artifact
hygiene (no `.env`/git/TypeScript source), secret absence from logs and web
assets, config-guard rejection of a development secret, clean SIGTERM exit,
and full teardown.

Sprint 24 (ORG-PR-006) added the runtime secret-source checks to the same
script: the artifact boots with secrets supplied as mounted **files**
(`JWT_SECRET_FILE`, `SMTP_PASSWORD_FILE`), the file-loaded secrets never appear
in its logs, an **unsafe** file-loaded secret is still rejected by the
production guard (proving resolution happens before validation), an ambiguous
env+file pair for one variable is refused, a missing secret file fails closed
naming the path but not the contents, and neither image's config declares a
secret-bearing variable. The fake secret files are created in a temporary
directory by the script and deleted on exit — none is committed.

**Fixture permissions are load-bearing on Linux — do not remove them.** The
harness explicitly `chmod`s the temporary secret directory to `0755` and its
files to `0444` after creating them. `mktemp -d` yields mode `0700` owned by
the invoking user (uid 1001 on a GitHub runner), while the API artifact runs as
the non-root `node` user (uid 1000); on Linux a bind mount passes the host
inode through unchanged, so without the `chmod` the runtime cannot traverse the
directory, config validation fails closed, and the container exits before
serving `/health`. Docker Desktop on macOS remaps bind-mount ownership to the
container user and hides this entirely, so **a change to this block that is
tested only on macOS can still break Linux CI** — that is exactly how it was
first caught (PR #33, CI run 32656512688). If a `_FILE` boot check fails, the
harness now prints the container status and exit code, the host fixture modes,
and the container logs with fake secret values masked.

Requirements: Docker with compose v2 and `curl`; no workspace install, **no
real secrets and no email-provider credentials**. Ports 3000/8080/3010 must be
free (stop `pnpm dev` first).

### Image pinning policy

Every active image reference — Dockerfile base images, both `infra/` compose
files, and the CI workflow service containers — is pinned **exact patch tag
plus manifest-list digest** (`name:X.Y.Z@sha256:…`, ORG-PR-042). The tag
documents intent; the digest makes the reference immune to tag re-pushes. No
`latest`, no floating majors.

Updating a pin (Dependabot proposes bumps for Dockerfiles and compose files;
workflow `services:` images are **not** covered by Dependabot and must be
bumped manually in the same change):

1. Pick the new exact patch tag from the upstream release notes.
2. Resolve its manifest-list digest:
   `docker buildx imagetools inspect <image>:<tag>` (the top-level `Digest:`
   line — the multi-arch list digest, valid on both arm64 and amd64).
3. Update every reference to the same `tag@digest` (grep for the image name
   across `apps/*/Dockerfile`, `infra/*.yml`, `.github/workflows/ci.yml`).
4. Run `pnpm artifact:smoke` (and `pnpm infra:up` if the dev stack images
   changed) to prove the pinned images still work.

## Mailpit / email

The SMTP conversation is exercised by automated tests against an **in-process
fake SMTP server** (`apps/api/src/modules/mail/*.test.ts`) — including the
production driver's real implicit-TLS handshake and authentication exchange
(the protocol implementation is nodemailer since the Sprint 16 refinement),
header-injection rejection, and the email-verification lifecycle end to end
(unit + DB-backed integration suites, using the in-memory mailer). Sprint 24
added `smtp-failure-redaction.test.ts`, which proves the SMTP password survives
in neither the message, the stack, nor any own property of the error thrown by
rejected authentication, a rejected sender, a rejected recipient, a refused
connection, an untrusted certificate, or a connection timeout.

What is NOT automated: delivery to the
**live Mailpit container** (verified manually via the
[demo walkthrough](./demo-walkthrough.md); CI does not start Mailpit) and
delivery through a **real external provider** to a real inbox (never performed
— no provider credentials, no verified sending domain, no test mailbox; see
[known limitations](./known-limitations.md),
[email-and-verification.md](./email-and-verification.md), and the closure
procedure in
[rotation-runbook.md](./rotation-runbook.md#validate-external-email-delivery)).

## CI

Three workflows run on GitHub-hosted CI (Sprint 21 hardening: every action is
pinned to a full commit SHA, every workflow declares explicit least-privilege
permissions, and nothing publishes or deploys — see
[CI security policy](#ci-security-policy)).

`.github/workflows/ci.yml` mirrors this matrix as three jobs:

- **Validate (offline)** — install (frozen lockfile), typecheck, lint, unit
  tests, web tests, web build, schema drift check, whitespace check.
  Equivalent to `pnpm validate`.
- **Integration (PostgreSQL + Redis)** — spins up `postgres:16.14-alpine` and
  `redis:7.4.10-alpine` service containers (tag+digest pinned, matching
  `infra/docker-compose.yml`), creates the test database, applies the
  migration baseline, and runs `pnpm validate:integration`.
- **Artifacts (build + smoke)** — runs `tooling/artifact-smoke.sh`: builds the
  production API and web images and validates them against the
  production-like compose reference (see
  [Artifact validation](#artifact-validation)). Needs no production secrets;
  publishes and pushes nothing. Equivalent to `pnpm artifact:smoke`.

Mailpit is intentionally omitted from CI (see above).

`.github/workflows/security.yml` (push to main, pull requests, weekly
schedule, manual dispatch) runs the scanners:

- **Dependency audit (pnpm)** — `pnpm audit --prod --audit-level high` then
  `pnpm audit --dev --audit-level high`, straight from the lockfile (no
  install, so no dependency code executes). High/critical advisories fail the
  job; moderate/low are printed only. Local equivalent: `pnpm scan:deps`
  (or `pnpm scan:deps:local` via osv-scanner when the registry audit endpoint
  is unreachable — some networks gzip the response in a way `pnpm audit`
  cannot parse).
- **Secret scan (Gitleaks)** — fails on any suspected live secret, with
  output always redacted. Scan range depends on the event (verified against
  the pinned action's source): push runs scan the pushed commit range, PR
  runs scan the PR's commit range, and the weekly schedule / manual dispatch
  scan the **full git history** (the checkout uses `fetch-depth: 0` for
  this). PR review comments are explicitly disabled
  (`GITLEAKS_ENABLE_COMMENTS: 'false'`) so the job needs no write
  permission and behaves identically on fork PRs; the action requires
  `GITHUB_TOKEN` only for two read-only API calls. Local equivalent:
  `pnpm scan:secrets` — a full-history scan, i.e. stricter than the
  per-range CI runs and equal to the scheduled run. Untracked local files
  (tool caches, databases) are never scanned: both CI and the local command
  use git-aware scanning of tracked content.

`.github/workflows/codeql.yml` (push/PR to main, weekly schedule) runs CodeQL
static analysis for `javascript-typescript` in source-only mode
(`build-mode: none` — no install, no build, no secrets). Findings appear
under the repository's **Security → Code scanning** tab; there is no local
equivalent. The triage rules are in
[CodeQL alert policy](#codeql-alert-policy) below.

### CodeQL alert policy

The single authoritative statement of how CodeQL findings are handled
(Sprint 22). Written to be enforceable and to be honest about where
enforcement stops.

**Scanner execution.** A CodeQL *workflow failure* is a hard failure. The
analyze job is a required status check on `main`, so a run that errors,
times out, or is cancelled blocks the merge exactly like a failing test — a
scanner that did not run is never treated as a scanner that found nothing.
No step may use `continue-on-error` or `|| true`.

**Merge blocking.** New **Critical** or **High** alerts introduced by a pull
request block that pull request, via the code-scanning merge-protection rule
in the `main` ruleset. Medium and Low alerts do not block; they are triaged
on the schedule below.

**Baseline.** The 41 High alerts present at commit `c33a150f` are
grandfathered — but only because every one of them was individually reviewed
in Sprint 22 with recorded evidence, and each carries an explicit GitHub
disposition. See
[sprint-22-codeql-alert-inventory.md](production-readiness/sprint-22-codeql-alert-inventory.md).
Grandfathering is a statement about *reviewed* alerts, never about *unread*
ones. There is no mechanism for an alert to age out of triage.

**Ownership and cadence.**

- Initial triage of a new alert belongs to the author of the pull request
  that introduced it, during review. A PR is not approvable with an
  untriaged Critical/High alert.
- Alerts from the weekly scheduled run (new queries applied to unchanged
  code) belong to the repository maintainer and are triaged within one week.
- Both paths produce the same artifact: a disposition on the alert, plus a
  findings-register entry when the outcome is anything other than a fix or a
  demonstrated false positive.

**Remediation urgency.** Critical and High: fix, or record an owned accepted
risk, before merge. Medium: within the current sprint. Low: recorded and
scheduled, no deadline.

**Evidence required to dismiss.** Every dismissal is individual and carries a
comment that a later reader can verify without re-deriving the analysis:

- *False positive* — the exact reason the dataflow does not hold: the real
  value reaching the sink, the control the query cannot model (with file and
  line), or the arithmetic that makes the operation safe. "Framework false
  positive" alone is not sufficient.
- *Won't fix / accepted risk* — rationale, compensating control, named owner,
  and a findings-register ID. Never label an accepted risk a false positive.
- *Used in tests* — only for genuine test-fixture code.

Bulk dismissal is prohibited. Reusing one generic comment across unrelated
alerts is prohibited. Dismissing to reach zero is prohibited.

**Duplicates and grouping.** Alerts sharing a cause are assigned a root-cause
group ID (`S22-RC-001`, …) in the inventory. Grouping organizes the analysis;
it does not reduce the work — every alert still gets its own row, its own
final classification, and its own dismissal comment naming its own route or
symbol.

**Framework-model false positives.** Orgistry's route handlers delegate to
services, and its limiters live in the service layer and in the API-key
authenticator, so `js/missing-rate-limiting` cannot see them. These are
dismissed individually with the limiter key and enforcing line. Note the
trap: this reasoning is only valid when a limiter genuinely exists. Sprint 22
found one route (`GET …/audit-events`) where the same argument would have
been wrong, and fixed it (ORG-PR-055). Verify per route; never dismiss a
rate-limiting alert by pattern.

**When GitHub cannot enforce the threshold.** Code-scanning merge protection
blocks on alert severity, not on a per-query allow-list, and it cannot
express "block new alerts but permit the reviewed baseline" beyond its own
new-vs-existing distinction. Where the desired policy exceeds what the
ruleset can express, the remainder is a documented manual control — stated
as such in the sprint artifact package, never described as enforced.

**Enforcement mechanism.** A repository ruleset targeting `main` (see
[Branch protection](#branch-protection)). If the ruleset is absent, this
policy is documentation only and the CodeQL gate is advisory — check
`gh api /repos/DanielRosenberg00/Orgistry/rulesets` before relying on it.

### Branch protection

`main` is governed by a repository ruleset (id `19769611`, "main branch
protection") rather than legacy branch protection. Enforcement is `active` with
**no bypass actors**. It:

- requires a pull request (direct pushes to `main` are refused);
- requires all six status checks — `Validate (offline)`,
  `Integration (PostgreSQL + Redis)`, `Artifacts (build + smoke)`
  (registered at Sprint 23 closure and API-verified), `Dependency audit
  (pnpm)`, `Secret scan (Gitleaks)`, `Analyze (javascript-typescript)`;
- enables code-scanning merge protection for CodeQL at
  `high_or_higher` security alerts and `errors` for tool failures;
- blocks branch deletion and non-fast-forward pushes.

`required_approving_review_count` is **0**, deliberately: on a
single-maintainer repository a non-zero count blocks every change, because an
author cannot approve their own pull request. Zero still forces the
pull-request path, which is what makes the status checks and merge protection
apply. Human review is therefore the one part of this gate that is **not**
technically enforced — raise this to 1 when a second maintainer joins.

Working-model consequence: commit directly to a branch, open a pull request,
let the six required checks run, then merge. `git push origin main` will be
rejected.

Verify the live configuration — documentation can drift, the API cannot:

```bash
gh api /repos/DanielRosenberg00/Orgistry/rulesets
gh api /repos/DanielRosenberg00/Orgistry/rulesets/<id>
```

### CI security policy

Stable guarantees introduced in Sprint 21 (ORG-PR-019/020) — do not weaken
these when editing workflows:

- **Every `uses:` is a full commit SHA** with the upstream version as a
  trailing comment (`uses: owner/action@<sha> # vX.Y.Z`). Never a tag or
  branch.
- **Every workflow declares explicit `permissions:`** — workflow-level
  `contents: read`; the ONLY wider grant in the repository is
  `security-events: write` (+ `actions: read`) on the single CodeQL analyze
  job, which uploads SARIF results.
- **Scanner failures must not be hidden** — no `|| true`,
  `continue-on-error`, or `--ignore-registry-errors` on any scanner step.
- **Accepted advisory exceptions are narrow and mirrored** — a GHSA goes in
  `pnpm.auditConfig.ignoreGhsas` (package.json) AND `osv-scanner.toml`, with a
  reachability analysis in the
  [findings register](production-readiness/findings-register.md). Never add a
  broad ignore.
- **Secret-scan allowlists live in `.gitleaks.toml` only**, per-value or
  per-fixture-file, each entry annotated with why it cannot be a live secret.
  Prefer rewriting a realistic-looking fixture to an unmistakable fake over
  allowlisting it.
- **CI installs with `--frozen-lockfile`**; the lockfile is only ever changed
  by pnpm commands.
- **No CI workflow publishes, deploys, or writes repository contents.**
  Dependency-update PRs (Dependabot) require human review; auto-merge is not
  configured and must not be enabled.
- **Routine CI never consumes a real credential.** No workflow reads a
  production runtime secret, an email-provider credential, or a
  secrets-manager credential; the repository has no configured Actions
  environments and no repository secrets. The three jobs run on fake,
  checked-in or generated values only. External email validation is a
  **manual, documented** procedure
  ([rotation-runbook.md](rotation-runbook.md#validate-external-email-delivery)),
  deliberately not a workflow: a provider-credentialed job would add a secret
  surface for no automation benefit at this stage. If one is ever added it must
  be manually dispatched, environment-scoped, unreachable from fork pull
  requests, minimally permissioned, and silent about secret values.

### Updating pinned actions

Dependabot (`.github/dependabot.yml`) proposes weekly pin bumps for the
`npm`, `github-actions`, and `docker-compose` (in `infra/` — the ecosystem
that discovers `docker-compose.yml`; there are no Dockerfiles) ecosystems.
The CI service-container images in `ci.yml` are **not** covered by any
Dependabot ecosystem — bump them by hand in the same PR whenever a
`docker-compose` update PR lands, keeping the two in sync (the runbook's
image table notes the same). Reviewing an Action pin PR:

1. Confirm the new SHA matches the claimed upstream release:
   `git ls-remote https://github.com/<owner>/<action>.git refs/tags/<version> 'refs/tags/<version>^{}'`
   — for annotated tags use the `^{}` (dereferenced commit) value; that commit
   SHA is what belongs in `uses:`.
2. Read the upstream release notes for permission or behavior changes.
3. Check the version comment was updated alongside the SHA.
4. Run `actionlint` (`brew install actionlint`) on the branch.

The same `git ls-remote` procedure is used to add a new action: never copy a
SHA from a blog post or invent one.

## Interpreting failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `typecheck` fails | Type error or unused local/param | Read the `tsc` error; fix the type or prefix an intentionally-unused binding with `_`. |
| `lint` fails | ESLint error | Run `pnpm lint` for the report; `pnpm lint:fix` auto-fixes mechanical issues. |
| `db:check` fails | Schema edited without regenerating migrations | `pnpm db:generate`, review, commit. |
| `check:whitespace` fails | Trailing whitespace / space-before-tab | Strip the offending whitespace shown by `git diff --check`. |
| `test:integration` skipped | Missing `TEST_DATABASE_URL` / `REDIS_URL` | Set env (`cp .env.example .env`) and ensure `pnpm infra:up` is healthy. |
| `db:reset:test` refuses to run | `TEST_DATABASE_URL` unset or equals `DATABASE_URL` | Point `TEST_DATABASE_URL` at a distinct database. |
| Integration tests fail to connect | Port conflict on 5432 / infra down | See [troubleshooting](./troubleshooting.md). |
| `scan:deps` / CI dependency audit fails | A new high/critical advisory in the dependency tree | Upgrade the affected package (in-range first: `pnpm update -r --depth Infinity <pkg>`); only if no compatible fix exists, record a reachability analysis in the findings register and add the GHSA to `pnpm.auditConfig.ignoreGhsas` + `osv-scanner.toml`. |
| `pnpm audit` errors with a JSON/gzip parse failure | Network layer mangles the registry audit response (seen on some local setups) | Use `pnpm scan:deps:local` (osv-scanner) locally; CI is unaffected. |
| `scan:secrets` / CI secret scan fails | A suspected live secret in tracked content | If live: rotate it immediately and purge it. If a fixture: rewrite it to an unmistakable fake; allowlist in `.gitleaks.toml` only when rewriting is impossible, with an annotation. |

See the [troubleshooting guide](./troubleshooting.md) for environment-level
failures (Docker not running, port conflicts, stale Drizzle artifacts, CI
service containers).
