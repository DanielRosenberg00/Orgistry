# Sprint 26 Artifact Package — Production Deployment Environment and Promotion Pipeline

**Sprint:** 26 · **Finding:** ORG-PR-001 (P1, production blocker) ·
**Executed:** 2026-08-24 · **Merged:** PR
[#38](https://github.com/DanielRosenberg00/Orgistry/pull/38), merge commit
`91664d0fd639ca6ca8b5681317757bbcf0f0209b` ·
**Remote validation:** complete (§14).

**Headline outcome. Sprint 26 DoD is MET; no finding is closed.** The promotion
and deployment mechanism is implemented, rehearsed, merged, and **validated
remotely**: every required check passed for the exact release commit, the
`Release` workflow proved that authorization and published both images to GHCR,
and the `Deploy`, `Deployment rehearsal`, and `Data durability` workflows all
ran green against the merged source. What still does not exist is a place to
deploy to — so ORG-PR-001 stays open.

Four things this artifact keeps strictly apart, because they are routinely
conflated:

```
deployment mechanics validated     — YES (locally AND remotely)
external deployment target validated — NO (no target exists; nothing deployed)
staging readiness                  — NO
production readiness               — NO
```

Publishing and authorising an artifact is not deploying it. Everything in §14 is
evidence about a pipeline; none of it is evidence about a running environment.

Closure sections: [§14 remote evidence](#14-remote-validation-evidence),
[§20 documentation index](#20-documentation-index),
[§21 confidence](#21-confidence-assessment),
[§22 remaining risks](#22-remaining-risks),
[§23 sprint changelog](#23-sprint-changelog).

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
- Package visibility is an operator decision; both packages remain **private**,
  which is the safe default (§14, and
  [../deployment.md](../deployment.md#external-and-operator-only-configuration)).

**Validated remotely** — run `32776576782` published both images to GHCR for
commit `91664d0`, and both were verified by authenticated registry inspection
(§14). GHCR authentication, package creation, and digest immutability are
proven. **Still unproven:** pull-from-a-deployment-host, because no host exists;
and multi-architecture support, because the published images are amd64 only.

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

**Executed and passing, in the rehearsal — locally and now remotely** (run
`32777259951`). After deploying release A, then release B over it,
`tooling/deploy-rollback.sh` resolved A as the previous known-good release and
redeployed it. Asserted afterwards: the evidence mode is
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
  remain so until a target exists. No rollback has ever been performed against a
  deployed environment, because no environment has ever been deployed to.
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
are recorded as run evidence, not as reproducible identifiers. The same
rehearsal was subsequently executed on GitHub Actions with the identical
assertion count (§14), so the capability is not machine-specific.

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

### Validation still outstanding, and why

Every row here reflects the state **after** remote closure (§14). Nothing that
could be validated was skipped.

| Item | Status | Reason | Repository-side or external? | What would complete it |
| --- | --- | --- | --- | --- |
| Real GHCR publication | **DONE** (§14) | `Release` run `32776576782` published both images for `91664d0` | — | — |
| Remote runs of `Release`, `Deploy`, `Deployment rehearsal`, `Data durability` | **DONE** (§14) | All four executed against the merged SHA and passed | — | — |
| Deployment to a real target | **BLOCKED** | No host, provider account, or deployment credential exists | External (procurement/operator) | Provision a target per [../deployment.md](../deployment.md#remaining-staging-blockers) and run `tooling/deploy.sh` there |
| Rollback on a real target | **BLOCKED** | Same — rollback is proven in the rehearsal only | External | Two deployments plus `tooling/deploy-rollback.sh` on that target |
| GitHub Environment reviewer protection | **NOT CONFIGURED** | Cannot be represented in the repository. The `staging-like` environment now exists (GitHub created it on the first `Deploy` run) but carries zero protection rules | External (operator) | Add required reviewers, then `gh api /repos/DanielRosenberg00/Orgistry/environments` |
| Pull access for the deployment host | **NOT CONFIGURED** | Both packages are private, which is the safe default; no host exists to grant access to | External (operator) | A read-only pull credential on the host, or public package visibility |
| Multi-architecture images | **NOT BUILT** | Published images are `linux/amd64` only (§16). Out of Sprint 26 scope, deliberately | Repository-side, future sprint | A multi-arch build in a future sprint, if a non-amd64 target is ever chosen |
| Live external email through a real provider | **BLOCKED** | Unchanged since Sprint 16; no provider credentials, verified domain, or test mailbox | External | ORG-PR-002's documented procedure |
| Backup schedule / WAL archival health | **BLOCKED** | No long-lived database archives WAL; there is nothing to check. `Data durability` `32777249673` proves the recovery MECHANICS, not a backup posture | External, gated on a target | ORG-PR-005's remaining work |

## 14. Remote validation evidence

Merged and validated remotely on 2026-08-24. Every claim below traces to a run
ID; nothing is inferred from a workflow's top-level colour alone.

### Authoritative release identity

| Field | Value |
| --- | --- |
| Pull request | [#38](https://github.com/DanielRosenberg00/Orgistry/pull/38) — `feat(ops): add deployment promotion pipeline`, `sprint-26-deployment-pipeline` → `main` |
| Merged at | 2026-08-24T20:54:48Z |
| **`SPRINT_26_RELEASE_SHA`** | **`91664d0fd639ca6ca8b5681317757bbcf0f0209b`** (merge commit; `local main == origin/main`) |
| PR head validated pre-merge | `7740dfa59864de45da236d3be33dd2887cbdb843` — all six required checks `pass` |

### Required checks at the merged SHA

Every required JOB, verified through the Actions API at
`head_sha == 91664d0fd639ca6ca8b5681317757bbcf0f0209b`:

| Required check | Workflow | Run ID | Job conclusion |
| --- | --- | --- | --- |
| Validate (offline) | `ci.yml` | `32776576684` | success |
| Integration (PostgreSQL + Redis) | `ci.yml` | `32776576684` | success |
| Artifacts (build + smoke) | `ci.yml` | `32776576684` | success |
| Dependency audit (pnpm) | `security.yml` | `32776576586` | success |
| Secret scan (Gitleaks) | `security.yml` | `32776576586` | success |
| Analyze (javascript-typescript) | `codeql.yml` | `32776576905` | success |

### Sprint 26 workflows

| Workflow | Run ID | Attempt | Event | Head SHA | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Release | `32776576782` | 1 | push | `91664d0` | **success** |
| Deploy | `32777270537` | 1 | workflow_dispatch | `91664d0` | **success** |
| Deployment rehearsal | `32777259951` | 1 | workflow_dispatch | `91664d0` | **success** |
| Data durability | `32777249673` | 1 | workflow_dispatch | `91664d0` | **success** |

`Data durability` is a Sprint-closure requirement, not one of the six release
gates: Sprint 26 modified `tooling/lib/pg-tools.sh` and `tooling/db-backup.sh`,
so PITR was re-verified against the merged source. It is not in the ruleset and
was not treated as a release gate.

### The bounded-wait race, exercised for real

`Release` started from the same push as CI, Security scans, and CodeQL. Its gate
job logged `[pending]` for every check that had not yet concluded — including
`run … is in_progress` for all six at first poll — re-polled every 20 seconds
for roughly three minutes, and proceeded only when all six reported `success`:

```
release-gates: 91664d0… is reachable from main (identical)
release-gates: required checks are pending for 91664d0…
  [pending] Validate (offline) (run 32776576684): run 32776576684 is in_progress
  …
release-gates: required checks are satisfied for 91664d0…
release-gates: wrote gate evidence for 6 checks to artifacts/release-gates.json
```

No gate was ever treated as satisfied because its run had not appeared yet.

### GHCR publication

Verified by authenticated registry inspection; **no package was made public to
validate it**, and no credential was printed.

| Image | Commit-SHA tag | Digest |
| --- | --- | --- |
| `ghcr.io/danielrosenberg00/orgistry-api` | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` |
| `ghcr.io/danielrosenberg00/orgistry-web` | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` |

Each tag resolves to exactly the digest the manifest records. Both packages are
private. Both images are `linux/amd64` — see [Remaining blockers](#16-remaining-blockers).

### Release manifest, independently validated

The `release-manifest` artifact was downloaded from run `32776576782` and run
through `pnpm release:manifest validate`, plus a field-by-field cross-check.
All 23 invariants pass:

```
release.type == published            release.deployable == true
source.provenance == commit          no workingTreeDigest present
source.commit == 91664d0…            api.tag == web.tag == 91664d0…
reference == repository@digest       both references digest-pinned
no ":latest" anywhere                image identities carry NO environment config
gates.headSha == 91664d0…            6/6 gates, every headSha == 91664d0…
every gate conclusion == success     every runId numeric and matching a real run
migrations.head == 0012_shocking_warbound (matches the merged journal, 13 migrations)
build.artifactSmoke == passed        no credential-shaped value anywhere
```

### Build-once / promote-by-digest, proven from the real run

The `publish` job's step list contains **one** build — `Artifact gate (build +
smoke)` — followed by `Tag the gated API image`, `Tag the gated web image`, and
`Publish both images`. There is no `docker build` step in the publication path.
The images published are the images the gate validated; `docker tag` cannot
change content.

### Promotion proven against the PUBLISHED artifact

The published web digest `sha256:20dc434b7b62…` was pulled and started twice
with two different `ORGISTRY_PUBLIC_API_BASE_URL` values:

```
container 1 -> {"apiBaseUrl":"https://api.staging.example.test",   …}
container 2 -> {"apiBaseUrl":"https://api.production.example.test", …}
both containers -> image sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855
neither origin present in /usr/share/nginx/html/assets
```

One digest, two environments, no rebuild — verified against the real release
rather than only the local rehearsal.

### Deploy workflow — what it proved, and what it did not

Run `32777270537`, environment `staging-like`, success. Its steps downloaded the
real release manifest, validated it, confirmed deployability and gate evidence
(re-printing all six run IDs), resolved **both digests in the live registry**,
and emitted the operator plan. It performed **no build** and **no target
execution**, which is the designed operator-assisted boundary — not a
deficiency. It did **not** prove that any host runs Orgistry.

GitHub created the `staging-like` environment implicitly on this first use; it
currently has **zero protection rules**. Adding required reviewers is an
external operator action, recorded as such.

### Deployment rehearsal, remotely

Run `32777259951`, success, **65 assertions** — the same count as locally, so
the capability is not machine-specific. Covered: build once, publication to the
throwaway registry, digest capture, rehearsal provenance (`commit` on the clean
runner checkout, still `deployable: false`), migrate exactly once, verified
migration head, readiness, four deployments each passing all **9** smoke checks,
evidence recording, same-web-digest promotion under a different runtime API
origin, application rollback restoring the previous known-good digests with
migrations skipped, and four refusals (tag-pinned manifest; rehearsal release
offered to a `deployment`-class environment; rehearsal manifest relabelled
published; runtime configuration file not `0600`).

This is remote validation of deployment MECHANICS. It is not a staging
deployment.

### Workflow security, as merged and executed

| Workflow | Permissions in the merged file | Observed |
| --- | --- | --- |
| `release.yml` | workflow `contents: read`; gates job `+actions: read`; publish job `+packages: write` | Split held — neither job carried the other's scope |
| `deploy.yml` | `contents: read`, `actions: read`, `packages: read` | Read-only throughout |
| `deployment-rehearsal.yml` | `contents: read` | No secrets required |

No new workflow declares a `pull_request` trigger, so untrusted PR code has no
path to publication or to deployment inputs. All four run logs were scanned for
credential-shaped values: **zero hits**.

### Ruleset integrity

Ruleset `19769611` after the merge: `enforcement: active`, **zero bypass
actors**, rule types `deletion`, `non_fast_forward`, `pull_request`,
`required_status_checks`, `code_scanning`, and exactly the same six required
checks. No check was removed, and no Sprint 26 workflow became a PR gate.

## 15. Findings reconciliation

| Finding | Status | Evidence basis |
| --- | --- | --- |
| **ORG-PR-001** | **OPEN — materially advanced** | Mechanism implemented, rehearsed locally (§13), and **executed remotely** (§14): required checks green for the exact SHA, both images published to GHCR, `Deploy`/`Rehearsal`/`Data durability` green. Closure criterion — "a tagged build **deploys to a target environment** reproducibly" — is **not met**: no target exists, nothing has been deployed to one, rollback is rehearsal-only |
| **ORG-PR-002** | **OPEN** | Out of scope this sprint and untouched. External provider, verified sending domain, and a test mailbox are still absent |
| **ORG-PR-005** | **OPEN** | Deployment-time backup integration added, and `Data durability` run `32777249673` re-verified PITR against the merged source. **A green durability workflow is repository validation, not backup closure**: nothing schedules, stores off-host, or encrypts a backup; no WAL archiving on a long-lived database; no measured RPO/RTO |
| **ORG-PR-006** | **OPEN** | Deployment-side secret *handling* enforced (§12) and confirmed remotely — permission split held, zero credential-shaped values in any run log. **GitHub workflow/environment controls alone are not closure**: no secret store, no access control, no auditability, no automated rotation, no rehearsed rotation; the `staging-like` environment has zero protection rules |
| ORG-PR-042 | Closed (Sprint 23), unaffected | The two new pinned images (`registry:3.0.0`, `redis:7.4.10-alpine` in the rehearsal) follow the same tag+digest policy; `infra/compose.deploy.yml` deliberately has no pinned literals because its images come from a release manifest |
| ORG-PR-028 | Unchanged | The bad-migration rehearsal still needs a real environment |
| ORG-PR-016 | Unchanged | Nothing here schedules anything |

No other finding's status changed.

## 16. Remaining blockers

**To close ORG-PR-001 (all external, none of them repository work):** a host that
can run Docker Compose; a managed or operated PostgreSQL and Redis; a real SMTP
provider (the production config guard refuses to boot without one); TLS
termination and a public origin; a pull credential for the host (or public
package visibility — the packages now exist and are private); and required
reviewers on the `staging-like` GitHub Environment, which currently has zero
protection rules. Full list:
[../deployment.md](../deployment.md#remaining-staging-blockers).

**Published images are single-architecture `linux/amd64`.** Built on GitHub's
amd64 runners with no multi-arch manifest list, so an arm64 host cannot run them
without emulation. Adequate for the x86-64 single-host target this model assumes;
recorded because it constrains which host may be provisioned. Surfaced by
inspecting the first real release.

**Repository-side: none.** No defect was discovered by remote execution.

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
Deployment mechanics validated       YES  (locally AND remotely — §13, §14)
External deployment target validated NO   (no target exists; nothing deployed)
Staging readiness                    NO
Production readiness                 NO

C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

**Sprint 26 DoD: MET.** Every category the Sprint Specification scopes to this
sprint is satisfied with executed evidence, including the requirements that only
became checkable after merge — real GHCR publication and real remote workflow
runs. The specification explicitly permits a target abstraction plus an
operator-assisted deployment path when no external target is available, and that
is exactly what was built and validated.

**Sprint DoD and ORG-PR-001 closure are different questions.** Four P1 blockers
remain open (ORG-PR-001, ORG-PR-002, ORG-PR-005, ORG-PR-006). ORG-PR-001's own
criterion is a tagged build **deploying to a target environment**; no target
exists, so nothing has been deployed to one. A green pipeline is not a running
environment, and neither is launch clearance.

## 19. Recommended next sprint

**Deployment Pipeline Closure (ORG-PR-001).**

Sprint 26 state, stated plainly:

```
Sprint 26 repository work        COMPLETE
Sprint 26 validation             COMPLETE (local + remote, §13 and §14)
ORG-PR-001                       OPEN — materially advanced
external deployment target       STILL REQUIRED
```

The repository half is done and executed. What remains is entirely operator and
procurement work: provision the smallest real staging-like target that satisfies
the [staging blockers](../deployment.md#remaining-staging-blockers); give it a
pull credential for the two private GHCR packages (which now exist); add
required reviewers to the `staging-like` GitHub Environment; deploy release
`91664d0` to that target with `tooling/deploy.sh`; roll it back; and record the
deployment evidence. That closes ORG-PR-001 on its own criterion.

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

## 20. Documentation index

The authoritative documents Sprint 26 created or changed, and what each one owns.
Where two documents could describe the same thing, exactly one is authoritative
and the other links to it.

### Created

| Document | Owns |
| --- | --- |
| [../deployment.md](../deployment.md) | **The authoritative deployment document.** Target decision and rejected alternatives, the five-name environment taxonomy, registry publishing, runtime public configuration, build-once/promote-by-digest, release provenance (published vs rehearsal), exact-SHA gate authorization and its race behavior, the release-manifest schema, the deployment configuration contract, secret handling, the deployment workflow and operator path, migration lifecycle, backup/PITR preflight, health/readiness/smoke, deployment evidence, the three rollback categories, the rehearsal, external/operator-only configuration, branch protection, known limitations, staging and production blockers, the extension guide, the changelog, and the recorded remote evidence |
| **This artifact package** | The official Sprint 26 closure record: what was delivered, what was validated, with which evidence, and what remains |

### Updated

| Document | What Sprint 26 changed |
| --- | --- |
| [../deployment-artifacts.md](../deployment-artifacts.md) | Web artifact section rewritten: no build arguments, runtime public configuration, and the promotability property. Migration policy now points at the enforced deployment lifecycle |
| [../runbook.md](../runbook.md) | A third compose file exists (`infra/compose.deploy.yml`, never run by hand); how to run the local rehearsal; the rehearsal's output is not a release |
| [../validation.md](../validation.md) | New *Deployment validation* section (deterministic contract tests + rehearsal), the `--` forwarding note, the `pnpm deploy:run` naming caveat, three new workflows described, image-pinning grep list extended, branch-protection note that Sprint 26 changed no required check |
| [../known-limitations.md](../known-limitations.md) | The deployment bullet now separates *pipeline executed* from *no environment*; the rehearsal is recorded as not-a-deployed-environment |
| [../../README.md](../../README.md) | Deployment doc linked; the limitations paragraph distinguishes publishing an artifact from deploying it |
| [README.md](README.md) | Sprint 26 status block: implementation, refinement, and the remote-validation result with run IDs |
| [findings-register.md](findings-register.md) | ORG-PR-001 progress entries (implementation, refinement, remote validation) and the summary-table row; ORG-PR-005 and ORG-PR-006 integration/handling notes |
| [security-assessment.md](security-assessment.md) | CI/CD section: exact-SHA release authorization, the permission split as executed, zero credential-shaped values in run logs; infrastructure section: the deployment invariants |
| [standards-matrix.md](standards-matrix.md) | SSDF Secure Build / Secure Deployment and SLSA build-service and provenance rows moved on executed evidence |
| [production-roadmap.md](production-roadmap.md) | Phase 4 Sprint 26 entry with its outcome and the next recommended step |
| [production-scorecard.md](production-scorecard.md) | CI/CD 3 → 4 on executed release-authorization evidence; infrastructure deliberately held at 2 |
| [production-target.md](production-target.md) | Deployment tooling now exists and is executed; no deployment environment exists |
| [launch-checklist.md](launch-checklist.md) | LC-1.6 advanced with remote evidence; LC-1.8 added for target provisioning; LC-2.1 and LC-2.3 note the deployment-time integration |
| [repository-inventory.md](repository-inventory.md) | Scripts, CI, Docker, and tooling inventories for every new file, plus the executed-workflow note |

## 21. Confidence assessment

Staff-level confidence in each boundary, based on what was actually executed.
**Confidence is not readiness.** High confidence that the pipeline works
correctly says nothing about whether Orgistry may serve users — that is
[§18](#18-final-readiness-classification).

| Boundary | Confidence | Rationale |
| --- | --- | --- |
| Repository implementation | **HIGH** | 1013 unit + 94 web tests, 119 integration tests, artifact smoke, three durability drills, and a 65-assertion rehearsal — all green locally and, for the CI-covered subset, remotely at the exact release SHA. No defect was found by remote execution |
| Artifact identity | **HIGH** | Both published tags resolve to exactly the digests the manifest records, verified directly against the registry. The manifest schema refuses tag-pinned references and any non-identity field on an image, and 23/23 invariants passed on the real artifact |
| Release authorization | **HIGH** | The gate job resolved the actual runs for the exact commit, evaluated at job granularity, and its bounded wait was exercised for real — it polled for ~3 minutes and never treated an unreported run as satisfied. The manifest binds every gate to `source.commit`, and the validator enforces that |
| Registry publication | **HIGH** | Executed once, successfully, with both images verified by authenticated inspection. Residual: single-architecture amd64, and pull-from-a-deployment-host is unproven because no host exists |
| Deployment mechanics | **MEDIUM-HIGH** | Every stage — preflight, migrate-once, verified head, staged rollout, readiness, 9-check smoke, evidence, digest verification — is proven repeatedly, but always against throwaway infrastructure. Nothing has run against a long-lived database, real traffic, TLS, or a reverse proxy |
| Rollback mechanics | **MEDIUM** | Application rollback is executed and asserted end to end, including running-digest restoration and migration skip. But both rehearsal releases differ only by an image label, and no rollback has ever been performed on a deployed environment. Database recovery is separately tested (PITR) but never rehearsed against a real incident |
| Documentation correctness | **HIGH** | Every link and anchor validated mechanically; a global stale-claim sweep passes; run IDs, SHAs, and digests in the documentation were transcribed from the API and re-verified in this pass |

## 22. Remaining risks

Only risks that survive the validation actually performed. Risks disproven by
evidence are deliberately absent.

### Repository risks

- **Required-check drift.** `REQUIRED_GATES` mirrors the `main` ruleset by hand.
  The two matched exactly when verified, but nothing reconciles them
  automatically: a maintainer who adds a required check to the ruleset without
  updating the list would authorise releases against the older set. Mitigated by
  both living in one place and being documented together; not eliminated.
- **Single-architecture images.** `linux/amd64` only. Compatible with the
  planned x86-64 single-host target; a non-amd64 target would need a deliberate
  multi-architecture change in a future sprint.
- **The rehearsal is the only end-to-end regression test for the deployment
  path**, and it is manual/weekly rather than a pull-request gate. A change to
  the deployment tooling merged without running it would not be caught until the
  next scheduled run. This is the same accepted tradeoff as the PITR drill.

### External infrastructure risks

- **No deployment target exists**, so every environment-shaped property remains
  unproven: TLS termination, a reverse proxy and correct `TRUST_PROXY`, DNS,
  real managed PostgreSQL and Redis, and a real SMTP provider.
- **Both GHCR packages are private** and no host has pull access. Correct as a
  default; it is work that must happen before a first deployment.
- **The `staging-like` GitHub Environment has zero protection rules.** It exists
  only because the first `Deploy` run created it. Until reviewers are added,
  environment binding provides no approval gate beyond the workflow being
  manual-dispatch-only.
- **No backup runs anywhere.** The deployment takes a pre-migration backup, but
  nothing schedules, stores off-host, or encrypts one, and no database archives
  WAL (ORG-PR-005).

### Operational risks

- **No observability.** Nothing alerts on a failed deployment, a failed
  migration, a fail-closed rate limiter, or a readiness flap (ORG-PR-007,
  ORG-PR-009).
- **Rollback across a destructive migration is recovery, not rollback**, and
  that recovery has never been rehearsed against a real incident or
  production-sized data. RTO remains unmeasured.
- **Secrets are plaintext files on a host.** No store, access control, read
  auditing, or automated rotation (ORG-PR-006).
- **Single operator.** Branch protection requires a pull request but zero
  approving reviews, because one maintainer cannot approve their own PR. Human
  review is a convention here, not an enforced control.

## 23. Sprint changelog

The quality evolution that produced this result. Each arrow is a correction or a
validation boundary, not a work log.

```
initial deployment/promotion implementation
  → build-once web artifact correction   (public config moved from build to runtime;
                                          images.web.apiBaseUrl removed from the schema)
  → release provenance correction        (published vs rehearsal; working-tree provenance
                                          with a content fingerprint; never deployable)
  → exact-SHA gate authorization         (required checks resolved per job for the exact
                                          commit; run IDs recorded in the manifest)
  → local full-lifecycle rehearsal       (65 assertions, promotion + rollback)
  → PR validation                        (#38: six required checks green on the head)
  → real GHCR publication                (both images, commit-SHA tags, immutable digests)
  → exact-SHA Release validation         (bounded wait exercised; gates bound to 91664d0)
  → remote Data Durability validation    (PITR re-verified after Sprint 25 tooling changed)
  → remote Deployment rehearsal          (same 65 assertions; not machine-specific)
  → operator-assisted Deploy validation  (manifest, deployability, gates, digests, plan)
  → final evidence reconciliation        (documentation matches executed reality)
```

Two defects in Sprint 25 durability tooling were found and fixed along the way —
a backup of a database with no migration ledger, and `pg_start_server` under
`set -u` on bash 3.2 — both on the first-deployment path, neither previously
reachable. Both are re-validated by the drills and by `Data durability`
`32777249673`.
