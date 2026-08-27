# Sprint 27 Evidence Package — Deployment Pipeline Closure

```
Status: REAL-TARGET OBJECTIVE ACHIEVED
        ORG-PR-001 CLOSED
        SPRINT 27 CLOSURE PENDING REMOTE VALIDATION
```

**Date of this revision:** 2026-08-27 · **Finding:** ORG-PR-001 — **CLOSED on
real-target evidence**

**This is the single living Sprint 27 evidence package, and it is NOT yet the
final closing artifact.** It is updated in place. Sprint 27's real-target
objective is achieved and ORG-PR-001 is closed, but the sprint's own definition
of done additionally requires that the Sprint 27 *repository changes* pass the
mandatory remote workflows — and those changes are still uncommitted. This
artifact is finalized in place, here, once the operator publishes and those
workflows are observed green. **No second Sprint 27 artifact should be created.**

```
Sprint 27 real-target objective   ACHIEVED
ORG-PR-001 closure                ACHIEVED
Sprint 27 DoD                     NOT YET MET
Reason                            operator publication + mandatory remote
                                  workflow validation outstanding
```

```
Real staging-like target validated   YES
ORG-PR-001                           CLOSED
Sprint 27 DoD met                    NO   (remote validation outstanding)
Staging ready                        NO   (see §16)
Production ready                     NO
```

## Evidence tiers used in this document

Never treated as synonyms. Each claim below is labelled with its tier.

| Tier | Meaning | Status |
| --- | --- | --- |
| Repository-controlled capability | Tooling exists and is tested | achieved |
| Local rehearsal (built artifacts) | `pnpm deploy:rehearsal`, throwaway registry | achieved (Sprint 26) |
| Published-artifact local rehearsal | The real GHCR images on a workstation | achieved (Sprint 27, superseded below) |
| Remote rehearsal | The repository's own workflows on GitHub Actions | achieved (Sprint 26) |
| **Real staging-like target validation** | **A durable host, public HTTPS origins, real TLS** | **ACHIEVED 2026-08-27** |
| Staging readiness | The above plus an operable environment | NOT ACHIEVED — §16 |
| Production readiness | All P1 blockers closed | NOT ACHIEVED |

The earlier published-artifact local rehearsal is retained below as supporting
history. **It is subordinate to the real-target evidence and must not be cited
in its place.**

## Summary of this revision

Sprint 27's objective — validate the Sprint 26 deployment mechanism against a
durable external staging-like target — **has been met**. On 2026-08-27 the
pipeline was executed end to end against a real DigitalOcean host serving public
HTTPS origins:

```
target preflight → target-side digest pulls → deploy 91664d0 → backup preflight
→ migrate once → verified head → health/readiness → public HTTPS smoke 9/9
→ running-digest verification → evidence → restart/persistence check
→ deploy d51c76b → public HTTPS smoke 9/9 → rollback to 91664d0
→ public HTTPS rollback smoke 9/9 → running-digest verification → evidence
```

Every element of ORG-PR-001's closure list is now satisfied by evidence from a
durable target, so **ORG-PR-001 is CLOSED**. Sprint 27 itself is not finished:
its repository changes are still uncommitted, so the required remote workflow
validation has not been observed. ORG-PR-002, ORG-PR-005, and ORG-PR-006 remain
open on their own independent criteria, and production readiness remains NO.

## 0. Real target — validated infrastructure

| | |
| --- | --- |
| Provider / region | DigitalOcean, FRA1 |
| Sanitized identity | `orgistry-staging-01` (public IP recorded in operator infrastructure records) |
| Architecture / OS | `linux/amd64` (x86_64) · Ubuntu 24.04.4 LTS · kernel 6.8.0-138-generic |
| Resources | 2 vCPU · 4 GiB RAM · ~74 GiB free on `/opt` |
| Runtime | Docker Engine 29.7.2 · Compose v5.5.0 · bash 5.2.21 · curl 8.5.0 · node v22.23.2 |
| Durability | Docker enabled at boot; all containers `restart=unless-stopped`; PostgreSQL on a named volume |
| Public origins | `https://staging.drsvp.com` (web) · `https://api-staging.drsvp.com` (API) |
| Edge | Caddy v2.11.4, active and enabled; Let's Encrypt certificates valid to 2026-11-25; HTTP→HTTPS `308` |
| Inbound exposure | **22, 80, 443 only** — externally probed and confirmed (§7) |
| Backing services | PostgreSQL 16.14-alpine and Redis 7.4.10-alpine, digest-pinned, on `orgistry-deploy`, **no host port bindings** |
| Data classification | **Synthetic only.** No real user data |
| Operator | `daniel`, ED25519 key, root login and password auth disabled |
| Deployment directory | `/opt/orgistry/{config,deploy,evidence,backups,data}` |
| Registry credential | **none exists on the host** — `~/.docker/config.json` absent; both digests pulled anonymously |

**No source build occurs on the target.** Only the deployment tooling dependency
closure was transferred (13 files: `tooling/`, `tooling/lib/`, and
`infra/compose.deploy.yml`). No Dockerfile, no application source, no
`packages/` — verified at transfer time. `infra/compose.deploy.yml` contains
zero `build:` sections, asserted by the deployment itself.

---

## 1. Implementation summary

Sprint 26's architecture was **preserved, not redesigned**. No parallel
deployment mechanism was introduced. Two executable additions, one of them a
single new stage inside the existing sequence.

| Path | Change | Why |
| --- | --- | --- |
| `tooling/lib/deploy-common.sh` | `deploy_normalize_architecture`, `deploy_image_platform`, `deploy_host_platform`, `deploy_assert_image_runs_on_host`, and the `DEPLOY_EMULATED_PLATFORM` marker | The deployment had no way to know whether the images it pulled could run on the host it was pulling them onto |
| `tooling/deploy.sh` | New **stage 5**, immediately after the digest pull and before the backup preflight; emulation, when opted into, is appended to the deployment record's `limitations` | A platform mismatch must abort while the target is still untouched — not after a backup and a migration have run |
| `tooling/deploy-target-preflight.sh` (new), `pnpm deploy:preflight` | Read-only host qualification: toolchain, host baseline and boot persistence, release pullability and platform *from that host*, and the configuration boundary | The repository could deploy to a host but had no way to decide whether a host was a candidate at all |
| `tooling/lib/deploy-common.sh` | `deploy_require_determined_platform`, called by both getters and again at the decision point | **Fail-open defect found in review.** `docker image inspect`/`docker info` exit 0 even when a template field renders empty, producing `"/"`; if that happened on both sides the equality check would MATCH and the gate would pass by accident |
| `tooling/deploy-target-preflight.sh` | Refuses a non-digest image reference before pulling | The stage collects failures rather than exiting, so an invalid manifest could otherwise have led the preflight into resolving a mutable tag |
| `tooling/deploy-platform-guard.test.ts` (new) | 18 tests driving the real shell functions through bash, including the fail-open regression | Inside the required `Validate (offline)` check. Deliberately not a TypeScript re-implementation of the rule — that would prove only that two copies agree |
| `tooling/deploy-smoke.sh` | Header renumbered 1–9 | It performs nine checks and always did; the header merged two of them |
| `packages/config/src/config.test.ts` | One regression test: an isolated non-provider SMTP endpoint loads under `NODE_ENV=production` | Pins the invariant a staging-like deployment depends on — that production-mode validation constrains the mail driver, credential, and sender domain but not the endpoint's identity. Without it, a later tightening of the mail policy would silently make staging deployment impossible. No production rule was weakened |
| `package.json` | `deploy:preflight` script | Entry point |

Documentation updated in the same pass: `docs/deployment.md` (scope guard,
package visibility, stage table, host baseline, architecture constraint,
operator runbook, external actions, limitations, staging blockers, Sprint 27
evidence and changelog), `docs/validation.md`, `docs/known-limitations.md`,
`docs/production-readiness/findings-register.md`, and the readiness documents
listed in §14.

**Read-only contract.** `tooling/deploy-target-preflight.sh` is read-only with
respect to application, database, host, and remote state. It may inspect
versions, file modes, and directory writability; pull and inspect immutable
digest-pinned images; compare architectures; and structurally validate
non-secret configuration. It must never run a migration, touch the application
database, start or reconfigure the deployment, change firewall or host
configuration, persist a secret, or mutate GitHub settings or package
visibility. The contract is stated in the script header and enforced by review;
a check needing any of the second list belongs in `tooling/deploy.sh`.

### What was deliberately NOT built

Multi-architecture image publishing. It is the *other* answer to the
architecture constraint, and a defensible one — but it changes the release
workflow's build and digest model, and that belongs to a sprint that owns the
decision. Sprint 27 makes the constraint enforced and visible instead of
silent, and records the alternative.

---

## 2. Target provisioning summary

**A durable staging-like target now exists and has been validated.** It was
provisioned by the operator (DigitalOcean droplet, Caddy edge, DNS, TLS,
PostgreSQL, Redis, Mailpit sink, firewall) and qualified by this repository's
own preflight before anything was deployed to it. Full inventory: §0.

### Target preflight — PASS

`tooling/deploy-target-preflight.sh`, executed **on the target** against the
Release 1 manifest: **0 failed, 0 warned**, exit 0.

| Group | Result |
| --- | --- |
| Toolchain | `docker`, `curl`, `node`, Compose v2 (5.5.0), and the tooling tree all present |
| Host baseline | Docker daemon reachable, platform **`linux/amd64`**; **Docker service enabled at boot** |
| Release | manifest valid; **both images pulled from GHCR by the target itself**; both image platforms match the host |
| Configuration | `ORGISTRY_ENVIRONMENT_CLASS=deployment`; `runtime.env` readable only by its owner; API and web bound to `127.0.0.1`; browser-facing API origin is HTTPS; evidence and backup directories writable and not world-writable |

Sanitized baseline emitted by `--json`:

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

The preflight honoured its read-only contract: it started no Orgistry container,
ran no migration, touched no application database or Redis state, altered no
firewall rule, and mutated no GitHub setting. Its only write was pulling two
immutable content-addressed images into the local image cache.

**The `linux/amd64` host procurement constraint was satisfied and verified by
the gate**, not merely assumed — the platform check passed natively on a real
amd64 host, the same check that refused an arm64 workstation earlier in Sprint 27.

## 3. Environment taxonomy confirmation

The five names are unchanged. What changed is that **`staging-like deployment
target` now exists**, where the taxonomy previously recorded `no`.

| | Sprint 26 rehearsal | Published-artifact local rehearsal | **Real staging-like target (2026-08-27)** |
| --- | --- | --- | --- |
| Images | built locally | pulled from GHCR | **pulled from GHCR, by the target** |
| Release authority | rehearsal, `deployable: false` | published, gate-authorised | **published, gate-authorised** |
| Host | workstation / CI runner | workstation | **durable DigitalOcean droplet** |
| Durability | none | none | **Docker enabled at boot; restart policies; named volume; data survived a restart** |
| TLS / DNS / public origin | none | none | **real Let's Encrypt TLS, public DNS, HTTPS origins** |
| Architecture | native | amd64 under emulation | **native `linux/amd64`** |
| Smoke | loopback | loopback | **public HTTPS, 9/9, three times** |
| Counts as target validation | no | no | **YES** |

## 4. Host baseline

Recorded in §0 and by the preflight's `--json` output in §2. The host is a
durable single-purpose droplet, not a CI runner and not a workstation.

## 5. GHCR pull evidence — observed state, and target-side proof

**Observed state: the API and web GHCR packages are currently publicly
pullable.** Sprint 26 recorded them as private; that was wrong.

**Target-side proof (2026-08-27), which supersedes the earlier workstation
pull.** The deployment host has **no registry credential of any kind** —
`~/.docker/config.json` does not exist on it — and it pulled both images for
both releases by digest:

```
ghcr.io/danielrosenberg00/orgistry-api  sha256:9b79d72c045f…  377MB
ghcr.io/danielrosenberg00/orgistry-web  sha256:20dc434b7b62…  82.6MB
```

The Deploy workflow independently resolved the same digests in the registry
(run `33061763360`).

### Observed state vs. approved policy

**No approved visibility policy exists in this repository.** Sprint 27
*observed* the state, *corrected the record*, and *changed nothing* — no package
setting was touched.

| | |
| --- | --- |
| **Observed state** | Both packages are currently publicly pullable |
| **Operational implication** | The staging host requires no GHCR pull credential — proven, not assumed: none exists on it |
| **Security implication** | While public, the images must contain nothing secret — already enforced by `tooling/artifact-smoke.sh`. What is disclosed is dependency versions and file layout, which the public source tree already discloses |
| **Policy implication** | Must stay explicitly visible in `docs/deployment.md` and the security assessment, and must **not** be mistaken for a secrets-management capability. It closes nothing in ORG-PR-006 |
| **Reversibility** | If an operator makes the packages private, every deployment host then needs a long-lived read-only pull credential |

## 6. Deployment configuration summary

Unchanged from Sprint 26 — the two-file split (`deploy.env` for *how*, 0600
`runtime.env` for *what*) held on a real host:

```
/opt/orgistry/config/runtime.env   mode 600  owner daniel:daniel   (every runtime secret)
/opt/orgistry/config/deploy.env    mode 640  owner daniel:daniel   (no secrets)
```

Neither file was printed at any point in this execution. Only names, modes,
ownership, and boolean classifications were inspected. The deployment's own
permission gate accepted `runtime.env` as owner-readable-only.

The target ran `ORGISTRY_ENVIRONMENT_CLASS=deployment`, so it exercised the
**real** release-eligibility path: only a published, gate-authorised manifest was
accepted.

### Staging mail boundary as actually configured

| Observed | Value |
| --- | --- |
| `MAIL_DRIVER` is `smtp` | yes |
| `SMTP_HOST` points at the Mailpit sink | yes |
| `SMTP_PORT` | 1025 (plaintext), not 465 |
| Mailpit `--smtp-tls*` flag | not present |

This is the second of the two documented sub-cases in
[Staging mail model](../deployment.md#staging-mail-model): the deployment
**boots, becomes ready, and passes all nine smoke checks**, because SMTP is
neither a boot dependency nor a readiness probe — but because Orgistry's `smtp`
driver uses implicit TLS with verification always on, account-email *sends*
against a plaintext sink will **fail closed**. That is the correct architectural
behaviour (mail failures must never silently disappear in production mode), it
was **not exercised** by Sprint 27 (all smoke is unauthenticated by design), and
it is recorded as a staging-readiness limitation in §16.

**No production email provider is involved, and none is required.** The Mailpit
sink has no external relay and delivers to no real recipient.
**ORG-PR-002 remains open** — nothing here proves delivery.

## 7. Selected release manifests and digests

Both releases re-validated from their published manifests at execution time,
with full identities. **Neither was manufactured for this test** — both already
existed on `main` from Sprint 26.

| | **Release 1 (deployed first, rollback target)** | **Release 2** |
| --- | --- | --- |
| Source commit | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` | `d51c76b5ee6b0d6183b76ac4b8efacdee94ae704` |
| Source ref | `refs/heads/main` | `refs/heads/main` |
| Release run | `32776576782` | `32779601026` |
| Type / deployable | `published` / **true** | `published` / **true** |
| Provenance | `commit` | `commit` |
| API digest | `sha256:9b79d72c045fe594f3b381eb35fbd458a414ea6056acd64f4807ee2157246b8f` | `sha256:7afc079b3844f58ae3c24524a8b7c0739582391a5224b7cfc83e621d2e027148` |
| web digest | `sha256:20dc434b7b62f933e91b3efd70c2aa5d89c559c52ff088ef28cabf98f00d2855` | `sha256:b0d5dd000ab2ea034036768e15a91e0f47f1e5bc3709e1340692b5eb2dfac5b1` |
| Migration head | `0012_shocking_warbound` | `0012_shocking_warbound` |
| Migration count | 13 | 13 |
| Journal timestamp | `1787555203153` | `1787555203153` |
| `gates.headSha` | equals its own source commit | equals its own source commit |
| Artifact gate | `passed` | `passed` |

Gate authorisation, all six required checks `success`, bound to each release's
exact SHA:

| Check | Release 1 run | Release 2 run |
| --- | --- | --- |
| Validate (offline) | `32776576684` | `32779600982` |
| Integration (PostgreSQL + Redis) | `32776576684` | `32779600982` |
| Artifacts (build + smoke) | `32776576684` | `32779600982` |
| Dependency audit (pnpm) | `32776576586` | `32779600966` |
| Secret scan (Gitleaks) | `32776576586` | `32779600966` |
| Analyze (javascript-typescript) | `32776576905` | `32779601072` |

**Rollback compatibility verified explicitly:** identical migration head,
identical count, and identical journal timestamp. Rolling between them crosses
no migration boundary — the precondition for a safe application rollback.

## 8. Migration evidence — real target

| | |
| --- | --- |
| Executed | once per deployment, as its own container, from the release's own API image (`docker compose run --rm migrate`) |
| Release 1 (`91664d0`) | `Migrations applied successfully.`, container exit 0 |
| Release 2 (`d51c76b`) | `Migrations applied successfully.`, container exit 0 (no-op — same head) |
| Head verified | `0012_shocking_warbound`, **13 applied migrations**, checked against the manifest through Drizzle's own ledger, on the target's real PostgreSQL |
| API boot | did **not** run migrations — the API service never migrates at boot |
| Rollback | ran with `--no-migrate`; migrations neither re-run nor reversed; recorded `migration.result: skipped` |
| Post-rollback ledger | still **13** — application rollback demonstrably did not touch the schema |
| Credential exposure | none — the database URL is read into a variable and passed only to a container environment, never a command line, never logged, never written to evidence |

## 9. Backup / PITR preflight evidence — real target

The Sprint 25 durability tooling executed for real, on the target, before each
migration:

| Deployment | Preflight | Artifact |
| --- | --- | --- |
| Release 1 | `taken`, recovery point `2026-08-27T10:03:59Z` | `orgistry-20260827T100354Z-pre-deploy.dump` (+ `.sha256`, `.meta.json`) |
| Release 2 | `taken`, recovery point `2026-08-27T10:06:59Z` | `orgistry-20260827T100654Z-pre-deploy.dump` (+ `.sha256`, `.meta.json`) |
| Rollback | `skipped`, with the recorded reason "runs no migrations, so it creates no new recovery-point requirement" | — |

Backups live in `/opt/orgistry/backups` on the target, mode 0750, owner-only
group access.

**PITR/WAL availability on this target: NONE.** The staging PostgreSQL does not
archive WAL, so no point-in-time recovery window exists here. The staging policy
applied was `ORGISTRY_BACKUP_PREFLIGHT=take`, which requires a successful
logical backup and aborts the deployment if it fails — it did not fail.

**This is the deployment boundary working. It is not backup operations.**
Nothing schedules a backup, nothing stores one off-host, nothing encrypts one at
rest, no WAL archival or archive-health check exists, and no RPO/RTO is
measured. **ORG-PR-005 remains open**, and no real-target restore or PITR drill
was performed — none is claimed.

## 10. Public post-deployment smoke evidence — real HTTPS

`tooling/deploy-smoke.sh` executed **from outside the host, over the public
internet**, against the real origins. **9/9 checks passed, three times:**

| Run | API origin | Web origin | Result |
| --- | --- | --- | --- |
| After Release 1 | `https://api-staging.drsvp.com` | `https://staging.drsvp.com` | **9/9 PASS** |
| After Release 2 | same | same | **9/9 PASS** |
| After rollback | same | same | **9/9 PASS** |

Checks: `/health`; `/ready`; coarse readiness disclosure under
`NODE_ENV=production`; six baseline security headers; request-ID propagation
through the Caddy reverse proxy; production web build; SPA history fallback; the
served browser API origin; and the absence of any environment origin inside the
immutable bundle.

The deployment additionally ran its own loopback smoke as stage 13 of each
deployment (also 9/9), configured with
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

**`mailpitUrl` is not a remote inbox.** That value is a link handed to the
*visitor's browser*, where `localhost` means the visitor's own machine. The
target binds the Mailpit UI to its own loopback and publishes nothing (port 8025
externally probed and confirmed closed), so the served link reaches nothing for
a remote browser. It is neither a leak (a loopback literal discloses nothing)
nor a deployment defect nor an ORG-PR-001 blocker — it is a staging/demo
limitation, recorded so it is not mistaken for a working staging inbox. An
operator inspects the sink over an SSH tunnel. See
[deployment.md](../deployment.md#the-public-mailpit-url-is-not-a-remote-inbox).

## 11. Second release and real rollback evidence

| Step | Evidence |
| --- | --- |
| Deploy `91664d0` | backup taken, migration applied, head verified, API healthy, web up, running container digests asserted equal to the manifest, 9/9 loopback + **9/9 public HTTPS** smoke, evidence written |
| Restart / persistence | API and web restarted; `/ready` 200 again after 3s; migration ledger **13 before and 13 after**; public origins 200 again |
| Deploy `d51c76b` | same lifecycle, 9/9 loopback + **9/9 public HTTPS** smoke; ledger resolved the rollback target to `91664d0` |
| Rollback dry run | resolved `91664d0` (deployed `2026-08-27T10:04:15.026Z`) from the host's own ledger, using that release's stored manifest |
| **Rollback executed** | redeployed **`91664d0`'s exact digests** with `--no-migrate`; 9/9 loopback + **9/9 public HTTPS** smoke; rollback record written |
| Running-digest verification | `docker inspect` on both containers: API `sha256:9b79d72c045f…`, web `sha256:20dc434b7b62…` — resolved image IDs cross-checked as **MATCH** against Release 1's digest references |
| Schema | migration ledger unchanged at 13 — **application rollback did not reverse migrations** |

Ledger on the target (`/opt/orgistry/evidence/staging-like/records/`):

```
2026-08-27T10:04:15.026Z  deploy    91664d0fd639  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=none
2026-08-27T10:07:13.595Z  deploy    d51c76b5ee6b  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=91664d0fd639
2026-08-27T10:08:02.764Z  rollback  91664d0fd639  migration=skipped  backup=skipped  smoke=passed(9)  rollbackTarget=d51c76b5ee6b
```

Both deployed release manifests are stored in the ledger, so the host can resolve
a rollback without the registry API, an expired workflow artifact, or an operator
remembering a SHA.

**Evidence secret hygiene:** every evidence file was scanned. The only matches
for credential-shaped words are the gate check *name* `"Secret scan (Gitleaks)"`;
the only long opaque strings are SHA-256 image digests, the public-config
fingerprint, commit SHAs, and GitHub URLs. **No credential-bearing URL, no
credential-named key, and no secret value appears anywhere in the evidence.**

### Database rollback boundary — unchanged

```
application image rollback does not reverse database migrations
```

Recovery from a destructive migration is a restore or a PITR, not a rollback.
The Sprint 25 repository-controlled restore/PITR drills remain the only such
evidence; **no real-target restore or PITR rehearsal was performed**, and none is
claimed. This target has no WAL archiving, so it has no PITR window.

## 12. Deploy workflow evidence — real run bound to this deployment

`.github/workflows/deploy.yml` is unchanged and was dispatched for the release
actually running on the target.

| | |
| --- | --- |
| Run | **`33061763360`**, `workflow_dispatch`, branch `main`, **success** (2026-08-27T10:08:58Z) |
| Environment | **`staging-like`** — confirmed by the GitHub deployments API: `{environment: "staging-like", ref: "main", task: "deploy"}` |
| Input | `release_run_id=32776576782` (the Release run for `91664d0`) |
| Manifest retrieval | downloaded the `release-manifest` artifact from that Release run |
| Manifest validation | `valid — published release, commit provenance, commit 91664d0…, migration head 0012_shocking_warbound, deployable: true` |
| Gate authorisation | `Release 91664d0fd639ca6ca8b5681317757bbcf0f0209b is authorised by:` followed by all six required checks |
| Registry proof | `resolving ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045f…` and `…orgistry-web@sha256:20dc434b7b62…` — both resolved |
| Target execution | **operator-assisted, by design.** The workflow verified and authorised; the operator executed `tooling/deploy.sh` on the host over SSH |

**The operator-assisted boundary was preserved deliberately.** GitHub Actions
still does not reach into the target, and **no inbound exposure was created to
make it able to** — the host's public surface is still 22/80/443 only. This is
the model recorded in Sprint 26 and it is unchanged.

### GitHub Environment protection — now partially configured

Observed 2026-08-27:

```
Environment exists:                                YES  (staging-like)
protection_rules:                                  [branch_policy]
deployment_branch_policy:                          {protected_branches: true, custom_branch_policies: false}
Required reviewer separation:                      NOT configured
```

The **deployment-branch restriction is now active** — the control recorded as
the actionable operator action in earlier Sprint 27 revisions has been applied by
the operator, so a `Deploy` dispatch from an arbitrary branch cannot reach
environment-scoped secrets. Nothing in this repository mutated it.

Reviewer separation remains unconfigured and is a **documented single-maintainer
limitation**, which the Sprint Specification permits recording rather than
simulating: required reviewers here would mean the sole maintainer approving
their own deployment — a log entry, not a control. It is therefore **not** an
ORG-PR-001 blocker.

Branch protection ruleset `19769611`: active, **zero bypass actors**, unchanged.

## 13. Validation results

### Real target

| Check | Result |
| --- | --- |
| Target preflight (`deploy-target-preflight.sh` on the host) | **PASS** — 0 failed, 0 warned |
| Target-side GHCR digest pulls, both images, both releases | **PASS** — no credential exists on the host |
| Release 1 deployment (full 14-stage lifecycle) | **PASS** |
| Release 2 deployment (full 14-stage lifecycle) | **PASS** |
| Backup preflight (twice) | **PASS** — `taken`, artifacts + checksums + provenance sidecars |
| Migration + verified head | **PASS** — `0012_shocking_warbound`, 13 |
| **Public HTTPS smoke ×3** | **PASS** — 9/9 each |
| Running-digest verification ×3 | **PASS** |
| Real application rollback | **PASS** |
| Restart / persistence check | **PASS** — ledger 13 before and after; `/ready` 200 after 3s |
| External port exposure probe | **PASS** — only 22/80/443 reachable |
| Evidence secret-hygiene scan | **PASS** — no credential material |
| Deploy workflow run `33061763360` | **PASS** — bound to `staging-like` |
| Real-target restore / PITR drill | **NOT PERFORMED** — out of Sprint 27 scope; not claimed |

### Repository

| Check | Result |
| --- | --- |
| `pnpm validate` | PASS |
| `pnpm validate:integration` | PASS |
| `git diff --check` | PASS |
| `pnpm scan:deps` / `scan:deps:local` / `scan:secrets` | PASS |
| `actionlint` | PASS |
| `shellcheck -x` on deployment scripts | PASS |
| `tooling/artifact-smoke.sh` | PASS |
| `pnpm deploy:rehearsal` | PASS — 65 assertions |
| `pnpm drill:restore` | PASS |
| Retention cleanup dry run | PASS |
| `pnpm drill:pitr` | NOT APPLICABLE — PITR tooling untouched |
| **Remote workflows for the Sprint 27 repository changes** | **BLOCKED** — changes are uncommitted working-tree modifications; the operator owns publication |

## 14. Documentation updated

`docs/deployment.md` · `docs/validation.md` · `docs/known-limitations.md` ·
`findings-register.md` · `production-roadmap.md` · `production-scorecard.md` ·
`launch-checklist.md` · `production-target.md` · `repository-inventory.md` ·
`security-assessment.md` · `standards-matrix.md` · this package.

## 15. Finding reconciliation

| Finding | Status | Rationale |
| --- | --- | --- |
| **ORG-PR-001** | **CLOSED** | Every element of the closure list is satisfied by evidence from a durable external target: the target exists and survives restart; it pulled immutable digests itself; two gate-authorised releases were deployed by digest; the backup preflight ran; migrations ran once with a verified head; the API and web serve real public HTTPS origins; public HTTPS smoke passed 9/9 three times; a real application rollback restored the previous known-good digests with verified running images; and machine-generated deployment and rollback evidence exists on the host. The deployment environment boundary is reconciled: the `staging-like` GitHub Environment exists with an active deployment-branch policy, and the single-maintainer reviewer limitation is documented as the Specification permits |
| **ORG-PR-002** | **OPEN** | No provider contacted, no mail sent to a real recipient, no sender domain authenticated. The Mailpit sink is isolated with no external relay. Account-email delivery was not exercised on the target and would currently fail closed (§6) |
| **ORG-PR-005** | **OPEN** | The pre-migration preflight ran for real, twice. Nothing schedules backups, stores them off-host, encrypts them, archives WAL, or monitors archive health; no RPO/RTO is measured; this target has no PITR window; no real-target restore or PITR drill was performed |
| **ORG-PR-006** | **OPEN** | Runtime secrets are a 0600 file on a host. No secret store, no least-privilege access control, no read auditing, no automated rotation. Public package visibility removes a secret rather than managing one, and the GitHub Environment branch policy is a deployment boundary, not secrets management |

## 16. Readiness assessment

```
Real staging-like target validated   YES
ORG-PR-001                           CLOSED
Sprint 27 DoD met                    NO
Staging ready                        NO
Production ready                     NO
```

**Real staging-like target validated: YES.** A durable host serving real public
HTTPS origins ran two gate-authorised releases by digest and a real rollback,
with public smoke passing every time and machine-generated evidence on the host.

**Staging ready: NO.** ORG-PR-001 closing is not the same as the environment
being ready to *use*, and two evidence-backed gaps remain:

1. **Account-email delivery does not work on this target.** `MAIL_DRIVER=smtp`
   points at a plaintext Mailpit sink while the driver requires implicit TLS,
   so registration, verification, and invitation flows will fail closed. The
   deployment is correct; the environment is not yet exercisable end to end.
2. **No observability on the target.** No metrics, dashboards, log shipping, or
   alerting on a failed deployment, migration, or fail-closed rate limiter
   (ORG-PR-007, ORG-PR-009). A staging environment nobody can observe cannot be
   operated as a rehearsal for production.

Neither is an ORG-PR-001 criterion, and neither was in Sprint 27's scope.

**Production ready: NO.** Three P1 blockers remain open (ORG-PR-002, ORG-PR-005,
ORG-PR-006). Production readiness must remain false while any P1 blocker is
open, and this target holds synthetic data only.

## 17. Remaining blockers

1. **Sprint 27 remote validation** — the repository changes are uncommitted, so
   CI, Security scans, CodeQL, and Artifacts have not run for them. **Operator-owned.**
2. **No validated email delivery** (ORG-PR-002), and account email does not
   currently work on the staging target (§6).
3. **No backup operations** (ORG-PR-005) — scheduling, off-host encrypted
   storage, WAL archival, monitoring, measured RPO/RTO; no real-target restore
   or PITR drill has been performed.
4. **No secrets platform** (ORG-PR-006).
5. **No observability or alerting** on the target (ORG-PR-007, ORG-PR-009).
6. **Images remain single-architecture `linux/amd64`** — satisfied here by an
   amd64 host; still a host procurement constraint.
7. **Reviewer separation is unavailable** on a single-maintainer repository —
   documented limitation, not an ORG-PR-001 blocker.

## 18. Scope-control confirmation

Not implemented, as required: production launch, DNS cutover, real-user traffic,
production data, SMTP/provider closure, SPF/DKIM/DMARC, secrets-manager
integration, automated rotation, production backup scheduling, off-host
encrypted backup storage, WAL archival closure, observability or alerting
platforms, artifact signing, SLSA provenance, multi-region, autoscaling,
Kubernetes, product features, or any auth/authorization/database-model redesign.

No source was built on the target. No package visibility was changed. No GitHub
setting was mutated by this execution. No Git publication was performed. No
existing validation was weakened, and no synthetic product change was introduced
to manufacture a rollback candidate.

## 19. Next sprint

**Sprint 28 — with ORG-PR-001 closed, the highest remaining blocker changes.**

The deployment finding is closed on real evidence, so the critical path moves to
the blockers that a working environment now unblocks. In dependency order:

1. **Publish the Sprint 27 repository changes** and observe the required remote
   workflows — this is what remains of Sprint 27 itself, and it is operator-owned.
2. **Backup operations closure (ORG-PR-005)** is the strongest candidate for the
   next sprint: it was previously blocked on the absence of an environment, and
   that blocker is gone. Scheduling, off-host encrypted storage, WAL archival
   with archive-health monitoring, a measured RPO/RTO, and a **real-target**
   restore/PITR drill are all now executable.
3. **External email provider closure (ORG-PR-002)**, which would also make the
   staging environment exercisable end to end.
4. **Secrets platform integration (ORG-PR-006)** and **observability
   (ORG-PR-007/009)** follow.

Multi-architecture publishing remains unnecessary — the target is amd64.

## 20. External closure gate — satisfied

Every external prerequisite recorded in earlier Sprint 27 revisions has been
met by the operator and verified by this execution.

### Required before target deployment — ALL SATISFIED

| # | Input | Status |
| --- | --- | --- |
| 1 | Durable `linux/amd64` host, outbound HTTPS to `ghcr.io`, Docker enabled at boot | **SATISFIED** — verified by preflight |
| 2 | Secure operator access | **SATISFIED** — ED25519 key; root login and password auth disabled |
| 3 | Host runtime: `bash`, Docker, Compose v2, `curl`, `node`, coreutils | **SATISFIED** — no `git`, no `pnpm` needed, as documented |
| 4 | PostgreSQL with persistent storage on the deployment network | **SATISFIED** — named volume; data survived a restart |
| 5 | Redis on the deployment network | **SATISFIED** |
| 6 | Runtime secrets in a 0600 `runtime.env` | **SATISFIED** — permission gate accepted it |
| 7 | Staging-safe mail behaviour, no production provider | **SATISFIED for deployment** — isolated Mailpit sink; delivery itself unexercised (§6) |
| 8 | Deployment configuration and evidence/backup directories | **SATISFIED** |
| — | Registry credential | **NOT REQUIRED** — none exists on the host |

### Required before public smoke — ALL SATISFIED

| # | Input | Status |
| --- | --- | --- |
| 9 | Public API hostname | **SATISFIED** — `api-staging.drsvp.com` |
| 10 | Public web hostname | **SATISFIED** — `staging.drsvp.com` |
| 11 | DNS control | **SATISFIED** |
| 12 | TLS termination / reverse proxy | **SATISFIED** — Caddy v2.11.4, Let's Encrypt, valid to 2026-11-25 |
| 13 | Public-origin configuration (`ORGISTRY_PUBLIC_API_BASE_URL`, `CORS_ORIGINS`, `WEB_DEMO_URL`, `COOKIE_SECURE`, `TRUST_PROXY`) | **SATISFIED** — smoke reads the browser origin back out of the served bundle |

### Required before ORG-PR-001 closure — ALL SATISFIED

| # | Evidence | Status |
| --- | --- | --- |
| 14 | Immutable digest deployment on the durable target | **DONE** — twice |
| 15 | Backup / PITR preflight | **DONE** — twice, `taken` |
| 16 | Migration once, applied head matches the manifest | **DONE** |
| 17 | Public post-deployment smoke through real origins | **DONE** — 9/9 ×3 |
| 18 | Second compatible release | **DONE** — `d51c76b`, identical migration identity |
| 19 | Real application rollback | **DONE** |
| 20 | Rollback smoke | **DONE** — 9/9 public HTTPS |
| 21 | Deployment and rollback evidence recorded | **DONE** — three machine-generated records |
| 22 | Deployment environment boundary reconciled | **DONE** — environment scoped, branch policy active, reviewer limitation documented |

### Still explicitly NOT required for ORG-PR-001

```
ORG-PR-002 — OPEN and was not required for ORG-PR-001 closure
ORG-PR-005 — OPEN and was not required for ORG-PR-001 closure
ORG-PR-006 — OPEN and was not required for ORG-PR-001 closure
```

## 21. Host tool requirements — confirmed on a real host

The set determined by reading the scripts was exactly right in practice. The
target runs `bash` 5.2.21, Docker 29.7.2, Compose v5.5.0, `curl` 8.5.0, and
`node` v22.23.2, and **has neither `git` nor `pnpm` installed for the
deployment's benefit**. The full lifecycle — preflight, two deployments, a
rollback, backups, migrations, evidence — ran without either.

The deployment tooling was delivered as a 13-file tar payload containing only
`tooling/`, `tooling/lib/`, and `infra/compose.deploy.yml`. **No Dockerfile, no
application source, no `packages/`.** The target is structurally incapable of
building the application.

## 22. Two evidence classes — do not mix them

Sprint 27 produces two kinds of evidence with different completion states. They
answer different questions and must never be conflated.

### Class A — Application-release operational evidence (OBTAINED)

Evidence that the *deployment mechanism works against real infrastructure*,
using releases that were already published in Sprint 26.

| Item | State |
| --- | --- |
| Published Release 1 `91664d0` (Release run `32776576782`) | pre-existing, gate-authorised |
| Published Release 2 `d51c76b` (Release run `32779601026`) | pre-existing, gate-authorised |
| Target preflight on the durable host | **PASS** |
| Target-side GHCR digest pulls | **PASS** — no credential on the host |
| Real-target deployment ×2 (backup preflight, migration, verified head, running digests) | **PASS** |
| Public HTTPS smoke ×3 | **PASS** — 9/9 each |
| Real application rollback + rollback smoke | **PASS** |
| Persistent deployment/rollback ledger on the host | **PASS** — three records, secret-free |
| Network exposure validation | **PASS** — 22/80/443 only |
| Restart / persistence validation | **PASS** |
| GitHub Environment boundary | branch policy active; reviewer separation documented as unavailable |
| **Deploy workflow operational validation — run `33061763360`** | **PASS**, environment `staging-like` |

**This class is complete, and it is what closed ORG-PR-001.**

### Class B — Sprint 27 repository-change validation (PENDING PUBLICATION)

Evidence that the *Sprint 27 code and documentation changes themselves* are
sound. These changes are still uncommitted, so none of this has run against
them.

| Workflow | Required? | Why | How it is triggered |
| --- | --- | --- | --- |
| **CI** — `Validate (offline)`, `Integration (PostgreSQL + Redis)`, `Artifacts (build + smoke)` | **REQUIRED** | Sprint 27 changed `packages/config/src/config.test.ts`, `tooling/deploy*.sh`, `tooling/lib/deploy-common.sh`, and added two files. All three are required checks | **automatic** on pull request and on push to `main` |
| **Security scans** — `Dependency audit (pnpm)`, `Secret scan (Gitleaks)` | **REQUIRED** | Both are required checks; `package.json` changed | **automatic** on pull request and on push to `main` |
| **CodeQL** — `Analyze (javascript-typescript)` | **REQUIRED** | Required check; TypeScript changed | **automatic** on pull request and on push to `main` |
| **Deployment rehearsal** | **REQUIRED** | `docs/validation.md` states the rule: run it before merging any change to `tooling/deploy*.sh` or `tooling/lib/deploy-common.sh`. Sprint 27 changed exactly those, plus the compose-driving executor | **NOT automatic** — `schedule` (weekly) + `workflow_dispatch` only. **The operator must dispatch it manually** |
| **Data durability** | **NOT required** | Its owned surface is untouched: `tooling/db-backup.sh`, `db-restore-drill.sh`, `db-pitr-drill.sh`, `tooling/lib/pg-tools.sh`, the restore fixture, and `apps/api/src/maintenance` are all **unchanged**. Exercising the backup preflight on the target is not a reason to require it | weekly + dispatch |
| **Release** | **NOT required as Sprint 27 validation** | `.github/workflows/release.yml` is **unchanged**, and Sprint 27 published no new application release. However, `release.yml` triggers on push to `main`, so **a Release run will fire automatically when the changes merge** and will publish a new digest pair for the new commit. That is normal repository behaviour, not a Sprint 27 requirement — but a *failure* there would be a real signal worth investigating | automatic on push to `main` |
| **Deploy** | **NOT required again** | `.github/workflows/deploy.yml` is **unchanged**, and the releases deployed to the target are pre-existing published releases. Run `33061763360` already provides the operational validation (Class A). Re-dispatching now would create duplicate evidence and prove nothing new | dispatch only |

**Note on the six required checks.** They live in three workflows, not six:
`Validate (offline)`, `Integration (PostgreSQL + Redis)`, and
`Artifacts (build + smoke)` are jobs inside **CI**; `Dependency audit (pnpm)`
and `Secret scan (Gitleaks)` are jobs inside **Security scans**; and
`Analyze (javascript-typescript)` is the **CodeQL** job. Branch protection
ruleset `19769611` enforces all six on `main`.

Every Class B item passed **locally** in the preceding execution — including
`pnpm deploy:rehearsal` at 65 assertions — but a local pass is not the remote
observation the Sprint Specification requires.

## 23. What remains of Sprint 27

Sprint 27's external objective is complete and ORG-PR-001 is closed. What
remains is **operator-owned** and is the only reason the sprint is still open:

1. **Commit and push the Sprint 27 repository changes.** This execution
   performed no Git publication; the operator owns it.
2. **Observe the required remote workflows** for those changes: **CI**,
   **Security scans**, and **CodeQL** run automatically; **Deployment rehearsal**
   must be **manually dispatched**, because the deployment tooling changed and
   that workflow has no push trigger.
3. A **Release** run will fire automatically on merge to `main`. It is not a
   Sprint 27 requirement, but it should be green.

Until those are observed green, **Sprint 27's DoD is not met**, even though
ORG-PR-001 is closed on real-target evidence. **No further repository-only
implementation is needed before that publication.** When they are green, this
artifact is finalized in place.
