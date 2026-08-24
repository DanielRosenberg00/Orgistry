# Sprint 26 Artifact Package — Production Deployment Environment and Promotion Pipeline

**Sprint:** 26 · **Finding:** ORG-PR-001 (P1, production blocker) ·
**Executed:** 2026-08-24 · **Branch state at writing:** local, uncommitted.

**Headline outcome.** The promotion and deployment MECHANISM is implemented,
readable, and rehearsed end to end locally. **No finding is closed.** That is
the specification-permitted outcome for a sprint whose closure criteria depend
on infrastructure that does not exist: Orgistry still has no deployment target,
nothing has been published to any container registry, and neither new workflow
has ever executed on GitHub Actions.

Four things this artifact keeps strictly apart, because they are routinely
conflated:

```
deployment mechanics implemented   — YES (this sprint)
deployment target validated        — NO  (no target exists)
staging readiness                  — NO
production readiness               — NO
```

---

## 1. Implementation summary

| Area | Delivered |
| --- | --- |
| Registry publishing | `.github/workflows/release.yml` — runs the artifact smoke gate itself, then publishes the images that gate produced to `ghcr.io/<owner>/orgistry-{api,web}` under an immutable commit-SHA tag, captures their registry digests, generates and validates the release manifest, uploads it as a workflow artifact, and writes a non-secret release summary |
| Release identity | `tooling/lib/release-manifest.mjs` + `tooling/release-manifest.mjs` — the manifest model, its schema validation, and a `generate`/`validate`/`read` CLI with no dependencies |
| Deployment topology | `infra/compose.deploy.yml` — API, web, and a profile-gated one-shot migration service; images by digest; **no `build:` section anywhere**; PostgreSQL/Redis/SMTP deliberately absent (operator-provided) |
| Configuration contract | `infra/deploy.env.example` — the non-secret `deploy.env`, referencing (never duplicating) the runtime contract, with every runtime secret confined to a separate 0600 file |
| Deployment execution | `tooling/deploy.sh` — thirteen named stages from manifest validation to evidence, with a backup preflight, migrate-exactly-once, verified applied migration head, staged API-then-web rollout, readiness gating, running-digest verification, and mandatory smoke |
| Post-deployment validation | `tooling/deploy-smoke.sh` — eight URL-only checks, reusable against any reachable deployment |
| Deployment evidence | `tooling/lib/deploy-evidence.mjs` + `tooling/deploy-evidence.mjs` — an append-only per-environment ledger with `record`/`rollback-target`/`current`/`validate` |
| Rollback | `tooling/deploy-rollback.sh` — redeploys the previous known-good digests from that release's own manifest, stored on the host |
| Deployment authorisation | `.github/workflows/deploy.yml` — manual, environment-bound, read-only; validates a release, refuses an ungated one, proves both digests resolve, emits the deployment plan |
| Rehearsal | `tooling/deploy-rehearsal.sh` + `.github/workflows/deployment-rehearsal.yml` — the whole lifecycle against a throwaway registry and throwaway services |
| Shared shell layer | `tooling/lib/deploy-common.sh` — stage reporting, a non-executing config parser, HTTP probes, digest helpers |
| Release authorization | `.github/workflows/release.yml` `gates` job + `tooling/lib/release-gates.mjs` + `tooling/release-gates.mjs` — proves all six required checks succeeded for the exact release SHA, with a bounded wait and explicit pending/failed outcomes |
| Runtime public configuration | `apps/web-demo/src/public-config.ts`, `apps/web-demo/nginx.conf.template`, `apps/web-demo/public/public-config.js`, and a web Dockerfile with **no build arguments** — the browser's environment identity moved from build time to container start |
| Tests | `tooling/release-manifest.test.ts` (30), `tooling/release-gates.test.ts` (10), `tooling/deploy-evidence.test.ts` (19) inside `pnpm test`; `apps/web-demo/src/public-config.test.ts` (16) inside `pnpm test:web` — all inside the required checks |
| Documentation | `docs/deployment.md` (new, authoritative); updates to `deployment-artifacts.md`, `runbook.md`, `validation.md`, `known-limitations.md`, the root `README.md`, and every production-readiness source of truth |

Incidental fixes surfaced by executing the above (see §17):
`tooling/db-backup.sh` could not back up a database with no migration ledger;
`pg_start_server` in `tooling/lib/pg-tools.sh` failed under `set -u` on bash 3.2
with no extra Docker arguments; the shell entry points did not tolerate the bare
`--` that `pnpm run <script> -- --flag` forwards; and the `deploy` package script
was shadowed by pnpm's built-in `deploy` command (renamed `deploy:run`).

## 2. Deployment target decision

**Selected: single-host Docker Compose deployment, operator-executed, promoted
by immutable image digest.**

Rationale, in order of weight:

1. [production-target.md](production-target.md) ratified (DG-1) a self-hosted,
   single-region, low-scale profile operated by a small team, and states that
   the recommended architecture is "the simplest architecture that satisfies
   this profile — explicitly **not** Kubernetes".
2. The repository already had the pieces: two production-shaped images, an
   explicit one-shot migration entrypoint, and a compose-based validation
   topology (Sprint 23).
3. The same scripts run identically on a workstation, a VPS, and any host that
   accepts a Compose file, so the choice does not bind the project to a vendor.

**Reachability: none.** No host, no provider account, no deployment credential,
and no GitHub Environment exist. Per the sprint specification's instruction for
that case, the sprint implemented registry publishing, immutable release
manifests, deployment scripts and contracts, an operator-run deployment path,
and every locally provable deployment invariant — and records plainly that
target execution and rollback against a real environment remain unvalidated.

| Question | Answer |
| --- | --- |
| Target type | Single-host Docker Compose, operator-executed |
| Staging-like or reference? | **Deployment reference plus registry promotion.** A staging-like environment is what it becomes once a host exists |
| Can CI reach it? | No. CI performs authorisation, release verification, and the deployment plan; the operator performs execution |
| Required secrets | Runtime secrets in a 0600 operator file (or `<NAME>_FILE` mounts); a GHCR pull credential if packages stay private; **none of these exist** |
| Managed dependencies | PostgreSQL, Redis, SMTP, TLS termination — all operator-provided, all absent |
| Reference/local-only dependencies | The rehearsal's throwaway registry, PostgreSQL, and Redis |
| Operational limitations | No TLS/DNS/proxy, no observability, no backup schedule, no secret store, one web image per API origin |

**Rejected alternatives** (all genuinely considered; none invented for the
record):

- **Kubernetes/Helm** — rejected by the ratified target profile; a control plane
  and manifest toolchain for a single-operator deployment that needs neither.
- **An SSH-from-CI deploy job** — a job that connects to a host that does not
  exist could never be run or reviewed against reality, and would read as a
  deployment pipeline the project does not have. The executable path is instead
  an operator-run script that the rehearsal exercises end to end.
- **A managed container platform (Fly/Render/App Runner)** — viable, and the
  release half is provider-neutral, but no account, credential, or budget
  exists; choosing one would have produced provider configuration nobody could
  execute.
- **Docker Hub instead of GHCR** — GHCR needs no extra account and no
  long-lived credential; the workflow's own `GITHUB_TOKEN` suffices and expires
  with the job.

## 3. Environment taxonomy

Five names, defined once in [../deployment.md](../deployment.md#environment-taxonomy)
with a full attribute table (purpose, operator, data classification, real-user-data
policy, secrets source, email behavior, backup behavior, deployment trigger,
required gates, rollback model, what "ready" means, limitations) and used
consistently across the whole documentation set:

```
local development
repository validation
production-like local validation
staging-like deployment target      (does not exist)
production deployment target        (does not exist)
```

plus `rehearsal-local`, the throwaway environment the rehearsal creates and
destroys. The taxonomy exists to prevent exactly three false equivalences,
which are stated in the document as such:

```
production-like local Compose  !=  staging
staging-like deployment        !=  production
a successful deployment        !=  production readiness
```

## 4. Registry publishing summary

- Images: `ghcr.io/<owner>/orgistry-api` and `ghcr.io/<owner>/orgistry-web`,
  owner resolved from `github.repository_owner` and lowercased — never
  hard-coded.
- Tag: the full commit SHA. Immutable by convention and enforced by the manifest
  schema (`images.*.tag` must equal `source.commit`).
- Digests captured from `RepoDigests`, selecting the entry for the intended
  repository explicitly rather than by position.
- `latest` is never produced, and no mutable tag is authoritative anywhere.
- Base-image digest pinning (ORG-PR-042) is untouched.
- No secret enters an image build; the web image's only build argument is the
  public API origin.
- Never triggered by `pull_request`, so untrusted forks and unreviewed PR code
  cannot publish.
- **Publication is authorised per source SHA.** A dedicated `gates` job resolves
  the actual workflow runs for the exact release commit and requires all six
  required checks — `Validate (offline)`, `Integration (PostgreSQL + Redis)`,
  `Artifacts (build + smoke)`, `Dependency audit (pnpm)`,
  `Secret scan (Gitleaks)`, `Analyze (javascript-typescript)` — to have
  concluded `success` at JOB granularity, the granularity branch protection
  uses. Their run IDs go into the manifest; the validator binds them to
  `source.commit`. "The commit is on main" is not accepted as evidence.
- **A published release must be exactly its commit**: the publish job asserts a
  clean checkout, and the schema refuses a deployable release with working-tree
  provenance.
- Permissions: workflow-level `contents: read`; `actions: read` on the gate job
  only; `packages: write` on the publish job only — neither job can perform the
  other's action. Credential: the job's own short-lived `GITHUB_TOKEN`, piped to
  `docker login --password-stdin`.
- Package visibility is an operator decision and is documented as an unperformed
  external action (§16 of [../deployment.md](../deployment.md#external-and-operator-only-configuration)).

**Not validated:** the workflow has never run. No image exists in GHCR, so GHCR
authentication, package creation, visibility, and pull-from-host are all
unproven. The publishing *mechanics* (build → push → digest capture → manifest)
are proven against a local OCI registry by the rehearsal.

## 5. Image identity and digest policy

The invariant, and the four independent places it is enforced:

```
The deployed image MUST be the previously built and validated image.
```

1. **Manifest schema** — `images.*.reference` must be exactly
   `<repository>@<digest>`; a tag-pinned reference is invalid.
2. **Deployment assertion** — `tooling/deploy.sh` refuses any reference without
   `@sha256:` before doing anything else.
3. **Topology** — `infra/compose.deploy.yml` has no `build:` section, and the
   deployment asserts that by inspecting the file before invoking Compose. A
   target cannot rebuild source even by accident.
4. **Runtime check** — after startup, each running container's image ID is
   compared against the ID the manifest's digest resolves to.

Neither image is rebuilt for publication: both images the artifact gate
validated are re-tagged, and `docker tag` cannot change image content.

**Both images are environment-neutral.** The refinement pass removed the last
exception: the web image no longer compiles its API origin into the bundle. The
browser's public configuration is served at runtime from `ORGISTRY_PUBLIC_*`
container variables, so one validated web digest is promotable between
environments rather than rebuilt for each. `images.web.apiBaseUrl` was deleted
from the manifest schema, and the schema now **refuses any field on an image
identity beyond repository, tag, digest, and reference** — deployment
configuration cannot get back in.

An operator verifies what is running with
`pnpm deploy:evidence current --dir <ledger> --environment <env>`, or directly
with `docker inspect` against the compose project.

## 6. Release manifest model

Schema, field-by-field rules, and the two design decisions behind it are in
[../deployment.md](../deployment.md#release-manifest). The decisions worth
repeating here:

- **Migration identity is derived, not supplied.** `head`, `count`, and
  `appliedAtMs` come from `packages/db/migrations/meta/_journal.json`, so a
  manifest cannot claim a migration head its images do not contain.
- **Build-time and deployment-time evidence are separate records.** A manifest
  holds only facts that exist when it is written; a "deployment result" field
  would be permanently null or a lie. Deployment outcomes live in the evidence
  ledger.
- **`build` is omitted entirely** when there is no workflow provenance, rather
  than filled with placeholder run IDs. No workflow run ID is ever invented.
- **A manifest declares what it is.** `release.type` (`published` | `rehearsal`)
  and `release.deployable` must agree, `source.provenance` (`commit` |
  `working-tree`) says how the source bytes are addressed, and a published
  release may not claim working-tree provenance.
- **A published release carries the gate evidence that authorised it**, bound to
  its own commit; a rehearsal carries none and may not.

Schema version 2 (refinement pass) is the result of the first two corrections.
- **No secrets, actively.** Validation refuses a URL with inline credentials or
  an inline credential assignment anywhere in the document.

Malformed and incomplete manifests are detected by `validate`, which reports
every problem at once rather than the first.

## 7. Deployment workflow summary

Two halves, because only one of them can run today.

**`.github/workflows/deploy.yml` (CI half, manual dispatch, environment-bound,
read-only):** downloads the named release run's manifest, validates it, refuses
a release whose `build.artifactSmoke` is not `passed`, proves both digests still
resolve in the registry, and writes the deployment plan plus the exact operator
commands to the job summary. Permissions: `contents: read`, `actions: read`,
`packages: read`. Concurrency is keyed per environment.

**`tooling/deploy.sh` (target half, operator-run):** the thirteen stages listed
in [../deployment.md](../deployment.md#toolingdeploysh--execute-on-the-target-runs-on-the-host),
each named in its own failure message. There is no `--skip-smoke`.

Neither is a required pull-request check, and none of the six existing required
checks changed. The deterministic half of the new tooling *is* enforced on every
pull request, because its unit tests run inside `pnpm test`.

## 8. Migration execution model

```
pre-deployment validation
  -> backup / recovery-point preflight (taken, or skipped WITH a reason)
  -> migration artifact runs ONCE, from the release's own API image
  -> applied head verified against the release manifest
  -> API -> web -> readiness -> smoke -> evidence
```

- Single owner, single run: the migration service is behind a Compose profile
  and is invoked only as `docker compose run --rm --no-deps migrate`. The API
  still never migrates at boot, so no replica can race it.
- Failure blocks the deployment before any application container starts; the
  previously running release is untouched.
- The applied head is **verified, not assumed**: Drizzle's ledger row count and
  newest `created_at` must match the manifest's `count` and `appliedAtMs`. This
  catches a database that is behind, ahead, or from a different lineage, without
  parsing SQL and without adding schema.
- Repeated deployment is safe; the rehearsal deploys twice deliberately.
- Migration rollback is **not** claimed anywhere. Migrations are forward-only.

## 9. Post-deployment smoke evidence

`tooling/deploy-smoke.sh`, nine checks, all executed in the rehearsal and all
passing (`DEPLOY SMOKE OK: 9 checks passed.`), on every deployment:

1. `/health` returns the `{"status":"ok"}` envelope.
2. `/ready` returns the `{"status":"ready"}` envelope.
3. `/ready` discloses no dependency name — the production disclosure policy
   holds on the deployed instance.
4. Six baseline security headers are present on an API response.
5. A client-supplied `x-request-id` is echoed unchanged.
6. The web artifact serves a production build, not a dev server.
7. The SPA history fallback resolves a client route.
8. The deployment applied the expected PUBLIC browser configuration, read back
   from `/public-config.js`.
9. The environment's API origin does **not** appear in the immutable bundle —
   the regression test for promotability, skipped only when the environment uses
   the image's built-in localhost default, where its presence would prove
   nothing either way.

Deliberately not performed, with reasons recorded rather than checked off: no
authenticated request (no dedicated safe test tenant or API key exists in any
environment, and creating a production credential to satisfy a checklist would
be worse than an unproven check); no migration-head check (that needs the
database, and this command must stay runnable from anywhere that can reach the
URLs — `tooling/deploy.sh` does it at stage 7); and no response bodies in the
output.

## 10. Rollback evidence and its limits

**Executed and passing, in the rehearsal.** After deploying release A, then
release B over it, `tooling/deploy-rollback.sh` resolved A as the previous
known-good release and redeployed it. Asserted afterwards: the evidence mode is
`rollback`; `migration.result` is `skipped`; smoke passed again; the recorded
runtime digests are A's; and the **running containers' image IDs** match A's
manifest references — checked against Docker, not against our own records.

**Limits, stated plainly:**

- The two rehearsal releases are built from the same source and differ only by
  an image label. The rollback proves digest switching, not behavioral
  difference.
- It ran on one machine, against a throwaway database, with no traffic, no TLS,
  and no proxy.
- Rollback in a long-lived environment with real users is **untested**, and will
  remain so until a target exists.
- **Application rollback restores image digests, not configuration.** The
  environment's public browser configuration is applied fresh from the
  deployment configuration file, so a rollback across a configuration change
  restores old code under the current configuration. `deploy-rollback.sh` prints
  the public API origin recorded for the target release and says explicitly when
  the environment's current value differs, so it is a visible decision rather
  than a silent second change.
- **Application rollback is not database rollback.** Redeploying older
  containers restores older code against the current schema. Undoing a
  destructive schema change is a restore or a PITR — a recovery operation that
  loses data written after the recovery point, and one that no deployed
  environment can perform today because nothing produces backups on a schedule.

The rollback selection rule is worth recording because it changed during the
sprint: "the most recent other release whose smoke passed" would have restored
the release the previous rollback was escaping, since a bad release usually
passes smoke. The rule now also excludes any release that has already been
rolled away from, and returning "no rollback target" is treated as a legitimate
answer meaning fix forward or recover.

## 11. Backup/PITR integration boundary

Implemented: a labelled pre-migration backup using the real
`tooling/db-backup.sh`, whose artifact name and recovery point are recorded in
the deployment evidence; deployment aborts before migrations if the backup
fails, leaving the target unchanged; and a skip requires a recorded reason,
because an unexplained skip is indistinguishable from an oversight during an
incident. A rollback skips the preflight automatically, with that recorded.

Not implemented, and why: **WAL-archival health verification** — there is no
long-lived archiving database to verify. When one exists, the check belongs in
this stage and its result in the same record.

What cannot be verified until real production backup infrastructure exists:
that backups are scheduled, stored off-host, and encrypted; that a restore meets
the ratified RTO at production data volume; and that WAL archiving delivers the
ratified RPO. **ORG-PR-005 is not closed and is not closer to closure.**
Deployment-time integration is not a backup programme.

## 12. Deployment secret handling

Preserved from Sprint 24: runtime-only secrets; no secret build args; no secret
in an image layer; `<NAME>_FILE` support intact; unmistakably fake documentation
and fixture values.

Added and enforced this sprint:

- The runtime configuration file must be mode **0600** — proven by a rehearsal
  negative check that deploys against a `0644` file and requires failure.
- The deployment reads exactly one secret for itself (`DATABASE_URL`, honouring
  `DATABASE_URL_FILE`), keeps it in a shell variable, and passes it only through
  a container environment variable — never a command-line argument, a filename,
  or a log line.
- `docker compose config` is never invoked anywhere: it expands `env_file`
  entries into plaintext.
- The release manifest and every evidence record are validated against a
  credential-shape guard.
- No workflow reads a production runtime secret. Publishing uses the job's own
  short-lived token; the deployment workflow is read-only everywhere;
  `pull_request` cannot reach either.
- Environment-scoped protection is *declared* (`environment:` in `deploy.yml`)
  and **not configured** — recorded as an external operator action, not as a
  control in place.
- The refinement pass added a **public** configuration channel to the browser.
  It is guarded on both sides: the application refuses to start if the runtime
  object carries a credential-shaped key (`secret`, `password`, `token`,
  `apiKey`, …), and the evidence ledger refuses to record anything outside the
  published public contract (`apiBaseUrl`, `csrfHeaderName`, `mailpitUrl`).
- `eval` was removed from the rollback path: the ledger now exposes one named
  field per call, so no value from evidence can be interpreted as a command.

**ORG-PR-006 is not closed.** There is still no secret store, no least-privilege
secret access control, no read auditing, no automated rotation or expiry
tracking, and no rotation rehearsed against a real runtime.

## 13. Local validation evidence

Every command below was executed on the validated tree on 2026-08-24.

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm validate` | **PASS** | typecheck → lint → 1013 unit tests in 90 files → 94 web tests in 11 files → web build → schema-drift ("migrations are in sync") → whitespace, all exit 0 |
| `pnpm test` (inside `validate`) | **PASS** | 1013/1013, including 59 deployment-contract tests |
| `pnpm test:web` (inside `validate`) | **PASS** | 94/94, including 16 runtime public-configuration tests |
| `pnpm validate:integration` | **PASS** | `apps/api` 103 tests in 16 files; `packages/db` 16 tests in 1 file. Run against PostgreSQL on host port **55432** (see §16 — port 5432 is held by an unrelated local Postgres) with Redis on 6379 |
| `git diff --check` (`pnpm check:whitespace`) | **PASS** | no whitespace errors |
| `pnpm scan:deps` | **PASS** | prod audit: 1 high, **ignored** by the documented `pnpm.auditConfig.ignoreGhsas` acceptance; dev audit: no known vulnerabilities |
| `pnpm scan:deps:local` | **PASS** | osv-scanner: "No issues found"; the react-router acceptance is filtered with its recorded reachability analysis |
| `pnpm scan:secrets` | **PASS** | gitleaks over 51 commits, ~5.18 MB, **no leaks found** |
| `gitleaks dir tooling infra .github` | **PASS** | supplementary run covering the sprint's **untracked** new files, which a git-history scan cannot see: ~15.4 MB, no leaks |
| `actionlint` | **PASS** | exit 0 across all seven workflows |
| `tooling/artifact-smoke.sh` | **PASS** | "SMOKE OK: all artifact checks passed" — including the new promotability check that runs ONE web image as two different API origins |
| `tooling/db-restore-drill.sh` | **PASS** | "Restore drill PASSED (data-layer verification)" — re-run after the `db-backup.sh` fix |
| `tooling/db-restore-drill.sh --with-artifact` | **PASS** | "Restore drill PASSED (data-layer + packaged-artifact verification)" |
| `tooling/db-pitr-drill.sh` | **PASS** | "PITR drill PASSED" — mandatory here because `tooling/lib/pg-tools.sh` was modified |
| `pnpm release:manifest validate` | **PASS** | exercised by the rehearsal on every generated manifest, and negatively on a doctored tag-pinned copy |
| **`pnpm deploy:rehearsal`** | **PASS** | "DEPLOY REHEARSAL OK" — full evidence below |

### Deployment rehearsal — recorded run

Release identity: commit `0ec6ea2f207269206df78ba2ad12bdef2df478b7`, migration
head `0012_shocking_warbound` (13 migrations). Release A resolved to
`127.0.0.1:5001/orgistry-api@sha256:3bbbc5f63c3b…` and
`127.0.0.1:5001/orgistry-web@sha256:6830cb71d44c…`; release B produced different
digests from identical source (the harness asserts they differ, and fails the
run if they do not). Digests are from a throwaway registry destroyed on exit and
are recorded as run evidence, not as reproducible identifiers.

Verified in that run:

- three refusals: a tag-pinned manifest is rejected by validation; a web image
  built for another API origin is refused before deployment; a `0644` runtime
  configuration file is refused;
- deployment of release A: backup preflight `taken` with a recorded recovery
  point, migrations `applied`, verified head `0012_shocking_warbound`, readiness
  reached, smoke `8 checks passed`, evidence written, and the **running**
  container image IDs equal to A's manifest digests;
- deployment of release B over A, with migrations re-run as a no-op and the head
  re-verified; the evidence names A as the rollback target;
- rollback to A: mode `rollback`, migrations `skipped`, smoke passed again, and
  the running containers back on A's exact digests;
- the ledger is self-contained: both deployed release manifests are stored on
  the "host" so a future rollback needs no registry or workflow artifact.

Everything the rehearsal creates — containers, volumes, network, registry, and
the temporary 0600 runtime configuration file holding its fake credentials — is
removed on exit.

### Validation not run, and why

| Item | Status | Reason | Repository-side or external? | What would complete it |
| --- | --- | --- | --- | --- |
| Real GHCR publication | **BLOCKED** | The release workflow triggers on a push to `main`; this sprint is uncommitted by instruction, and the local `gh` token lacks `write:packages` | External (operator) | Merge the sprint, let `release.yml` run, then `gh api /users/<owner>/packages?package_type=container` |
| Deployment to a real target | **BLOCKED** | No host, provider account, or deployment credential exists | External (procurement/operator) | Provision a target per [../deployment.md](../deployment.md#remaining-staging-blockers) and run `tooling/deploy.sh` there |
| Rollback on a real target | **BLOCKED** | Same | External | Two deployments plus `tooling/deploy-rollback.sh` on that target |
| Remote runs of `Release`, `Deploy`, `Deployment rehearsal` | **NOT RUN** | Requires pushing a branch; the sprint specification forbids committing or pushing without explicit instruction | Repository-side, gated on operator instruction | Push the branch and dispatch each workflow (§14) |
| GitHub Environment protection | **NOT CONFIGURED** | Cannot be represented in the repository | External (operator) | Create the environment and reviewers, then `gh api /repos/<owner>/<repo>/environments` |
| Live external email through a real provider | **BLOCKED** | Unchanged since Sprint 16; no provider credentials, verified domain, or test mailbox | External | ORG-PR-002's documented procedure |
| Backup schedule / WAL archival health | **NOT RUN** | No long-lived database archives WAL; there is nothing to check | External, gated on a target | ORG-PR-005's remaining work |

No validation step was silently skipped.

## 14. Remote validation evidence

**None. No remote validation has been performed for this sprint.** The work is
uncommitted, so there is no commit for GitHub to run, and no run ID exists for
any workflow. No run ID, status, or green claim is manufactured anywhere in this
package.

What the four existing pull-request workflows will exercise unchanged on merge:
`Validate (offline)` (now including the 29 new deployment-contract tests),
`Integration (PostgreSQL + Redis)`, `Artifacts (build + smoke)`,
`Dependency audit (pnpm)`, `Secret scan (Gitleaks)`, and
`Analyze (javascript-typescript)`.

Operator commands to obtain the missing evidence, in order:

```sh
# 1. Open the pull request and let the six required checks run.
gh pr create --fill
gh pr checks --watch

# 2. After merge, the Release workflow runs on the push to main.
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log
gh api "/users/$(gh api /user --jq .login)/packages?package_type=container"

# 3. Verify the published digests independently of the manifest.
docker buildx imagetools inspect ghcr.io/<owner>/orgistry-api:<commit-sha>

# 4. Exercise the deployment-verification workflow against that release.
gh workflow run deploy.yml -f environment=staging-like -f release_run_id=<run-id>
gh run list --workflow=deploy.yml --limit 3

# 5. Exercise the rehearsal remotely (proves it is not machine-specific).
gh workflow run deployment-rehearsal.yml
gh run list --workflow=deployment-rehearsal.yml --limit 3

# 6. Confirm branch protection is unchanged.
gh api /repos/<owner>/Orgistry/rulesets/19769611
```

Until step 2 succeeds, the correct statement is: **no Orgistry image has ever
been published to any registry.**

## 15. Findings reconciliation

| Finding | Status | Evidence basis |
| --- | --- | --- |
| **ORG-PR-001** | **OPEN — materially advanced (second time)** | Mechanism implemented and rehearsed end to end locally (§13). Closure criterion — "a tagged build deploys to a target environment reproducibly" — is **not met**: no target exists, nothing published, no remote workflow run, rollback validated only locally |
| **ORG-PR-002** | **OPEN** | Out of scope this sprint and untouched. External provider, verified sending domain, and a test mailbox are still absent |
| **ORG-PR-005** | **OPEN** | Deployment-time backup integration added (labelled pre-migration backup, recorded recovery point, abort-on-failure, no unexplained skips). Nothing schedules, stores off-host, or encrypts a backup; no WAL archiving on a long-lived database; no measured RPO/RTO. Repository integration documentation is explicitly insufficient for closure |
| **ORG-PR-006** | **OPEN** | Deployment-side secret *handling* enforced (§12). No secret store, no access control, no auditability, no automated rotation, no rehearsed rotation. GitHub Environment secrets are declared but not configured, and would satisfy only the injection half |
| ORG-PR-042 | Closed (Sprint 23), unaffected | The two new pinned images (`registry:3.0.0`, `redis:7.4.10-alpine` in the rehearsal) follow the same tag+digest policy; `infra/compose.deploy.yml` deliberately has no pinned literals because its images come from a release manifest |
| ORG-PR-028 | Unchanged | The bad-migration rehearsal still needs a real environment |
| ORG-PR-016 | Unchanged | Nothing here schedules anything |

No other finding's status changed.

## 16. Remaining blockers

**To close ORG-PR-001 (all external):** a host that can run Docker Compose; a
managed or operated PostgreSQL and Redis; a real SMTP provider (the production
config guard refuses to boot without one); TLS termination and a public origin;
a GHCR package the host can pull; and a GitHub Environment with its protections.
Full list: [../deployment.md](../deployment.md#remaining-staging-blockers).

**Repository-side, gated only on operator instruction:** commit, push, and merge
this sprint so the release workflow can run and the three new workflows can be
exercised remotely.

**Environment note for future validation runs:** host port 5432 is held by an
unrelated local PostgreSQL, so integration validation on this machine runs
against an alternate-port container (55432). This is a workstation condition,
not a repository defect, and CI is unaffected.

**Production blockers beyond staging** are unchanged and are listed in
[../deployment.md](../deployment.md#remaining-production-blockers).

## 17. Scope-control confirmation

Delivered strictly inside the sprint boundary. Explicitly **not** introduced:
production traffic, a public launch, DNS cutover, TLS/WAF/CDN work, production
email-provider closure, sender-domain work, a secrets-management platform,
automated secret rotation, production backup scheduling, encrypted remote backup
infrastructure, observability dashboards, an incident-response platform,
artifact signing, SLSA provenance, Kubernetes, multi-region, autoscaling,
product features, or any auth/authorization/retention redesign.

Four changes touched code outside the new deployment files. Each was surfaced by
executing this sprint's own work, and each is a defect fix rather than an
enhancement:

1. **`tooling/db-backup.sh`** could not back up a database with no migration
   ledger. PostgreSQL resolves relation names at parse time, so the existing
   `coalesce((SELECT count(*) FROM drizzle.__drizzle_migrations), 'null')`
   guard could never run — the statement failed outright. The comment above it
   already stated the intended behavior ("recorded as `null` rather than
   guessed"); the fix restores that intent with a separate `to_regclass`
   existence check. This is squarely on the first-deployment path: the
   pre-migration backup of an empty database.
2. **`tooling/lib/pg-tools.sh`** — `pg_start_server` expanded `"${docker_args[@]}"`
   unguarded, which is an unbound-variable error under `set -u` on bash 3.2 (the
   system bash on macOS) when a caller passes no extra Docker arguments. The
   `+`-guard already applied to `server_args` two lines below was added to
   `docker_args`. Every existing caller passed arguments, so the path had never
   been exercised.
3. **Bare `--` tolerance** in the `tooling/` shell entry points. `pnpm run
   <script> -- --flag` forwards a literal `--` under pnpm 10, so the documented
   `pnpm drill:restore -- --with-artifact` had been failing. The retention CLI
   already handled this; the shell scripts now match it.
4. **`deploy` → `deploy:run`** in `package.json`, because `pnpm deploy` is a
   built-in pnpm command that shadows a package script of that name.

All three durability drills and the artifact smoke gate were re-run after (1)
and (2) and pass.

One idea was deliberately **recorded rather than implemented**: publishing an
SBOM and signing images alongside the release, which belongs with SLSA/provenance
work and is explicitly out of scope.

### Refinement pass (same day)

A review found three release-integrity defects. All three were fixed without
changing the deployment architecture — the target model, registry, digest
promotion, migrate-once lifecycle, evidence ledger, rollback semantics, secret
model, and finding statuses are all unchanged.

1. **The web artifact was not truly promotable.** `VITE_API_BASE_URL` was
   compiled into the bundle, so the first implementation recorded the baked
   origin in the manifest and refused a mismatch. Safe, but it meant one
   validated web digest could not move between environments — a contradiction of
   the sprint's own central invariant. The browser's public configuration now
   arrives at runtime and `images.web.apiBaseUrl` is gone. This is the one
   correction that touched the application: a new
   `apps/web-demo/src/public-config.ts` boundary, a `config.ts` that consumes it
   (every existing consumer unchanged), an added script tag, an nginx template,
   and a web Dockerfile with no build arguments. No frontend redesign.
2. **Rehearsal provenance could be mistaken for a release.** Manifests now carry
   `release.type` and `source.provenance`; a dirty tree is `working-tree` with a
   content fingerprint and can never be deployable.
3. **Publication was not tied to the required checks for the release SHA.** A
   `gates` job now proves it, and the manifest records the run IDs.

Two supporting changes: `eval` was removed from the rollback path in favour of
named-field reads, and `eslint.config.js` gained a four-line block so the one
static browser asset (`apps/web-demo/public/public-config.js`) lints with
browser globals instead of being ignored.

## 18. Final readiness classification

```
Deployment mechanics implemented   YES   (rehearsed end to end, locally)
Deployment target validated        NO    (no target exists)
Staging readiness                  NO
Production readiness               NO

C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Four P1 blockers remain open: ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006.
Sprint 26's own Definition of Done is met for every category the repository can
satisfy; that is not launch clearance, and a successful deployment would not be
either.

The refinement pass **did not move any of this**. It removed the last structural
obstacle to promotion-by-digest, made rehearsal output impossible to confuse with
a release, and tied publication to the required checks for the exact release SHA
— all repository-side corrections. No target was provisioned, nothing was
published, and no workflow ran remotely.

## 19. Recommended next sprint

**Deployment Pipeline Closure (ORG-PR-001).**

Provision the smallest real staging-like target that satisfies the
[staging blockers](../deployment.md#remaining-staging-blockers); merge this
sprint so the release workflow runs and images genuinely exist in GHCR; create
the `staging-like` GitHub Environment with its protections; deploy that release
to the target; roll it back; and record the evidence. That converts every
mechanism built here from *rehearsed* to *executed* and closes ORG-PR-001 on its
own criterion.

Chosen over the alternatives on dependency grounds: ORG-PR-001 blocks the
deployment-dependent half of ORG-PR-005, ORG-PR-006's rehearsed rotation,
ORG-PR-028's bad-migration rehearsal, ORG-PR-007, and ORG-PR-008 — and Sprint 26
leaves it needing exactly one thing the repository cannot supply. Its
prerequisite is an operator/procurement decision, not a code change.

**If that decision is unavailable,** the correct alternative is **External Email
Provider Closure and Secrets Platform Integration (ORG-PR-002 + ORG-PR-006)**,
whose blockers are procurement of a different kind and which does not wait on a
host. **Production Backup Scheduling and Recovery Operations** should not be
attempted before a target exists: there would be nothing to schedule a backup
of.
