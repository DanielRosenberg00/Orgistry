# Sprint 27 Closing Artifact — Deployment Pipeline Closure

```
Status: COMPLETE
Sprint 27 DoD met:                   YES
ORG-PR-001:                          CLOSED
Real staging-like target validated:  YES
Staging ready:                       NO
Production ready:                    NO
```

**Date:** 2026-08-27 · **Branch:** `sprint-27-deployment-pipeline-closure` ·
**Published head:** `0b6e6967bb95f26f211df29671210926eb136b75` · **PR:** #40
(base `main`, merge state CLEAN)

This is the **official final Sprint 27 artifact**, finalized in place from the
living evidence package it has been since the sprint began. There is no second
Sprint 27 artifact and none should be created.

---

## 1. Executive summary

Sprint 27 set out to validate the Sprint 26 deployment and promotion mechanism
against a real durable external staging-like target, and to close ORG-PR-001 on
evidence rather than rehearsal. **It did.**

A durable DigitalOcean host in FRA1 (`linux/amd64`, Ubuntu 24.04.4) serving real
public HTTPS origins ran the full lifecycle: target preflight, target-side
immutable digest pulls with no registry credential, two gate-authorised releases
deployed by digest with backup preflight and a one-shot verified migration,
public HTTPS smoke passing 9/9 three times, a restart/persistence check, and a
**real application rollback** to the previous known-good digests with the
running images verified and the schema untouched. Three machine-generated
evidence records live on the host, scanned free of secret material.

Along the way, real external reconnaissance found and fixed two defects that no
local rehearsal could surface: the GHCR packages were publicly pullable rather
than private as Sprint 26 recorded, and the deployment had **no image/host
architecture check** — so a correctly provisioned arm64 host would have pulled
the single-architecture `linux/amd64` images and failed only at container start,
four stages after the backup preflight and migration had already run against the
target's database. A fail-fast platform gate and a read-only target preflight
now close that class of failure.

The Sprint 27 repository changes were published as PR #40 and passed every
mandatory remote workflow, including a manually dispatched Deployment Rehearsal
at the exact published head.

**ORG-PR-001 is closed. Production readiness is not claimed and remains NO**, on
three still-open P1 findings. Staging readiness also remains NO, on documented
evidence-backed limitations that were deliberately out of Sprint 27's scope.

## 2. Sprint objective

Validate the repository-controlled deployment and promotion mechanics
established in Sprint 26 against the first durable external staging-like
deployment target, and reconcile ORG-PR-001 honestly against the result.

Sprint 27 was explicitly **not** authorised to deliver production launch, DNS
cutover, real-user traffic, production data, email-provider closure,
SPF/DKIM/DMARC, a secrets-manager platform, automated rotation, production
backup scheduling, off-host encrypted backup storage, WAL archival closure,
observability or alerting platforms, artifact signing, SLSA provenance,
multi-region, autoscaling, Kubernetes, product features, or any
auth/authorization/database-model redesign. None of those were implemented.

## 3. Scope delivered

Sprint 26's architecture was **preserved, not redesigned**. No parallel
deployment mechanism was introduced.

| Path | Change | Why |
| --- | --- | --- |
| `tooling/lib/deploy-common.sh` | `deploy_normalize_architecture`, `deploy_image_platform`, `deploy_host_platform`, `deploy_assert_image_runs_on_host`, `DEPLOY_EMULATED_PLATFORM` | The deployment could not tell whether the images it pulled could run on the host it pulled them onto |
| `tooling/lib/deploy-common.sh` | `deploy_require_determined_platform`, called by both getters and again at the decision point | **Fail-open defect found in review.** `docker image inspect`/`docker info` exit 0 even when a template field renders empty, producing `"/"`; matching on both sides would have passed the gate by accident |
| `tooling/deploy.sh` | New **stage 5**, after the digest pull and before the backup preflight; emulation recorded as a deployment-record limitation | A platform mismatch must abort while the target is still untouched |
| `tooling/deploy-target-preflight.sh` (new), `pnpm deploy:preflight` | Read-only host qualification: toolchain, host baseline and boot persistence, release pullability and platform from that host, configuration boundary; refuses a non-digest reference before pulling | The repository could deploy to a host but had no way to decide whether a host was a candidate |
| `tooling/deploy-platform-guard.test.ts` (new) | 18 tests driving the real shell functions through bash, including the fail-open regression | Inside the required `Validate (offline)` check; deliberately not a TypeScript re-implementation of the rule |
| `packages/config/src/config.test.ts` | One regression test pinning that an isolated non-provider SMTP endpoint loads under `NODE_ENV=production` | The staging deployment model depends on that invariant; a later tightening would silently break staging |
| `tooling/deploy-smoke.sh` | Header renumbered 1–9 | It performs nine checks and always did |
| `package.json`, `infra/deploy.env.example` | `deploy:preflight` entry point; Mailpit URL boundary comment | — |

**Deliberately not built:** multi-architecture image publishing. It is the other
answer to the architecture constraint, but it changes the release workflow's
build and digest model and belongs to a sprint that owns that decision. The
constraint is now enforced and visible instead of silent, and the validated
target is amd64.

## 4. Real target identity and architecture

| | |
| --- | --- |
| Sanitized identity | `orgistry-staging-01` |
| Provider / region | DigitalOcean, FRA1 / Frankfurt |
| Architecture / OS | **`linux/amd64` (x86_64)** · Ubuntu 24.04.4 LTS · kernel 6.8.0-138-generic |
| Resources | 2 vCPU · 4 GiB RAM · ~74 GiB free on `/opt` |
| Runtime | Docker Engine 29.7.2 · Compose v5.5.0 · bash 5.2.21 · curl 8.5.0 · node v22.23.2 |
| Durability | Docker enabled at boot; all containers `restart=unless-stopped`; PostgreSQL on a named volume |
| Public origins | `https://staging.drsvp.com` (web) · `https://api-staging.drsvp.com` (API) |
| Edge | Caddy v2.11.4, active and enabled; Let's Encrypt certificates valid to 2026-11-25; HTTP→HTTPS `308` |
| Inbound exposure | **22, 80, 443 only** — externally probed and confirmed |
| Backing services | PostgreSQL 16.14-alpine, Redis 7.4.10-alpine, digest-pinned, on `orgistry-deploy`, **no host port bindings** |
| Mail | Mailpit v1.31.0, isolated sink, no external relay, no real-recipient delivery |
| Operator access | `daniel`, ED25519 key; root login, password auth, and keyboard-interactive all disabled |
| Directories | `/opt/orgistry/{config,deploy,evidence,backups,data}` |
| Registry credential | **none exists on the host** — `~/.docker/config.json` absent |
| Data classification | **Synthetic only.** No real user data |

**No source is built on the target.** Only the deployment tooling dependency
closure was transferred — 13 files: `tooling/`, `tooling/lib/`, and
`infra/compose.deploy.yml`, with **zero npm dependencies** (only `node:`
built-ins). No Dockerfile, no application source, no `packages/`.
`infra/compose.deploy.yml` contains zero `build:` sections, which the deployment
asserts before invoking Compose. `git` and `pnpm` are not installed on the host
for the deployment's benefit and are not required.

## 5. Target preflight evidence

`tooling/deploy-target-preflight.sh`, executed **on the target** against the
Release 1 manifest: **0 failed, 0 warned**, exit 0.

| Group | Result |
| --- | --- |
| Toolchain | `docker`, `curl`, `node`, Compose v2 (5.5.0), tooling tree present |
| Host baseline | Docker daemon reachable, platform **`linux/amd64`**; **Docker service enabled at boot** |
| Release | manifest valid; **both images pulled by the target itself**; both image platforms match the host |
| Configuration | `ORGISTRY_ENVIRONMENT_CLASS=deployment`; `runtime.env` readable only by its owner; API and web bound to `127.0.0.1`; browser-facing API origin is HTTPS; evidence and backup directories writable and not world-writable |

```json
{
  "composeVersion": "5.5.0",
  "hostPlatform": "linux/amd64",
  "dockerVersion": "29.7.2",
  "cpuCount": "2",
  "memoryBytes": "4106096640",
  "storageDriver": "overlayfs",
  "kernel": "Linux 6.8.0-138-generic",
  "dockerEnabledAtBoot": "true",
  "apiImagePlatform": "linux/amd64",
  "webImagePlatform": "linux/amd64",
  "environment": "staging-like",
  "publicApiOrigin": "https://api-staging.drsvp.com",
  "ORGISTRY_EVIDENCE_DIRFreeKb": "76226104",
  "ORGISTRY_BACKUP_DIRFreeKb": "76226104"
}
```

**Read-only contract honoured.** It started no Orgistry container, ran no
migration, touched no application database or Redis state, altered no firewall
rule, and mutated no GitHub setting. Its only write was pulling two immutable
content-addressed images into the local image cache.

The **`linux/amd64` procurement constraint was verified by the gate**, not
assumed: the same check that refused an arm64 workstation earlier in Sprint 27
passed natively here.

## 6. Release pair and exact immutable digests

Both releases pre-existed on `main` from Sprint 26. **Neither was manufactured**
for this test, and no synthetic product change was introduced to create a
rollback candidate.

| | **Release 1** (deployed first; rollback target) | **Release 2** |
| --- | --- | --- |
| Source SHA | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` | `d51c76b5ee6b0d6183b76ac4b8efacdee94ae704` |
| Source ref | `refs/heads/main` | `refs/heads/main` |
| Release workflow run | `32776576782` | `32779601026` |
| Type / deployable | `published` / **true** | `published` / **true** |
| Provenance | `commit` | `commit` |
| API digest | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` | `sha256:7afc079b3844f58ae3c24524a8b7c0739582391a5224b7cfc83e621d2e027148` |
| Web digest | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` | `sha256:b0d5dd000ab2ea034036768e15a91e0f47f1e5bc3709e1340692b5eb2dfac5b1` |
| Migration head | `0012_shocking_warbound` | `0012_shocking_warbound` |
| Migration count | 13 | 13 |
| Journal timestamp | `1787555203153` | `1787555203153` |
| `gates.headSha` | equals its own source commit | equals its own source commit |
| Artifact gate | `passed` | `passed` |

Gate authorisation — all six required checks `success`, bound to each release's
exact SHA:

| Check | Release 1 run | Release 2 run |
| --- | --- | --- |
| Validate (offline) | `32776576684` | `32779600982` |
| Integration (PostgreSQL + Redis) | `32776576684` | `32779600982` |
| Artifacts (build + smoke) | `32776576684` | `32779600982` |
| Dependency audit (pnpm) | `32776576586` | `32779600966` |
| Secret scan (Gitleaks) | `32776576586` | `32779600966` |
| Analyze (javascript-typescript) | `32776576905` | `32779601072` |

**Schema compatibility verified explicitly:** identical migration head, count,
and journal timestamp. Rolling between them crosses no migration boundary — the
precondition for a safe application rollback.

### Registry boundary

**Observed state: both GHCR packages are currently publicly pullable.** Sprint
26 recorded them as private; that was wrong. Proven on the target, which holds
**no registry credential of any kind**, and independently by the Deploy workflow
resolving the same digests.

This is an **observed state, not an approved visibility policy** — no document
records a decision to publish them publicly, nothing in this repository changed
it, and none should without recording the decision. *Operational implication:* a
staging host needs no GHCR pull credential. *Security implication:* while
public, the images must contain nothing secret, which `tooling/artifact-smoke.sh`
already enforces. *Policy implication:* needing no credential is **not** a
secrets-management capability and closes nothing in ORG-PR-006. *Reversibility:*
making them private returns the pull-credential requirement to every host.

## 7. Backup / PITR preflight evidence

The Sprint 25 durability tooling executed for real, on the target, before each
migration.

| Deployment | Preflight | Artifact |
| --- | --- | --- |
| Release 1 | `taken`, recovery point `2026-08-27T10:03:59Z` | `orgistry-20260827T100354Z-pre-deploy.dump` (+ `.sha256`, `.meta.json`) |
| Release 2 | `taken`, recovery point `2026-08-27T10:06:59Z` | `orgistry-20260827T100654Z-pre-deploy.dump` (+ `.sha256`, `.meta.json`) |
| Rollback | `skipped`, with the recorded reason that it runs no migrations and creates no new recovery-point requirement | — |

Backups live in `/opt/orgistry/backups`, mode 0750. The staging policy applied
was `ORGISTRY_BACKUP_PREFLIGHT=take`, which requires a successful logical backup
and aborts the deployment if it fails. It did not fail.

**PITR/WAL availability on this target: NONE.** The staging PostgreSQL does not
archive WAL, so no point-in-time recovery window exists there.

**This is the deployment boundary working. It is not backup operations.**
Nothing schedules a backup, stores one off-host, encrypts one at rest, archives
WAL, or monitors archive health; no RPO/RTO is measured; and **no real-target
restore or PITR drill was performed** — none is claimed. **ORG-PR-005 remains
open.**

## 8. Migration execution and verification

| | |
| --- | --- |
| Executed | once per deployment, as its own container, from the release's own API image (`docker compose run --rm migrate`) |
| Release 1 | `Migrations applied successfully.`, container exit 0 |
| Release 2 | `Migrations applied successfully.`, container exit 0 (no-op — same head) |
| Head verified | `0012_shocking_warbound`, **13 applied migrations**, checked against the manifest through Drizzle's own ledger on the target's real PostgreSQL |
| API boot | did **not** run migrations — the API service never migrates at boot |
| Rollback | ran with `--no-migrate`; migrations neither re-run nor reversed; recorded `migration.result: skipped` |
| Post-rollback ledger | still **13** |
| Credential exposure | none — the database URL is read into a variable and passed only to a container environment, never a command line, never logged, never written to evidence |

A migration failure aborts the deployment before any new application container
starts. That path was not exercised on the target because no migration failed.

## 9. Release 1 deployment evidence

Deployed `91664d0fd639ca6ca8b5681317757bbcf0f0209b` by immutable digest.

| Stage | Result |
| --- | --- |
| Manifest validation | `valid — published release, commit provenance, deployable: true` |
| Environment validation | runtime configuration present and permission-checked |
| Target-side digest pull | **PASS** — both images, no credential |
| Platform gate (stage 5) | **PASS** — "both images are native to this host (linux/amd64)" |
| Backup preflight | **`taken`** — recovery point `10:03:59Z` |
| Migration | applied once, exit 0 |
| Migration-head verification | `0012_shocking_warbound` (13) |
| API startup | healthy |
| Web startup | up |
| Running-digest verification | api `9b79d72c045f…`, web `20dc434b7b62…` — equal to the manifest |
| Smoke (host-side) | **9/9** |
| Evidence | `/opt/orgistry/evidence/staging-like/records/20260827T100415026Z-91664d0fd639-deploy.json` |

## 10. Release 2 deployment evidence

Deployed `d51c76b5ee6b0d6183b76ac4b8efacdee94ae704` over Release 1.

| Stage | Result |
| --- | --- |
| Manifest validation | `valid — published release, commit provenance, deployable: true` |
| Backup preflight | **`taken`** — recovery point `10:06:59Z` |
| Migration | applied once, exit 0 (no-op — same head) |
| Migration-head verification | `0012_shocking_warbound` (13) |
| Running-digest verification | api `7afc079b3844…`, web `b0d5dd000ab2…` |
| Smoke (host-side) | **9/9** |
| Rollback target resolved | `91664d0fd639…` |
| Evidence | `.../records/20260827T100713595Z-d51c76b5ee6b-deploy.json` |

## 11. Public HTTPS smoke evidence

`tooling/deploy-smoke.sh` executed **from outside the host, over the public
internet**, against the real origins. **9/9 checks passed, three times:**

| Run | Result |
| --- | --- |
| After Release 1 | **9/9 PASS** |
| After Release 2 | **9/9 PASS** |
| After rollback | **9/9 PASS** |

Checks: `/health`; `/ready`; coarse readiness disclosure under
`NODE_ENV=production`; six baseline security headers; request-ID propagation
through the Caddy reverse proxy; production web build; SPA history fallback; the
served browser API origin; and the absence of any environment origin inside the
immutable bundle.

Each deployment additionally ran its own loopback smoke as its final gate (also
9/9), configured with
`ORGISTRY_SMOKE_EXPECTED_API_ORIGIN=https://api-staging.drsvp.com` so even the
host-side run asserts the public browser origin.

### The 502s disappeared

| Origin | Before deployment | After deployment |
| --- | --- | --- |
| `https://staging.drsvp.com/` | **502** | **200** |
| `https://api-staging.drsvp.com/health` | **502** | **200** — `{"ok":true,"data":{"status":"ok"}}` |
| `https://api-staging.drsvp.com/ready` | **502** | **200** — `{"ok":true,"data":{"status":"ready"}}` |
| `http://staging.drsvp.com/` | 308 → HTTPS | 308 → HTTPS |

Browser runtime configuration served publicly:

```
window.__ORGISTRY_PUBLIC_CONFIG__ = {"apiBaseUrl":"https://api-staging.drsvp.com","csrfHeaderName":"x-orgistry-csrf","mailpitUrl":"http://localhost:8025"}
```

Readiness stays coarse in production mode — the public body names no dependency.
On `mailpitUrl`, see §24.

## 12. Restart / persistence evidence

| Check | Result |
| --- | --- |
| Application containers restarted | API and web restarted cleanly |
| Readiness recovered | `/ready` 200 after 3s |
| Public origins after restart | all three back to **200** |
| **Database persistence** | migration ledger **13 rows before and 13 after** |
| Restart policies | `orgistry-api-1`, `orgistry-web-1`, `orgistry-infra-postgres-1`, `orgistry-infra-redis-1` all `restart=unless-stopped` |
| Boot persistence | Docker service enabled at boot |
| Evidence / backups | persisted on disk across the restart |

A host reboot was validated by the operator during infrastructure provisioning.
The container restart above establishes the remaining application-persistence
fact without a second reboot.

## 13. Real rollback evidence

| Step | Evidence |
| --- | --- |
| Dry run | resolved `91664d0fd639…` (deployed `2026-08-27T10:04:15.026Z`) from the host's own ledger, using that release's stored manifest |
| API digest restored | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` |
| Web digest restored | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` |
| Migration behaviour | `--no-migrate`; `migration.result: skipped`; **no migration re-run and none reversed** |
| Health / readiness | recovered |
| **Public HTTPS rollback smoke** | **9/9 PASS** |
| Running-digest verification | `docker inspect` on both containers; resolved image IDs cross-checked as **MATCH** against Release 1's digest references |
| Post-rollback schema | migration ledger unchanged at **13** |
| Evidence | `.../records/20260827T100802764Z-91664d0fd639-rollback.json` |

Ledger on the target:

```
2026-08-27T10:04:15.026Z  deploy    91664d0fd639  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=none
2026-08-27T10:07:13.595Z  deploy    d51c76b5ee6b  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=91664d0fd639
2026-08-27T10:08:02.764Z  rollback  91664d0fd639  migration=skipped  backup=skipped  smoke=passed(9)  rollbackTarget=d51c76b5ee6b
```

Both deployed release manifests are stored alongside the records, so the host
resolves a rollback without the registry API, an expired workflow artifact, or
an operator remembering a SHA.

## 14. Application rollback vs database migration boundary

```
application image rollback does not reverse database migrations
```

This is an invariant, not a caveat. Rollback restores **container digests**;
migrations are forward-only and there are no down migrations. Redeploying older
containers runs older **code** against the **current** schema — safe only while
the older code tolerates the newer schema, which is normally true for additive
migrations and false the moment a migration drops or rewrites something the old
code reads.

Sprint 27's evidence demonstrates the boundary directly: the migration ledger
held 13 rows before the rollback and 13 after.

Undoing a schema change is a **recovery** operation — a restore or a
point-in-time recovery ([backup-and-restore.md](../backup-and-restore.md),
[pitr.md](../pitr.md)) — not a rollback. The Sprint 25 repository-controlled
restore and PITR drills remain the only such evidence. **No real-target restore
or PITR rehearsal was performed in Sprint 27, and none is claimed.** The staging
target has no WAL archiving and therefore no PITR window. Production backup
operations remain a separate open blocker (ORG-PR-005).

The release pair was deliberately chosen to avoid a schema-rollback requirement.

## 15. Network-exposure validation

Externally probed from outside the host after deployment:

| Port | Result |
| --- | --- |
| 22, 80, 443 | **OPEN** (intended) |
| 3000 (API), 8080 (web) | closed/filtered |
| 5432 (PostgreSQL), 6379 (Redis) | closed/filtered |
| 1025 (Mailpit SMTP), 8025 (Mailpit UI) | closed/filtered |
| 2019 (Caddy admin) | closed/filtered |

Host-side listeners confirm the same shape: API `127.0.0.1:3000`, web
`127.0.0.1:8080`, Mailpit UI `127.0.0.1:8025`, Caddy admin `127.0.0.1:2019`;
PostgreSQL and Redis have **no host port binding at all** and are reachable only
on the `orgistry-deploy` Docker network.

**No deployment action exposed an internal service port.** DigitalOcean Cloud
Firewall and UFW were configured by the operator and were not modified.

## 16. GitHub Environment and Deploy workflow evidence

`.github/workflows/deploy.yml` is unchanged and was dispatched for the release
actually running on the target.

| | |
| --- | --- |
| Run | **`33061763360`**, `workflow_dispatch`, branch `main`, **SUCCESS** (2026-08-27T10:08:58Z) |
| Environment | **`staging-like`** — confirmed by the GitHub deployments API: `{environment: "staging-like", ref: "main", task: "deploy"}` |
| Input | `release_run_id=32776576782` (the Release run for `91664d0`) |
| Manifest retrieval | downloaded the `release-manifest` artifact from that Release run |
| Manifest validation | `valid — published release, commit provenance, migration head 0012_shocking_warbound, deployable: true` |
| Gate authorisation | `Release 91664d0fd639… is authorised by:` followed by all six required checks |
| Registry proof | both digests resolved: `orgistry-api@sha256:9b79d72c045f…`, `orgistry-web@sha256:20dc434b7b62…` |
| Target execution | **operator-assisted, by design** — the workflow verifies and authorises; the operator executes `tooling/deploy.sh` on the host |

**The operator-assisted model is preserved deliberately.** GitHub Actions does
not reach into the target, and **no inbound exposure was created to let it** —
the host's public surface is still 22/80/443 only. Direct CI SSH deployment was
considered and rejected in Sprint 26 and remains rejected.

### Environment protection

```
Environment exists:                    YES  (staging-like)
protection_rules:                      [branch_policy]
deployment_branch_policy:              {protected_branches: true, custom_branch_policies: false}
Required reviewer separation:          NOT configured
```

The **deployment-branch restriction is active**, applied by the operator, so a
`Deploy` dispatch from an arbitrary branch cannot reach environment-scoped
secrets. Nothing in this repository mutated it.

Reviewer separation remains unconfigured and is a **documented single-maintainer
limitation**, which the Sprint Specification permits recording rather than
simulating: required reviewers here would mean the sole maintainer approving
their own deployment — a log entry, not a control. It is therefore **not** an
ORG-PR-001 blocker.

Branch protection ruleset `19769611`: active, **zero bypass actors**, unchanged.

## 17. Sprint 27 repository remote-validation evidence

The Sprint 27 changes were published and validated remotely.

| | |
| --- | --- |
| Branch | `sprint-27-deployment-pipeline-closure` |
| Head commit | `0b6e6967bb95f26f211df29671210926eb136b75` |
| Pull request | **#40** → `main`, merge state **CLEAN** |

All six required checks, observed on the published head:

| Check | Workflow | Result |
| --- | --- | --- |
| `Validate (offline)` | CI | **PASS** |
| `Integration (PostgreSQL + Redis)` | CI | **PASS** |
| `Artifacts (build + smoke)` | CI | **PASS** |
| `Dependency audit (pnpm)` | Security scans | **PASS** |
| `Secret scan (Gitleaks)` | Security scans | **PASS** |
| `Analyze (javascript-typescript)` | CodeQL | **PASS** |
| `CodeQL` (rollup) | CodeQL | **PASS** |

The six required checks live in **three** workflows, not six: three are jobs
inside CI, two inside Security scans, one is the CodeQL job.

**Two evidence classes, deliberately kept separate.** *Application-release
operational evidence* (§§4–16) concerns the pre-existing published releases and
the real target. *Repository-change validation* (this section and §18) concerns
the Sprint 27 code and documentation themselves. Both are now complete; they
answer different questions and are not interchangeable.

**Not required, with reasons.** *Data durability* — its owned surface is
untouched (`tooling/db-backup.sh`, `db-restore-drill.sh`, `db-pitr-drill.sh`,
`tooling/lib/pg-tools.sh`, the restore fixture, and `apps/api/src/maintenance`
are all unchanged); exercising the deployment's backup preflight is not such a
change. *Release* — `release.yml` is unchanged and Sprint 27 published no new
application release; a Release run will fire automatically when PR #40 merges to
`main`, which is normal repository behaviour rather than a Sprint 27 gate.
*A second Deploy run* — `deploy.yml` is unchanged and the deployed releases are
pre-existing; run `33061763360` already provides the operational validation, and
re-dispatching would only duplicate evidence.

## 18. Deployment Rehearsal run evidence

The deployment tooling changed, so `docs/validation.md`'s own rule required a
rehearsal. `deployment-rehearsal.yml` has **no push trigger** — weekly cron and
`workflow_dispatch` only — so it was **dispatched manually**.

| | |
| --- | --- |
| Workflow | `deployment-rehearsal.yml` |
| Run | **`33065548416`** |
| Event | `workflow_dispatch` |
| Branch | `sprint-27-deployment-pipeline-closure` |
| Head SHA | `0b6e6967bb95…` — the exact published head |
| Job | `Deployment rehearsal (publish, deploy, roll back)` |
| Result | **PASS** |

It exercises the whole lifecycle against a throwaway registry and throwaway
backing services: build once → publish → digest capture → manifest → deploy by
digest → migrate once → verified head → readiness → smoke → evidence → second
release → rollback → running-digest verification, plus its documented refusals.

**A rehearsal is not target validation** — that distinction held throughout
Sprint 27 and holds here. This run validates the *changed tooling*; §§4–16
validate the *target*.

## 19. Security-sensitive evidence handling

| Control | Result |
| --- | --- |
| Secret files printed | **never** — `runtime.env` and `deploy.env` were inspected only for existence, ownership, mode, variable names, and boolean classifications |
| `runtime.env` permissions | mode 600, owner-only; the deployment's own permission gate verified it |
| `deploy.env` permissions | mode 640, owner-only write; contains no secrets by contract |
| Raw environment dumps | none — no `env`, no `printenv`, no `docker inspect … Config.Env` |
| Shell tracing | no `set -x` on any path handling a secret |
| Database credentials | read into a variable, passed only to a container environment, never a command line, never logged |
| Registry credential | none exists on the host |
| **Evidence scan** | every evidence file scanned: the only credential-shaped word matches are the gate check *name* `"Secret scan (Gitleaks)"`; the only long opaque strings are SHA-256 image digests, the public-config fingerprint, commit SHAs, and GitHub URLs. **No credential-bearing URL, no credential-named key, and no secret value appears anywhere** |
| Repository secret scan | `pnpm scan:secrets` (Gitleaks, full history) — **no leaks**; the remote `Secret scan (Gitleaks)` required check also **PASS** |

Deployment evidence records the browser's public configuration as a
**fingerprint** plus the published public contract only, so a secret cannot be
written into evidence even by mistake.

## 20. ORG-PR-001 closure rationale

The finding's validation criterion was *"a tagged build deploys to a target
environment reproducibly; container runs as non-root."* Every element of its
closure list is satisfied by evidence from a **durable external target**, not a
rehearsal:

| Required element | Evidence |
| --- | --- |
| Durable external target exists | §4 — survives container restart with data intact; Docker enabled at boot; restart policies; named volume |
| Target-side immutable image pulls | §5, §6 — the host pulled all four digests itself, with no registry credential present |
| Real digest deployment | §9, §10 — two gate-authorised releases, digest-pinned, no `build:` section anywhere |
| Backup/PITR preflight | §7 — `taken` twice, with checksums and provenance sidecars |
| Migration | §8 — applied exactly once per deployment from the release's own image |
| Verified migration head | §8 — `0012_shocking_warbound` (13) against Drizzle's ledger |
| Real public API/web operation | §11 — pre-deploy 502s became 200 on both public HTTPS origins |
| HTTPS post-deployment smoke | §11 — 9/9, three times, from outside the host |
| Second compatible release | §6, §10 — identical migration identity, pre-existing, not manufactured |
| Real application rollback | §13 — Release 1's exact digests restored with `--no-migrate` |
| HTTPS rollback smoke | §13 — 9/9 |
| Deployment evidence | §9, §10 — machine-generated records on the host |
| Rollback evidence | §13 — machine-generated rollback record |
| Deployment environment boundary reconciled | §16 — environment-scoped, branch policy active, reviewer limitation documented |
| Non-root runtime | unchanged since Sprint 23, re-proven by the artifact gate that authorised both releases |

**ORG-PR-001: CLOSED.**

**What the closure does not mean.** It is not staging readiness (§22), not
production readiness (§23), not backup operations (§7), not email validation,
and not secrets management. Those are separate findings with separate criteria.

## 21. Remaining open findings

| Finding | Sev | Status | Why it stays open |
| --- | --- | --- | --- |
| **ORG-PR-002** — No production email provider | **P1** | **OPEN** | No provider was contacted, no mail reached a real recipient, no sender domain was authenticated. The staging Mailpit sink has no external relay. Closure requires an external provider, real inbox receipt, and SPF/DKIM/DMARC alignment |
| **ORG-PR-005** — No database backup / PITR / tested restore | **P1** | **OPEN** | Two real pre-migration backups is a deployment boundary, not backup operations. Nothing schedules, stores off-host, encrypts, archives WAL, or monitors archive health; no RPO/RTO measured; the target has no PITR window; no real-target restore or PITR drill performed |
| **ORG-PR-006** — No secrets management or rotation | **P1** | **OPEN** | Runtime secrets are a 0600 file on a host. The GitHub Environment branch policy is a deployment boundary, not secrets management, and public package visibility removes a secret rather than managing one. No secret store, access control, read auditing, expiry tracking, or automated rotation |
| **ORG-PR-007** — No observability | P2 | OPEN | No metrics, tracing, dashboards, or alerting anywhere, including on the validated target |
| **ORG-PR-009** — Rate limiting alerting residual | P2 | OPEN | Sensitive buckets fail closed in production (Sprint 19); the alerting residual folds into ORG-PR-007 |
| **ORG-PR-055** | P3 | OPEN | Tracked in the findings register |
| **ORG-PR-049** | P4 | OPEN | Tracked in the findings register |

The [findings register](findings-register.md) remains authoritative.

## 22. Staging-readiness assessment

```
Staging ready: NO
```

ORG-PR-001 closing is a **finding** closure, not an environment-readiness
declaration, and the repository's taxonomy separates the two deliberately. Two
evidence-backed limitations keep staging readiness at NO:

1. **Account email delivery does not work on the target.** `MAIL_DRIVER=smtp`
   points at the Mailpit sink on plaintext port 1025, while Orgistry's smtp
   driver uses implicit TLS with certificate verification always on and Mailpit
   carries no `--smtp-tls*` flag. The API boots, `/health` and `/ready` answer
   over public HTTPS, and all nine smoke checks pass — but account-email
   **sends fail closed**, so registration, verification, and invitation flows
   will error there. That is the correct architectural behaviour (mail failures
   must never silently disappear in production mode) and it was not exercised by
   Sprint 27, whose smoke is unauthenticated by design. Fixing it means giving
   the sink a publicly-trusted certificate on an SMTPS port — **not** adding a
   provider. **ORG-PR-002 is unaffected either way.**
2. **No observability on the target** (ORG-PR-007, ORG-PR-009). No metrics,
   dashboards, log shipping, or alerting on a failed deployment, a failed
   migration, or a fail-closed rate limiter. An environment nobody can observe
   cannot be operated as a production rehearsal.

Neither is an ORG-PR-001 criterion, and neither was in Sprint 27's scope. They
are recorded rather than fixed.

## 23. Production-readiness assessment

```
Production ready: NO
```

Three P1 blockers remain open (ORG-PR-002, ORG-PR-005, ORG-PR-006). Production
readiness must remain false while any P1 blocker is open, and the validated
target holds **synthetic data only**, has no production data path, no production
email, no backup programme, no secrets platform, and no observability. **A
successful staging deployment does not make the project production ready**, and
no production-readiness claim is made anywhere in this artifact.

The readiness classification remains **C — Ready to continue production
implementation**.

## 24. Known limitations

- **Single-host architecture.** No HA, no autoscaling, no multi-region. That is
  the ratified target profile, not an oversight.
- **Published images are single-architecture `linux/amd64`.** Enforced rather
  than merely documented since Sprint 27: the preflight and deployment stage 5
  refuse a platform mismatch before anything touches the database, and emulation
  is an explicit opt-in recorded on the deployment evidence. It remains a **host
  procurement constraint** — select an amd64 target unless a future authorised
  sprint changes the publication architecture.
- **Account email does not work on the staging target** — see §22.
- **The public `mailpitUrl` is not a remote inbox.**
  `ORGISTRY_PUBLIC_MAILPIT_URL` defaults to `http://localhost:8025` and is
  served to every browser, but `localhost` resolves on the **visitor's own
  machine**, and the host binds the Mailpit UI to its own loopback and publishes
  nothing (port 8025 externally probed and confirmed closed). The served link
  therefore reaches nothing for a remote browser. It is **not** a leak (a
  loopback literal discloses nothing), not a deployment defect, and not an
  ORG-PR-001 blocker — a **staging/demo limitation only**. An operator inspects
  the sink over an SSH tunnel, deliberately, since exposing Mailpit publicly
  would put captured message bodies carrying raw verification tokens on the
  internet.
- **No observability or alerting** anywhere (ORG-PR-007, ORG-PR-009).
- **No backup programme** — no scheduling, off-host storage, encryption, WAL
  archival, or measured RPO/RTO; no PITR window on the target (ORG-PR-005).
- **No secrets platform** — runtime secrets are a host file (ORG-PR-006).
- **No production email** (ORG-PR-002).
- **Reviewer separation unavailable** on a single-maintainer repository —
  documented, not simulated.
- **Rollback under real user traffic is untested** — the target has synthetic
  data and no users.
- **No artifact signing and no SLSA provenance** — deliberately out of scope.
- **No infrastructure-as-code.** The target was provisioned by the operator by
  hand; the repository controls the deployment, not the host's existence.
- **Public GHCR visibility is an observed state, not an approved policy** — see
  §6.

## 25. Validation matrix

### Real target

| Check | Result |
| --- | --- |
| Target preflight (on the host) | **PASS** — 0 failed, 0 warned |
| Target-side GHCR digest pulls (4 images) | **PASS** — no credential on the host |
| Release 1 deployment (full stage sequence) | **PASS** |
| Release 2 deployment (full stage sequence) | **PASS** |
| Backup preflight ×2 | **PASS** |
| Migration + verified head | **PASS** |
| Public HTTPS smoke ×3 | **PASS** — 9/9 each |
| Running-digest verification ×3 | **PASS** |
| Real application rollback | **PASS** |
| Restart / persistence | **PASS** |
| External port-exposure probe | **PASS** |
| Evidence secret-hygiene scan | **PASS** |
| Deploy workflow run `33061763360` | **PASS** |
| Real-target restore / PITR drill | **NOT APPLICABLE** — out of scope; not claimed |

### Local repository validation

| Check | Result |
| --- | --- |
| `pnpm validate` | **PASS** — 1032 unit + 94 web tests |
| `pnpm validate:integration` | **PASS** — 16 + 103 tests |
| `git diff --check` | **PASS** |
| `pnpm scan:deps` / `pnpm scan:deps:local` | **PASS** |
| `pnpm scan:secrets` | **PASS** |
| `actionlint` | **PASS** |
| `shellcheck -x` on deployment scripts | **PASS** |
| `tooling/artifact-smoke.sh` | **PASS** |
| `pnpm deploy:rehearsal` | **PASS** — 65 assertions |
| `pnpm drill:restore` | **PASS** |
| Retention cleanup dry run | **PASS** |
| Documentation link/anchor validation | **PASS** — 0 issues |
| `pnpm drill:pitr` | **NOT APPLICABLE** — PITR tooling untouched |

### Remote validation (PR #40, head `0b6e6967bb95…`)

| Check | Result |
| --- | --- |
| CI — `Validate (offline)` | **PASS** |
| CI — `Integration (PostgreSQL + Redis)` | **PASS** |
| CI — `Artifacts (build + smoke)` | **PASS** |
| Security scans — `Dependency audit (pnpm)` | **PASS** |
| Security scans — `Secret scan (Gitleaks)` | **PASS** |
| CodeQL — `Analyze (javascript-typescript)` | **PASS** |
| CodeQL rollup | **PASS** |
| Deployment rehearsal run `33065548416` | **PASS** |
| Data durability | **NOT APPLICABLE** — owned surface untouched |
| Release | **NOT APPLICABLE** — unchanged; no new release published |

## 26. Definition-of-Done reconciliation

| DoD element | Evidence | Result |
| --- | --- | --- |
| Durable external target | §4 | **YES** |
| Target preflight | §5 | **PASS** |
| Immutable digest deployment | §9, §10 | **PASS** |
| Backup preflight | §7 | **PASS** |
| Migration | §8 | **PASS** |
| Migration-head verification | §8 | **PASS** |
| Public API/web HTTPS operation | §11 | **PASS** |
| Release 1 deployment | §9 | **PASS** |
| Second compatible release deployment | §10 | **PASS** |
| Real application rollback | §13 | **PASS** |
| Rollback public smoke | §13 | **PASS** |
| Deployment evidence | §9, §10 | **PASS** |
| Rollback evidence | §13 | **PASS** |
| GitHub Environment / Deploy workflow validation | §16 | **PASS** |
| Local validation | §25 | **PASS** |
| Remote CI | §17 | **PASS** |
| Remote Security scans | §17 | **PASS** |
| Remote CodeQL | §17 | **PASS** |
| Remote Artifacts (build + smoke) | §17 | **PASS** |
| Deployment Rehearsal | §18 | **PASS** |
| Repository publication | branch pushed, PR #40 opened, merge state CLEAN | **YES** |
| Documentation synchronized with evidence | §27 | **YES** |
| Scope control observed | §2 | **YES** |

**No mandatory Sprint 27 requirement remains unsatisfied.**

```
Sprint 27 DoD met: YES
```

## 27. Final Sprint 27 conclusion

Sprint 27 is **complete**. Its objective — validate the deployment mechanism
against a real durable external staging-like target and reconcile ORG-PR-001
honestly — was met with evidence rather than assertion, and the sprint's own
repository changes passed every mandatory remote gate at the published head.

```
Sprint 27 DoD met:                   YES
ORG-PR-001:                          CLOSED
ORG-PR-002:                          OPEN
ORG-PR-005:                          OPEN
ORG-PR-006:                          OPEN
Real staging-like target validated:  YES
Staging ready:                       NO
Production ready:                    NO
```

The most valuable thing Sprint 27 produced may not be the closure itself but the
two defects that real external contact exposed and no local rehearsal could:
the mistaken package-visibility record, and a deployment that would have failed
late and misleadingly on any arm64 host — after the backup preflight and
migration had already run. Both are fixed and regression-tested. That is the
argument for validating against reality rather than against a model of it.

### Recommended next sprint

**Sprint 28 — Backup and Recovery Operations Closure (ORG-PR-005).**

This follows the authoritative roadmap and the dependency structure in the
findings register, not preference. ORG-PR-005 is P1, and its larger half was
explicitly blocked on the absence of a deployment environment — a blocker
ORG-PR-001's closure removes. Now executable against the real target: scheduled
backups, off-host encrypted storage, continuous WAL archiving with
archive-health monitoring, a measured RPO/RTO, and the piece Sprint 27
deliberately did not attempt — a **real-target restore and PITR drill**.

Secondary candidates, in the roadmap's recorded order: **ORG-PR-002** (external
email provider closure, which would also make the staging environment
exercisable end to end), **ORG-PR-006** (secrets platform integration), and
**ORG-PR-007/009** (observability, without which the staging environment cannot
be operated as a production rehearsal).

Multi-architecture publishing remains unnecessary — the validated target is
amd64.
