# Deployment and Promotion

Sprint 26 (ORG-PR-001). How a source commit becomes a running deployment: what
is built, how it is published, how a release is identified, how it reaches a
target, how it is validated once it is there, and how it is rolled back.

**Scope guard — read this before quoting anything below.** This document
describes a deployment mechanism that is implemented, rehearsed, executed
remotely, and — since 2026-08-27 — **validated against a real durable
staging-like target**. Two gate-authorised releases were deployed to that target
by immutable digest, a real application rollback was performed, and public HTTPS
smoke passed 9/9 each time. `ORG-PR-001` is **CLOSED**
([findings register](production-readiness/findings-register.md),
[Sprint 27 evidence](#sprint-27-real-target-validation-evidence)).

**A validated staging-like target is not staging readiness, and neither is
production readiness.** The target holds **synthetic data only**, account email
does not work on it, and it has no observability. Three P1 blockers remain open
(ORG-PR-002, ORG-PR-005, ORG-PR-006).

```
Real staging-like target validated   YES
ORG-PR-001                           CLOSED
Sprint 27 DoD met                    YES
Staging ready                        NO
Production ready                     NO
```

**ORG-PR-001 closing is a finding closure, not an environment-readiness
declaration.** Staging readiness remains NO on documented limitations (account
email does not work on the target; no observability there), and production
readiness remains NO on three open P1 findings. See
[sprint-27-artifact-package.md](production-readiness/sprint-27-artifact-package.md).

Related documents, each authoritative for its own boundary:

| Document | Owns |
| --- | --- |
| [deployment-artifacts.md](deployment-artifacts.md) | What the images contain, how they are built, the artifact smoke gate |
| [runtime-secrets.md](runtime-secrets.md) | Where runtime secrets come from and how they are validated |
| [rotation-runbook.md](rotation-runbook.md) | Operating a deployed process: rotation, incidents |
| [backup-and-restore.md](backup-and-restore.md), [pitr.md](pitr.md) | Backup, restore, and point-in-time recovery |
| [validation.md](validation.md) | Every validation command and what it proves |

## Deployment target decision

**Selected model: single-host Docker Compose deployment, operator-executed,
promoted by immutable image digest.**

### Why

- [production-target.md](production-readiness/production-target.md) ratified a
  self-hosted, single-region, low-scale profile (DG-1) and states outright that
  the recommended architecture is "the simplest architecture that satisfies this
  profile — explicitly **not** Kubernetes".
- The repository already had exactly the pieces this model needs: two
  production-shaped images, an explicit one-shot migration entrypoint, and a
  compose-based validation topology (Sprint 23).
- A single operator or small team (A5) can run it without a control plane, and
  the same scripts work identically on a workstation, a VPS, and a managed
  container host that accepts a Compose file.

### What it proves and what it does not

| Proven | Not proven |
| --- | --- |
| Images build once, publish, and are deployed by digest | That any real host is running Orgistry |
| Migrations run exactly once, from the release's own image, and are verified against the release's declared head | Migration behavior at production data volume |
| Health, readiness, security headers, request-ID propagation, and the web bundle's API origin are validated after every deployment | TLS termination, DNS, a reverse proxy, or any edge concern |
| Application rollback to a previous known-good digest works and is validated by smoke | Rollback across a destructive migration (that is recovery, not rollback) |
| Deployment evidence answers "what is running?" and "what would a rollback restore?" | Evidence from a long-lived environment with real users |

### Rejected alternatives

- **Kubernetes / Helm.** Rejected by the ratified target profile. It would add a
  control plane, a manifest toolchain, and an operational surface that a
  single-operator deployment cannot justify, in exchange for capabilities
  (autoscaling, multi-AZ scheduling) this profile explicitly does not need.
- **An SSH-from-CI deployment job.** A job that opens a session to a host that
  does not exist could never be run or reviewed against reality, and its
  presence in the repository would read as a deployment pipeline this project
  does not have. Target execution is therefore an operator-run script that is
  exercised end to end by the rehearsal, and the deployment workflow performs
  the half that genuinely can run in CI: authorisation, release verification,
  and the deployment plan. When a target exists, the execution step is added to
  that workflow and calls the same `tooling/deploy.sh`.
- **A managed container platform (Fly/Render/App Runner).** Viable, and the
  release half of this design is provider-neutral. Rejected as the Sprint 26
  target because no account, credential, or budget exists, and choosing one
  would have produced provider configuration nobody could execute — the same
  fabrication problem as the SSH job.
- **Publishing to Docker Hub.** GHCR needs no additional account, no long-lived
  credential, and no secret: the workflow's own `GITHUB_TOKEN` with
  `packages: write` is sufficient and expires with the job.

## Environment taxonomy

These five names are used consistently across every Orgistry document. They are
not interchangeable, and three of the confusions they exist to prevent are
worth stating outright:

```
production-like local Compose  !=  staging
staging-like deployment        !=  production
a successful deployment        !=  production readiness
```

| | **local development** | **repository validation** | **production-like local validation** | **staging-like deployment target** | **production deployment target** |
| --- | --- | --- | --- | --- | --- |
| Purpose | Write and run code | Prove a change is correct | Prove the built artifacts boot and behave | Rehearse operating a real deployment | Serve real users |
| Exists today | yes | yes | yes | **yes** (since 2026-08-27) | **no** |
| Defined by | `infra/docker-compose.yml` | `.github/workflows/*.yml` | `infra/compose.production-like.yml` | `infra/compose.deploy.yml` + `tooling/deploy.sh` | same as staging-like |
| Operator | developer | CI | developer or CI | operator | operator |
| Data classification | throwaway | throwaway | throwaway | synthetic only | real user data |
| Real user data allowed | no | no | no | **no** | yes |
| Secrets source | `.env` local defaults | fake checked-in/generated values | fake checked-in values | operator runtime env file (0600) or `<NAME>_FILE` mounts | same |
| Email behavior | Mailpit sink | none delivered | Mailpit stand-in, delivery not exercised | `smtp` driver pointed at an operator-run **isolated sink**; delivery not exercised, **no real provider** ([Staging mail model](#staging-mail-model)) | real provider required, still unvalidated (ORG-PR-002) |
| Backup behavior | manual `pnpm db:backup` | drills only, throwaway data | none | pre-deployment backup preflight; nothing scheduled | scheduled + off-host storage required, **does not exist** (ORG-PR-005) |
| Deployment trigger | `pnpm dev` | push / pull request | `pnpm artifact:smoke` | operator runs `tooling/deploy.sh` after the `Deploy` workflow verifies the release | same, plus required reviewers |
| Required gates | none | the six required checks | artifact smoke | release gated by artifact smoke; deployment gated by migration verification and post-deploy smoke | same |
| Rollback model | irrelevant | irrelevant | irrelevant | redeploy previous known-good digests | same |
| "Ready" means | the process started | the checks are green | the artifacts boot and pass smoke | this deployment serves and passed smoke | **nothing yet — the project is not production ready** |

There is a sixth, narrower name used only by the rehearsal harness:
**`rehearsal-local`**, the throwaway environment `pnpm deploy:rehearsal` creates
and destroys. It exercises the staging-like machinery on a workstation or CI
runner with a throwaway registry and throwaway backing services. It is not a
staging-like environment, because nothing about it outlives the run.

## Build once, promote by digest

The central invariant:

```
The deployed image MUST be the previously built and validated image.
```

Concretely:

1. Images are built **once per source commit**, by the release workflow.
2. The API image that the artifact gate validated is the API image that is
   published — `docker tag` cannot change image content, and no second API
   build happens anywhere.
3. Both images are pushed under an immutable **commit-SHA tag**, and their
   registry **digests** are captured.
4. A **release manifest** records those digests.
5. Deployment consumes the manifest and resolves images **only by digest**.
   `tooling/deploy.sh` refuses a reference without `@sha256:`.
6. `infra/compose.deploy.yml` contains **no `build:` section**, and the
   deployment asserts that before invoking Compose — a target can therefore not
   rebuild source even by accident.
7. After the containers are up, the deployment compares each running
   container's image ID against the ID the manifest's digest resolves to. A
   deployment that somehow ran a different image fails there.
8. Rollback redeploys the previous release's digests, from that release's own
   manifest, which the deployment host kept.

Convenience tags may exist; none is ever authoritative. The rehearsal
deliberately pushes both of its releases under the **same** tag to demonstrate
this: the tag moves, and both digests stay independently deployable.

## Registry publishing

`.github/workflows/release.yml` — triggered by a push to `main` or manually.

```
ghcr.io/<owner>/orgistry-api:<commit-sha>
ghcr.io/<owner>/orgistry-web:<commit-sha>
```

The owner is taken from `github.repository_owner` and lowercased (GHCR
repository paths must be lowercase; GitHub account names need not be). Nothing
is hard-coded.

Properties, all enforced rather than asserted:

- **Never runs on pull requests.** An untrusted fork has no path to publishing.
- **Permissions:** workflow-level `contents: read`; the publish job adds
  `packages: write` and nothing else. This is the only elevated grant in the
  repository besides CodeQL's `security-events: write`.
- **Credential:** the job's own short-lived `GITHUB_TOKEN`, piped to
  `docker login --password-stdin` so it never appears in a command line.
- **No secret reaches a build**, and no ENVIRONMENT reaches one either. Neither
  Dockerfile takes a secret build argument, and since the Sprint 26 refinement
  neither takes a `VITE_*` argument at all
  ([deployment-artifacts.md](deployment-artifacts.md), "Secret boundary").
- **Both images are built once and re-tagged**, never rebuilt for publication:
  `docker tag` cannot change image content, so what ships is exactly what the
  gate validated.
- **Base-image digest pinning is untouched** — both Dockerfiles still pin
  `tag@sha256` (ORG-PR-042).
- **Gated:** the workflow runs `tooling/artifact-smoke.sh` itself and publishes
  the images that gate produced. Inferring "CI passed for this SHA" from a
  different workflow run would be an assumption, not evidence.

### Runtime public configuration

Both images are **environment-neutral**. The API always was; the web image was
not, and was corrected in the Sprint 26 refinement.

`VITE_API_BASE_URL` is a Vite variable, compiled into the browser bundle at
build time. That made the web image environment-specific: promoting one
validated web digest from a staging-like environment to production would have
required a rebuild, which contradicts this document's central invariant. The
correction moves those three values off the build and onto the deployment:

| Layer | What it does |
| --- | --- |
| `apps/web-demo/index.html` | loads `/public-config.js` as a classic script before the deferred app module, so the value is always present when the app reads it |
| `apps/web-demo/nginx.conf.template` | an exact-match `location = /public-config.js` that returns `window.__ORGISTRY_PUBLIC_CONFIG__ = {…}` built from `ORGISTRY_PUBLIC_*` container variables. The base image's own `20-envsubst-on-templates.sh` renders the template at container start; `NGINX_ENVSUBST_FILTER=^ORGISTRY_PUBLIC_` keeps nginx's own `$uri`/`$host` untouched |
| `apps/web-demo/src/public-config.ts` | resolves the effective values: runtime object → `import.meta.env.VITE_*` (dev only) → built-in localhost defaults |
| `apps/web-demo/public/public-config.js` | an empty assignment shipped in the bundle so the Vite dev server and any plain static host resolve the script tag. A deployed container never serves it — the exact-match nginx location wins |

Consequences, all of them intended:

- **One web digest serves any environment.** Nothing about the environment is
  in the image, so promotion is a configuration change, not a rebuild.
- **The configuration is public.** It is delivered to every browser. The
  application refuses to start if the runtime object contains a
  credential-shaped key (`secret`, `password`, `token`, `apiKey`, …), so a
  deployment cannot quietly publish a secret through this channel.
- **`no-store` on `/public-config.js`.** It is deployment configuration; a
  cached copy would survive a configuration change and point browsers at the
  wrong API.
- **The manifest describes identity, not configuration.** `images.*` carries
  only repository, tag, digest, and reference — the schema now *refuses* any
  additional field, which is how the removed `images.web.apiBaseUrl` is kept
  out for good.
- **Smoke still proves the deployment is configured correctly**, and adds a
  second check that the environment's origin is NOT in the immutable bundle —
  the regression test for promotability itself.

The artifact smoke test proves the property at the artifact level: it starts a
second container from the **same image** with a different
`ORGISTRY_PUBLIC_API_BASE_URL` and asserts the served configuration follows
while the built assets do not contain that origin.

### Package visibility — observed state

Sprint 26 recorded these packages as private. **They are not**, and the
correction matters to every host that will ever pull them.

**Observed state (2026-08-25): the API and web GHCR packages are currently
publicly pullable.** Verified by pulling both published digests with
`DOCKER_CONFIG` pointed at a *fresh empty directory*, so no stored credential
could have been used, and independently by `GET
https://ghcr.io/v2/danielrosenberg00/orgistry-api/tags/list` returning `200`
against an anonymously issued registry token. The likely cause is GitHub's own
default: a package published with `GITHUB_TOKEN` and linked to a repository
inherits **that repository's** visibility, and Orgistry is public. Sprint 26
generalised from the rule for user- and organisation-scoped packages, which is
different.

**No approved visibility policy is on record.** This is an *observation of the
current state*, not a decision anyone made deliberately and not a decision made
here. Package visibility remains the operator decision it always was, and it is
listed under [external configuration](#external-and-operator-only-configuration)
for that reason. Nothing in this repository changed it, and nothing should
change it without recording the decision.

**Operational implication.** A staging host does **not currently** require a
GHCR pull credential. That removes the target's only registry secret rather
than adding one to provision, store at 0600, rotate, and leak.

**Security implication.** Because the packages are currently public, the images
must contain nothing secret — which is already an enforced property rather than
a hope: `tooling/artifact-smoke.sh` asserts no `.env`, no source, no git
metadata, and no secret-shaped value in the image or the served web assets, and
neither Dockerfile accepts a secret build argument. What is disclosed is
dependency versions and file layout, which the public source tree already
discloses. Digest references are unaffected: visibility changes who may pull,
never what a digest resolves to.

**Policy implication.** Public package visibility must stay explicitly visible
in this document and in the
[security assessment](production-readiness/security-assessment.md), and it must
**not** be mistaken for a secrets-management capability. Needing no credential
is not the same as managing credentials well; ORG-PR-006 is unaffected.

**If an operator decides to make the packages private**, that is a legitimate
choice with a cost: every deployment host then needs a long-lived read-only pull
credential, and `ORGISTRY_*`-style credential handling on the host grows a new
secret. Record the decision either way.

## Release manifest

Produced by `tooling/release-manifest.mjs` (model and invariants:
`tooling/lib/release-manifest.mjs`, tested in
`tooling/release-manifest.test.ts`). The release workflow uploads it as the
`release-manifest` workflow artifact; a local build writes it wherever
`--output` points (`artifacts/` is git-ignored).

```json
{
  "schemaVersion": 2,
  "kind": "orgistry.release-manifest",
  "release": { "type": "published", "deployable": true },
  "source": {
    "provenance": "commit",
    "commit": "0ec6ea2f207269206df78ba2ad12bdef2df478b7",
    "ref": "refs/heads/main",
    "builtAt": "2026-08-24T09:12:33.101Z"
  },
  "images": {
    "api": {
      "repository": "ghcr.io/example/orgistry-api",
      "tag": "0ec6ea2f207269206df78ba2ad12bdef2df478b7",
      "digest": "sha256:...",
      "reference": "ghcr.io/example/orgistry-api@sha256:..."
    },
    "web": {
      "repository": "ghcr.io/example/orgistry-web",
      "tag": "0ec6ea2f207269206df78ba2ad12bdef2df478b7",
      "digest": "sha256:...",
      "reference": "ghcr.io/example/orgistry-web@sha256:..."
    }
  },
  "migrations": {
    "head": "0012_shocking_warbound",
    "count": 13,
    "appliedAtMs": 1787555203153,
    "artifact": "api-image",
    "entrypoint": "node dist/migrate.mjs"
  },
  "gates": {
    "headSha": "0ec6ea2f207269206df78ba2ad12bdef2df478b7",
    "verifiedAt": "2026-08-24T09:11:02.004Z",
    "required": [
      {
        "check": "Validate (offline)",
        "workflow": "CI",
        "workflowFile": "ci.yml",
        "runId": "32712300001",
        "runAttempt": "1",
        "conclusion": "success",
        "headSha": "0ec6ea2f207269206df78ba2ad12bdef2df478b7",
        "url": "https://github.com/.../actions/runs/32712300001"
      }
    ]
  },
  "build": {
    "artifactSmoke": "passed",
    "workflow": "Release",
    "runId": "32712345678",
    "runAttempt": "1",
    "repository": "DanielRosenberg00/Orgistry"
  }
}
```

A **rehearsal** manifest is the same document with
`"release": { "type": "rehearsal", "deployable": false }`, `provenance` of
`working-tree` plus a `source.workingTreeDigest`, and **no `gates` block at
all**. The schema refuses every other combination.

Field meanings and the rules `validate` enforces:

| Field | Rule | Why |
| --- | --- | --- |
| `release.type` | `published` or `rehearsal` | A manifest states what it is instead of leaving a reader to infer it |
| `release.deployable` | `true` **iff** `type` is `published` | The two can never disagree, so one field answers "may this reach a real environment?" |
| `source.provenance` | `commit` or `working-tree` | How the source bytes are addressed |
| `source.commit` | 40-character lowercase SHA | Short SHAs are ambiguous across a long history |
| `source.workingTreeDigest` | required **iff** provenance is `working-tree`, forbidden otherwise | A dirty tree is not its base commit, so it gets its own identity |
| published + `working-tree` | **refused** | A deployable release must be exactly the commit it names |
| `source.builtAt` | ISO-8601 UTC, exactly round-trippable | Ordering releases must not depend on a locale |
| `images.*.tag` | **must equal** `source.commit` | The tag is the commit, so a human reading a tag reads a commit |
| `images.*.reference` | **must be** `<repository>@<digest>` | The promote-by-digest invariant, enforced at the schema level |
| `images.*.digest` | `sha256:` + 64 hex | — |
| `images.*` | **no other field** | An image identity may not describe where it is deployed; this is what keeps the web digest promotable |
| `migrations.head` / `count` / `appliedAtMs` | **derived** from `packages/db/migrations/meta/_journal.json`, never supplied | A manifest cannot claim a migration head its images do not contain |
| `migrations.artifact` / `entrypoint` | fixed | Migrations run from the API image, not a separate artifact |
| `gates` | required **iff** `type` is `published`; **forbidden** for a rehearsal | A rehearsal has no GitHub run behind it, and inventing a run ID is worse than having none |
| `gates.headSha`, `gates.required[].headSha` | **must equal** `source.commit` | Gate evidence from a neighbouring commit authorises nothing |
| `gates.required[].conclusion` | **must be** `success` | Only a green check authorises a release |
| `gates.required[]` | must cover every required check | The contract is the full set, not "some checks passed" |
| `gates.required[].runId` | numeric GitHub run ID | Evidence must be verifiable against the Actions API |
| `build.artifactSmoke` | `passed` or `not-run` | Records whether the release job re-ran the gate itself |
| everything | no credential-shaped string anywhere | Manifests are uploaded, copied to hosts, and pasted into evidence |

Two design notes worth keeping:

- **Build-time and deployment-time evidence are separate records.** A manifest
  can only contain facts that exist when it is written. A field like
  "deployment result" would either be permanently null or a lie, so deployment
  outcomes live in the [evidence ledger](#deployment-evidence) instead.
- **`build` is omitted entirely** when there is no workflow provenance (a local
  or rehearsal build), rather than filled with placeholders.

## Release provenance: published vs rehearsal

Two documents can describe images built on one machine, and only one of them may
ever reach an environment.

| | **published release** | **development rehearsal** |
| --- | --- | --- |
| Produced by | `.github/workflows/release.yml` | `pnpm deploy:rehearsal` |
| `release.type` | `published` | `rehearsal` |
| `release.deployable` | `true` | `false` |
| `source.provenance` | `commit` — the images ARE the bytes of that commit | `commit` on a clean tree, `working-tree` otherwise |
| `source.workingTreeDigest` | absent (refused) | present whenever the tree was dirty |
| `gates` | required, complete, and tied to the same commit | **absent — never fabricated** |
| Accepted by | any environment | only an environment that declares `ORGISTRY_ENVIRONMENT_CLASS=rehearsal` |

The rules are enforced in three independent places, so no single edit removes
the boundary:

1. **The schema** (`tooling/lib/release-manifest.mjs`) refuses a published
   release with working-tree provenance, a rehearsal that claims to be
   deployable, and a rehearsal carrying gate evidence.
2. **The release workflow** asserts the checkout is clean before publishing, so
   a published manifest's `commit` provenance is a fact rather than a promise.
3. **The deployment** (`tooling/deploy.sh`) refuses a non-deployable manifest
   unless the environment explicitly declares itself a rehearsal.

The rehearsal computes its working-tree digest from the base commit, the
porcelain status, the diff against `HEAD`, and the contents of untracked files.
It is an identity for "these exact uncommitted bytes", not a reproducible build
identifier — its only job is to stop a dirty rehearsal from being described by a
commit SHA that does not contain the code that was built.

**Consequence for evidence.** A rehearsal's output must never be cited as
evidence about a commit. Where this documentation set records rehearsal results,
it records them as rehearsal results.

## Release authorization: exact-SHA required gates

Publication is authorised by the required checks having actually succeeded **for
the exact commit being published** — not by the commit being on `main`, and not
by the release workflow re-running one gate itself.

The `gates` job in `.github/workflows/release.yml` runs
`tooling/release-gates.mjs verify`, which:

1. confirms the SHA is reachable from `main` (`compare/main...<sha>` must be
   `identical` or `behind`) — a commit that never sat on the release branch was
   never subject to the branch's protections;
2. lists the workflow runs whose `head_sha` is that commit;
3. for each of the six required checks, takes the newest run of its workflow
   file and requires that **job** to have concluded `success`. Job granularity
   matters: `ci.yml` alone carries three required checks, and a run-level
   conclusion cannot tell them apart;
4. writes the run ID, run attempt, conclusion, head SHA, and URL of each check.

The required set mirrors the `main` ruleset exactly, and lives in one place
(`REQUIRED_GATES` in `tooling/lib/release-gates.mjs`) that the manifest
validator imports, so the two cannot drift:

```
Validate (offline)                 ci.yml
Integration (PostgreSQL + Redis)   ci.yml
Artifacts (build + smoke)          ci.yml
Dependency audit (pnpm)            security.yml
Secret scan (Gitleaks)             security.yml
Analyze (javascript-typescript)    codeql.yml
```

### Race behavior — the deliberate choice

`Release` is triggered by the same push that starts those gates, so they are
normally still running when it begins. The verifier polls, with three distinct
outcomes and no fourth:

| Observation | Outcome |
| --- | --- |
| every required job concluded `success` | evidence written, publication proceeds |
| any required job concluded anything else, or a completed run lacks a required job | **fail immediately** — a failure never becomes a success by waiting |
| a run is missing or still in progress | `pending`; keep polling |
| still pending at the timeout (default 1800s, `gate_timeout_seconds` input) | **fail**, naming what was pending, and publish nothing |

"Run not found yet" is never treated as success. The retry path is deliberately
manual: re-dispatch `Release` from `main` once the checks have finished, which
takes the fast path because the gates are then already green.

### Permissions

`actions: read` is scoped to the `gates` job, which holds no publishing
permission. `packages: write` is scoped to the `publish` job, which holds no
Actions-read permission. Neither job can do the other's work, and neither
trigger is reachable from a pull request.

## Deployment configuration contract

Two files, deliberately separate:

| File | Holds | Secrets | Committable |
| --- | --- | --- | --- |
| `deploy.env` (template: `infra/deploy.env.example`) | **how** to deploy: environment name, ports, network, evidence directory, preflight policy | none | yes, to an operator's own infrastructure repo |
| `runtime.env` | **what** the application runs with — the full runtime contract, including every secret | yes | **never**, mode 0600 |

Image identity is in **neither**: it comes from the release manifest, so a stale
configuration value can never decide what runs.

### Runtime values

The authoritative classification of every runtime variable — required vs
optional, secret vs non-secret, production rules, `<NAME>_FILE` support, and
rotation semantics — is
[runtime-secrets.md](runtime-secrets.md#secret-inventory) and the environment
contract table in
[deployment-artifacts.md](deployment-artifacts.md#environment-contract-deployable-api-artifact).
It is **not** duplicated here. What a deployment adds on top:

| Value | Class | Deployment note |
| --- | --- | --- |
| `NODE_ENV` | non-secret, required | Must be exactly `production`; the deployment refuses anything else, because the production config guard is what makes the deployment reject development secrets |
| `DATABASE_URL` | **secret**, required | Also read by the deployment itself for the backup preflight and migration-head verification. `DATABASE_URL_FILE` works identically |
| `REDIS_URL` | secret if credentialed, required in practice | Must name the operator-provided instance, not localhost |
| `JWT_SECRET` / `JWT_PREVIOUS_SECRET` | **secret** | Rotation window semantics unchanged ([rotation-runbook.md](rotation-runbook.md)) |
| `SMTP_*`, `MAIL_*` | mixed; `SMTP_PASSWORD` secret | The guard constrains the *driver*, *credential*, and *sender domain* — **not the endpoint's identity**. A staging-like target points `smtp` at an operator-run isolated sink; **a real provider is required only for production**, and remains unvalidated (ORG-PR-002). See [Staging mail model](#staging-mail-model) |
| `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGINS`, `WEB_DEMO_URL`, `HSTS_MAX_AGE_SECONDS` | non-secret, environment-scoped | Set `TRUST_PROXY` to the real hop count/CIDRs behind the operator's proxy |
| `RATE_LIMIT_FAILURE_MODE`, `LOG_LEVEL`, `RETENTION_*` | non-secret, optional | Leave `RATE_LIMIT_FAILURE_MODE` unset in production (derives to `closed`) |
| API and web image digests | **deployment-generated** | From the release manifest only |
| `ORGISTRY_PUBLIC_API_BASE_URL` | **public browser configuration**, required | The API origin the browser will call. Applied to the web container at start; recorded in deployment evidence; verified by smoke |
| `ORGISTRY_PUBLIC_CSRF_HEADER_NAME`, `ORGISTRY_PUBLIC_MAILPIT_URL` | public browser configuration, optional | Defaults match the application's own; the CSRF name must match the API's `AUTH_CSRF_HEADER_NAME`. **`ORGISTRY_PUBLIC_MAILPIT_URL` is a link handed to the *visitor's browser*, not a server-side address** — see [The public Mailpit URL is not a remote inbox](#the-public-mailpit-url-is-not-a-remote-inbox) |
| `ORGISTRY_ENVIRONMENT_CLASS` | non-secret, operator-provided | `deployment` (default) accepts only a deployable published release; `rehearsal` is the explicit opt-in used by the local rehearsal |
| `ORGISTRY_*` in `deploy.env` | non-secret, operator-provided | Documented inline in `infra/deploy.env.example` |

**`ORGISTRY_PUBLIC_*` values are served to every browser.** They are
configuration, never credentials; both the application and the evidence ledger
refuse anything outside the published public contract.

The deployment performs a **presence-only** check on the required runtime keys
(accepting either `NAME` or `NAME_FILE`) and one value check (`NODE_ENV`). It
deliberately does not re-validate values: the API's own config guard is the
single policy, and a second one here would drift from it.

## Deployment secret handling

Every Sprint 24 invariant is preserved, and the deployment adds enforcement:

- Secrets are **runtime-only**. No secret build argument, no secret in an image
  layer, no secret in a release manifest, a deployment record, a workflow
  summary, or a script's output.
- The runtime env file must be mode **0600**. The deployment refuses to run
  against a group- or world-readable file — it holds every runtime secret in
  plaintext, so a permissive mode is a finding on the host, not a warning.
- The deployment reads exactly **one** secret value for itself
  (`DATABASE_URL`), keeps it in a shell variable, and passes it only through an
  environment variable to the backup and psql client containers — never as a
  command-line argument, never into a filename, never into a log line.
- `<NAME>_FILE` mounts keep working: `deploy_read_secret_value` honours them,
  and any variable in the closed `_FILE` list can be supplied that way by adding
  a read-only volume to the deployment topology.
- `docker compose config` is **never** run by any script here: it expands
  `env_file` entries into plaintext.
- The release manifest and every deployment record are validated against a
  credential-shape guard that refuses a URL with inline credentials or an inline
  credential assignment.
- No workflow reads a production runtime secret. The release workflow uses only
  its own `GITHUB_TOKEN`; the deployment workflow is read-only everywhere.

This is a secret **handling** boundary, not secrets management. There is still
no secret store, no access control, no audit of secret reads, and no automated
rotation — `ORG-PR-006` stays open.

## Deployment workflow and the operator path

Deployment is split across two halves, because only one of them can run in CI
today.

### `.github/workflows/deploy.yml` — authorise and verify (runs in CI)

Manual dispatch only, with an `environment` choice and the run ID of the
`Release` workflow run to deploy. The job binds to a GitHub Environment
(`environment: ${{ inputs.environment }}`), which is where required reviewers,
branch restrictions, and any future deployment credential belong. It:

1. downloads that run's `release-manifest` artifact;
2. validates it against the schema;
3. **refuses a release that is not deployable**, and re-states the gate
   evidence — every required check, its run ID, and its conclusion — in the job
   log, so a blocked deployment says why;
4. proves both digests still resolve in the registry — a manifest is a claim
   about a registry, and this is the check that the claim is still true;
5. writes the deployment plan (commit, both digests, the web bundle's API
   origin, the migration head) and the exact operator commands to the job
   summary.

Permissions are read-only throughout: `contents: read`, `actions: read`,
`packages: read`. Concurrency is keyed per environment, so two deployments
cannot interleave and leave the ledger ambiguous about what is running.

### `tooling/deploy-target-preflight.sh` — qualify the host (runs on the host, first)

New in Sprint 27. Run it **before** the first deployment to a host, and again
after any change to that host:

```sh
pnpm deploy:preflight -- --config /etc/orgistry/deploy.env \
                        --manifest release-manifest.json --json
```

Every argument is optional, which is deliberate: a host being *evaluated* has
no configuration and no chosen release yet, and the host-level checks are the
ones that decide whether it is a candidate at all.

| Group | Checks |
| --- | --- |
| Toolchain | `docker`, `docker compose` v2, `node`, `curl`, and a complete Orgistry checkout — the deployment executes *from* a checkout, which is easy to forget when provisioning a bare host |
| Host baseline | Docker daemon reachable and its platform; Docker/Compose versions; CPU, memory, storage driver; kernel; **whether the Docker service starts at boot**, which is what makes a target durable rather than merely running |
| Release | the manifest validates; both images actually pull *from this host*; **both image platforms match this host** |
| Configuration | `ORGISTRY_ENVIRONMENT_CLASS=deployment` (a durable target must never accept a rehearsal release); the runtime env file exists and is owner-readable only; API/web ports bind to loopback; the browser-facing API origin is HTTPS; evidence and backup directories are writable and not world-writable |

It collects every problem instead of stopping at the first — an operator
qualifying a host wants the whole list — and exits non-zero if any check
FAILED. `--json` prints the sanitized baseline for pasting into deployment
records. It reads paths, modes, versions, and counts; it stats the runtime
configuration file but never reads it, so it can never be the thing that prints
a secret.

**Read-only contract.** The preflight is read-only with respect to
application, database, host, and remote state. It may inspect versions, file
modes, and directory writability; pull and inspect immutable digest-pinned
images; compare architectures; and structurally validate non-secret
configuration. It must never run a migration, touch the application database,
start or reconfigure the deployment, change firewall or host configuration,
persist a secret, or mutate GitHub settings or package visibility. A check that
needs any of those belongs in `tooling/deploy.sh`.

**It is not a deployment.** It starts no Orgistry container, runs no migration,
and writes nothing to the evidence ledger. A passing preflight means "the
checks this script can make are satisfied", never "a deployment succeeded".

### Staging mail model

**A staging-like target does not need, and must not use, a production email
provider.** Establishing this precisely matters, because the deployment
requires `NODE_ENV=production` — which activates every production config guard
— and it would be easy to read that as "production email required". It is not.

#### What the production guard actually constrains

Verified against `packages/config/src/production-policy.ts` and
`mail-policy.ts` by loading real configurations, not by reading prose:

| Constraint | Under `NODE_ENV=production` |
| --- | --- |
| `MAIL_DRIVER` | must be `smtp`. `mailpit` and `memory` are refused — production must never *silently swallow* account email |
| `SMTP_HOST` / `SMTP_USERNAME` / `SMTP_PASSWORD` | must be present; `SMTP_PASSWORD` must not be a placeholder or known development default |
| `MAIL_FROM_EMAIL` | must not be the shipped default, and must not sit on a reserved non-routable suffix (`.invalid`, `.test`, `.example`, `.localhost`, `@example.com`, …) |
| `WEB_DEMO_URL` | must not be plain-HTTP or localhost — emailed links embed it |
| **The endpoint's identity** | **not constrained.** Nothing requires a known provider, a public hostname, or a reachable server |

#### What that means operationally

```
SMTP is not a boot dependency  — the transport is created lazily; nothing connects at startup
SMTP is not a readiness probe  — /ready probes PostgreSQL and Redis only
Sprint 27 smoke sends no mail  — all nine checks are unauthenticated
```

Directly observed: the packaged API booted under `NODE_ENV=production` with an
unreachable `SMTP_HOST`, reached `/ready` 200, and passed 9/9 post-deployment
smoke.

#### The supported staging configuration

Point the `smtp` driver at an **operator-run, isolated sink reachable only from
the deployment network**:

```
MAIL_DRIVER=smtp
SMTP_HOST=<sink reachable only on the deployment network>
SMTP_PORT=465
SMTP_USERNAME=<any non-placeholder value>
SMTP_PASSWORD=<any non-placeholder value>
MAIL_FROM_EMAIL=no-reply@<a domain the operator controls, not a reserved suffix>
```

Two sub-cases, both acceptable, and the difference is worth knowing before the
first deployment:

- **The sink presents a publicly-trusted certificate on an SMTPS port.**
  Account email delivers into the sink; nothing leaves the host. The `smtp`
  driver uses implicit TLS with certificate and hostname verification always
  on, and there is no environment seam for a private CA — so a self-signed
  sink does **not** qualify here.
- **The sink is plaintext, self-signed, or absent.** The deployment still
  boots, stays ready, and passes smoke; account-email *sends* fail closed and
  are surfaced as errors. That is the correct architectural behaviour — mail
  failures must never silently disappear in production mode — and it is
  acceptable for a Sprint 27 target whose validation never exercises a mail
  flow.

Choose the second only knowingly: registration and invitation flows will error
on that target until a working sink exists.

#### The public Mailpit URL is not a remote inbox

`ORGISTRY_PUBLIC_MAILPIT_URL` defaults to `http://localhost:8025`, and that
default is served to every browser in `/public-config.js`. On the validated
staging-like target the served value is exactly that:

```
window.__ORGISTRY_PUBLIC_CONFIG__ = {…,"mailpitUrl":"http://localhost:8025"}
```

**Read that precisely.** `localhost` is resolved by the *visitor's browser*, not
by the server. The staging host binds the Mailpit UI to its own loopback
(`127.0.0.1:8025`) and publishes nothing — externally probed and confirmed
closed. So a person browsing `https://staging.drsvp.com` who follows that link
reaches **their own machine's** port 8025, which is almost certainly nothing.

Consequences:

- **It is not a remotely usable inbox endpoint**, and no document should imply
  it is. It is a convenience that only works for a developer running Mailpit
  locally, which is the environment its default was written for.
- **It is not a leak.** The value is a loopback literal; it discloses nothing
  about the host, and the deployment evidence records it as public
  configuration by design.
- **It is not a deployment defect and not an ORG-PR-001 blocker.** Nothing in
  the deployment, smoke, or readiness path depends on it.
- To inspect the staging sink, an operator uses an SSH tunnel to the host's
  loopback port — deliberately, since exposing Mailpit publicly would put
  captured message bodies (which carry raw verification tokens) on the internet.

This is a **staging/demo limitation only**, recorded so nobody mistakes the
served value for a working staging inbox link.

#### Why this is not ORG-PR-002 evidence

Nothing above proves an endpoint exists, accepts a credential, or delivers
anything to a recipient. **ORG-PR-002 remains open** and requires an actual
external provider, verified sender-domain authentication (SPF/DKIM/DMARC), and
observed inbox receipt — none of which is in Sprint 27's scope, and none of
which is a prerequisite for closing ORG-PR-001.

**Never point a staging-like target at a real provider.** It has synthetic data
and no delivery guarantees; sending real mail from it risks reputation damage
to a sender domain that production will later depend on.

### Host baseline and target preflight

The properties a staging-like target must have, and where each is enforced:

| Requirement | Enforced by |
| --- | --- |
| Durable — not a CI runner, survives a host reboot | preflight (Docker enabled at boot) + `restart: unless-stopped` in the compose topology |
| Outbound access to GHCR | preflight (both digests actually pull) |
| **CPU architecture matching the published images** | preflight, and again as stage 5 of every deployment |
| Persistent PostgreSQL and a Redis, operator-provided | the runtime configuration contract; neither is in the deployment topology |
| Runtime secrets in a file readable only by its owner | preflight, and `deploy.sh` stage 3 |
| Internal ports not published to the network | preflight (loopback binds) + the compose defaults |
| Synthetic data only | policy, restated by the preflight's own output |

#### The architecture constraint is real, and it is now a gate

`.github/workflows/release.yml` builds on a GitHub-hosted runner and pushes a
**single-architecture `linux/amd64` manifest** — not a manifest list. A pull is
architecture-agnostic, so an arm64 host pulls those images perfectly and only
fails when a container starts, with `exec format error`.

Before Sprint 27 that surfaced four stages later as *"the API container did not
become healthy"* — **after** the backup preflight and the migration had already
run against the target's database. The message sent the operator to debug the
application; the fault was the host.

Stage 5 now compares each image's platform against the Docker daemon's, and
refuses the deployment before anything touches the database. Both sides are
normalised first (`docker info` reports `aarch64`/`x86_64`; an image reports
`arm64`/`amd64`), because a gate that fails closed on correct input is worse
than no gate — operators disable those.

This was found by pulling the real published release onto an arm64 host. No
rehearsal could have found it: `pnpm deploy:rehearsal` builds its images
locally, so they are always native and can never mismatch.

**Emulation is an explicit, recorded opt-in.** `ORGISTRY_ALLOW_IMAGE_ARCHITECTURE_MISMATCH=yes`
(that exact value; `true` and `1` are refused) downgrades the refusal to a
warning and writes a limitation onto the deployment record stating that the
deployment runs under CPU emulation and that its runtime behaviour and
performance are unproven. Use it for a local experiment, never for a target
anyone depends on.

**When provisioning a real target, choose an x86-64 host.** The alternative —
publishing multi-architecture images with `docker buildx build --platform` —
changes the release workflow's build and digest model and belongs to a sprint
that owns that decision, not to this one.

### `tooling/deploy.sh` — execute on the target (runs on the host)

```sh
tooling/deploy.sh --manifest release-manifest.json --config /etc/orgistry/deploy.env
```

Stages, in order, each failing the deployment loudly and naming itself:

| # | Stage | Fails the deployment when |
| --- | --- | --- |
| 1 | Validate inputs and load configuration | a required option or configuration key is missing |
| 2 | Validate the release manifest | the manifest is malformed, or an image reference is not digest-pinned |
| 3 | Pre-deployment validation | the compose topology declares a build section; the release is not deployable and the environment is not a rehearsal; the runtime env file is missing, unreadable, not 0600, missing a required key, or not `NODE_ENV=production` |
| 4 | Pull both images by digest | a digest is not available from the registry this host can reach |
| 5 | Verify the images can run on this host | an image's platform is not the Docker host's platform, and emulation was not explicitly opted into (Sprint 27; see [Host baseline and target preflight](#host-baseline-and-target-preflight)) |
| 6 | Backup / recovery-point preflight | the pre-deployment backup fails, or a skip has no recorded reason |
| 7 | Migrations, exactly once | the migration container exits non-zero |
| 8 | Verify the applied migration head | the database's applied migrations do not match the release's declared head |
| 9 | Deploy the API, wait for health | the API container never becomes healthy |
| 10 | Deploy the web artifact | the web container does not start |
| 11 | Wait for readiness | `/ready` does not return 200 |
| 12 | Verify the running container digests | a running container is not the released image |
| 13 | Post-deployment smoke | any smoke check fails |
| 14 | Record deployment evidence | — (evidence is written for failures too, from stage 7 onward) |

There is no `--skip-smoke`. A deployment that cannot be validated is not a
deployment that happened successfully.

**Where release eligibility is enforced.** In the manifest schema, which both
halves apply. A published release is only valid with complete gate evidence for
its own commit, so `tooling/deploy.sh` establishes eligibility by *reading what
was authorised when the release was created* — never by re-deriving it from
mutable branch state at deployment time. The script additionally refuses a
non-deployable manifest unless the environment declares
`ORGISTRY_ENVIRONMENT_CLASS=rehearsal`, which is how a local rehearsal can
deploy its own output to a throwaway target without that path ever being
available to a real environment.

## Operator runbook: first deployment to a new target

Every command below is one this repository actually implements. Nothing here is
hypothetical. Run them **on the target host**, from an Orgistry checkout.

### 0. Prerequisites

| | |
| --- | --- |
| Host | Durable (not a CI runner), **x86-64** — see [the architecture constraint](#the-architecture-constraint-is-real-and-it-is-now-a-gate) — with outbound HTTPS to `ghcr.io` |
| Required on the host | `bash`, **Docker Engine**, **Docker Compose v2**, **`curl`**, **`node`**, and standard coreutils. Nothing else — see [Host tool requirements](#host-tool-requirements) for exactly why each is needed and what is *not* required |
| Access | Non-shared administrative account; SSH restricted to keys; the deploying user in the `docker` group (equivalent to root on the host — treat it as such) |
| Backing services | PostgreSQL with persistent storage and a Redis, operator-provided. Neither is in the deployment topology; both must be reachable from `ORGISTRY_DEPLOY_NETWORK` or as external services |
| Mail | A **staging-safe** mail configuration — see [Staging mail model](#staging-mail-model). **No production email provider is required**, and none should be used |
| Registry credential | **None currently required** — the packages are currently publicly pullable. Confirm with `pnpm deploy:preflight`, which pulls both digests from the host. See [Package visibility](#package-visibility--observed-state) |
| Data | **Synthetic only.** A staging-like target must never hold real user data |

#### Host tool requirements

Determined by reading what the host-side scripts actually invoke, not by
copying a workstation's toolchain.

| Tool | Required? | Why |
| --- | --- | --- |
| `bash` | **yes** | Every deployment script is bash |
| Docker Engine | **yes** | Runs the deployment, and the PostgreSQL client tools for the backup preflight run in a *pinned container* — so no `pg_dump`/`psql` is needed on the host |
| Docker Compose v2 | **yes** | `infra/compose.deploy.yml` is applied with `docker compose` |
| `curl` | **yes** | Health, readiness, and post-deployment smoke are probed over HTTP |
| `node` | **yes** | `tooling/release-manifest.mjs` and `tooling/deploy-evidence.mjs` are Node programs that run **on the host**: the manifest is validated there and the evidence ledger is written there |
| coreutils (`awk`, `grep`, `sed`, `stat`, `df`, `id`, `date`, `tr`, `tail`, `basename`) | **yes** | Present on any Linux host; listed for completeness |
| `git` | **no** | No host-side script invokes it. Getting the repository files onto the host is a delivery choice — clone, tarball, or `rsync` all work |
| `pnpm` | **no** | The `pnpm deploy:*` scripts are thin wrappers; `bash tooling/deploy.sh …` runs identically. Convenient if present, never required |
| `systemctl` | optional | Only the preflight's boot-persistence check uses it, and it warns rather than fails when absent |
| `sha256sum` | optional | The backup tooling falls back to `shasum` |

`pnpm deploy:preflight` verifies the required set on the candidate host before
anything is deployed.

### 1. Configure the host

```sh
git clone https://github.com/DanielRosenberg00/Orgistry.git /opt/orgistry
sudo install -d -m 0750 -o "$(id -un)" /etc/orgistry
sudo install -d -m 0750 -o "$(id -un)" /var/lib/orgistry/deployments /var/lib/orgistry/backups

# HOW to deploy — no secrets, safe to keep in your own infrastructure repo.
cp /opt/orgistry/infra/deploy.env.example /etc/orgistry/deploy.env
$EDITOR /etc/orgistry/deploy.env

# WHAT the application runs with — every runtime secret. Never committed.
umask 077 && $EDITOR /etc/orgistry/runtime.env && chmod 600 /etc/orgistry/runtime.env
```

The runtime configuration contract — every variable and its production rules —
is [above](#deployment-configuration-contract). `NODE_ENV=production` is
mandatory: it is what activates the API's own config guard, which refuses
development secrets, non-deliverable sender domains, and insecure cookies.

### 2. Select a release

Run the `Deploy` workflow (manual dispatch: environment + the `Release` run ID).
It validates the manifest, refuses a release that is not gate-authorised,
proves both digests still resolve, and prints the plan. Then bring that run's
`release-manifest` artifact onto the host:

```sh
gh run download <RELEASE_RUN_ID> --repo DanielRosenberg00/Orgistry \
   --name release-manifest --dir /etc/orgistry
```

### 3. Qualify the host — before deploying anything

```sh
pnpm deploy:preflight -- --config /etc/orgistry/deploy.env \
                        --manifest /etc/orgistry/release-manifest.json --json
```

Resolve every `FAIL` before continuing. Keep the `--json` baseline: it is the
sanitized host record for your deployment documentation.

### 4. Deploy

```sh
pnpm deploy:run -- --manifest /etc/orgistry/release-manifest.json \
                  --config /etc/orgistry/deploy.env
```

Fourteen stages, each naming itself on failure. `DEPLOY OK` prints the commit,
both digests, the migration result and verified head, the backup and its
recovery point, the smoke result, the evidence path, and the rollback target.

### 5. Read the evidence

```sh
pnpm deploy:evidence -- current --dir /var/lib/orgistry/deployments \
                                --environment staging-like
```

Check three things: `smoke.result` is `passed`; `runtime` digests equal the
manifest's; and `limitations` is what you expect. A record with an
`under CPU emulation` limitation is not a validated deployment of a supported
configuration.

### 6. Deploy a second release, then prove rollback works

Do this **before** you need it. Repeat steps 2–4 with a newer release, then:

```sh
pnpm deploy:rollback -- --config /etc/orgistry/deploy.env --dry-run   # inspect
pnpm deploy:rollback -- --config /etc/orgistry/deploy.env             # execute
```

Rollback resolves the previous smoke-passing release from this host's own
ledger, redeploys those digests with `--no-migrate`, and re-runs smoke. **It
does not reverse migrations** — see [Rollback model](#rollback-model). If a
migration since the target release removed or rewrote something the older code
reads, rollback will not fix the incident; recovery is a restore or a PITR
([backup-and-restore.md](backup-and-restore.md), [pitr.md](pitr.md)).

### Common failure modes

| Symptom | Cause | Action |
| --- | --- | --- |
| Stage 5 refuses: image is `linux/amd64`, host is `linux/arm64` | The host's CPU architecture is not the published images' | Move to an x86-64 host. Do **not** reach for the emulation opt-in on a target anyone depends on |
| Stage 3 refuses the runtime env file's mode | It is group- or world-readable | `chmod 600` it. It holds every runtime secret |
| Stage 3 refuses a non-deployable release | The manifest is a rehearsal, or its gates did not pass for its own commit | Deploy a release the `Release` workflow published from `main` |
| Stage 4 cannot pull a digest | No outbound HTTPS to `ghcr.io`, or the digest was deleted | Check egress first — no credential is involved |
| Stage 9: "the API container did not become healthy" | Almost always the production config guard rejecting runtime configuration | `docker logs <project>-api-1` — the guard names the offending variable and why |
| Stage 8: applied head ≠ manifest head | The database is not the one this release expects | Stop. Do not force. Confirm `DATABASE_URL` names the right database |
| Smoke fails on the browser API origin | `ORGISTRY_PUBLIC_API_BASE_URL` is not what the browser should use | Fix the deployment configuration and redeploy; never rebuild the web image for an environment |

### Emergency stop

```sh
project="$(grep '^ORGISTRY_COMPOSE_PROJECT=' /etc/orgistry/deploy.env | cut -d= -f2)"
docker stop $(docker ps --quiet --filter "label=com.docker.compose.project=${project}")
```

The containers are addressed by their Compose project **label**, deliberately.
`infra/compose.deploy.yml` declares its image references as
`${ORGISTRY_API_IMAGE:?…}`, so a plain `docker compose … stop` against that file
fails interpolation unless a release manifest has already been exported into the
environment — which is not something to discover during an incident.

This stops the API and web containers and nothing else: no database, no volume,
no evidence. The ledger still describes what *was* running, which is exactly
what a rollback needs. Prefer `pnpm deploy:rollback` when a known-good release
exists; stop only when no release is safe to serve.

### Decommissioning a staging-like target

```sh
project="$(grep '^ORGISTRY_COMPOSE_PROJECT=' /etc/orgistry/deploy.env | cut -d= -f2)"
docker rm --force $(docker ps --all --quiet --filter "label=com.docker.compose.project=${project}")
docker network rm "$(grep '^ORGISTRY_DEPLOY_NETWORK=' /etc/orgistry/deploy.env | cut -d= -f2)"
shred -u /etc/orgistry/runtime.env      # every runtime secret lives here
```

Then rotate anything that file held ([rotation-runbook.md](rotation-runbook.md)):
decommissioning a host does not un-disclose a secret it stored. Keep
`/var/lib/orgistry/deployments` if you want the deployment history; it contains
no secrets. Backups in `/var/lib/orgistry/backups` **do** contain user data and
password/API-key hashes — destroy or move them deliberately
([backup-and-restore.md](backup-and-restore.md#7-backup-security)).

## Migration lifecycle

```
pre-deployment validation
  -> backup / PITR preflight (taken, or skipped WITH a recorded reason)
  -> migration artifact runs ONCE
  -> applied head verified against the release manifest
  -> API deployed
  -> web deployed
  -> readiness
  -> post-deployment smoke
```

- The migration artifact is the release's **own API image**, run as
  `node dist/migrate.mjs` in its own container
  (`docker compose run --rm --no-deps migrate`). The service is behind a Compose
  profile so `up` can never start it.
- **Single owner, single run.** The API never migrates at boot
  ([deployment-artifacts.md](deployment-artifacts.md), "Migration policy"), so
  no replica can race the migration step, and scaling the API to N instances
  does not scale the migration to N runs.
- **Failure blocks the deployment.** No new application container is started,
  and the previously running release (if any) is untouched. Drizzle applies each
  migration transactionally, so the old process never observes a half-applied
  migration.
- **The applied head is verified, not assumed.** After migrating, the deployment
  queries Drizzle's ledger and requires both the row count and the newest
  `created_at` to match the manifest's `migrations.count` and
  `migrations.appliedAtMs` — the journal timestamp Drizzle stores per migration.
  This catches a database that is behind, ahead, or from a different lineage,
  without parsing SQL. Set `ORGISTRY_MIGRATION_VERIFY=off` only when the host
  genuinely cannot reach the database; the deployment then records that the head
  was **not** verified.
- **Repeated deployment is safe.** Re-running an applied baseline is a no-op
  that still verifies the head. The rehearsal deploys twice on purpose.
- **Migrations are forward-only.** There are no down migrations, and nothing
  here rolls a schema back. See [Rollback model](#rollback-model).

## Backup and PITR preflight

The deployment integrates the Sprint 25 tooling at exactly one point — the
moment before a schema changes — and claims nothing beyond it.

`ORGISTRY_BACKUP_PREFLIGHT=take` (the default) runs the real
`tooling/db-backup.sh` against the deployment database with the label
`pre-deploy`, and records the artifact name and the resulting **recovery point**
(the UTC instant the backup completed) in the deployment record. A failed
backup **aborts the deployment before migrations**, leaving the target
untouched; that abort writes no deployment record, because nothing was deployed.

`ORGISTRY_BACKUP_PREFLIGHT=skip` requires `ORGISTRY_BACKUP_SKIP_REASON`. An
unexplained skip is refused: during an incident, an unexplained skip is
indistinguishable from an oversight. A rollback (`--no-migrate`) skips the
preflight automatically with the reason recorded, because it creates no new
recovery-point requirement.

Verifying WAL archival health before a migration is **not** implemented: no
long-lived database with continuous archiving exists to verify. When one does,
the check belongs in this stage, and its result belongs in the same record.

What cannot be verified until real production backup infrastructure exists:
that backups are scheduled, that they are stored off-host and encrypted, that a
restore meets the ratified RTO at production data volume, and that WAL archiving
gives the ratified RPO. All of that is `ORG-PR-005`, which this integration does
**not** close: taking a backup at deploy time is not a backup programme.

## Health, readiness, and post-deployment smoke

The API's `/health` is liveness-only and touches no dependency; `/ready` gates
on PostgreSQL and Redis and stays coarse in production (Sprint 19 disclosure
policy). The deployment waits for `/health`, then `/ready`, then runs smoke.

`tooling/deploy-smoke.sh` is a standalone, URL-only command:

```sh
tooling/deploy-smoke.sh --api-url https://api.example.test --web-url https://app.example.test
```

Nine checks: `/health` envelope; `/ready` envelope; `/ready` discloses no
dependency; six baseline security headers on an API response; a client-supplied
`x-request-id` echoed unchanged; the web artifact serves a production build (not
a dev server); the SPA history fallback resolves a client route; the deployment
applied the expected **public browser configuration** (read back from
`/public-config.js`); and the environment's API origin does **not** appear in
the immutable bundle — the regression test for promotability, skipped only when
the environment happens to use the image's built-in localhost default, where
its presence would prove nothing either way.

Deliberately absent, with reasons:

- **No authenticated request.** It would need a credential, and no dedicated
  safe test tenant or API key exists in any environment. Creating a production
  credential to satisfy a checklist would be worse than an unproven check. If a
  disposable test tenant is ever created for a real environment, an
  API-key-authenticated read of a known-empty project list is the natural
  addition — the restore drill already proves that path works against the
  packaged artifact.
- **No migration-head check.** That needs the database, and this command must
  stay runnable from anywhere that can reach the URLs. `tooling/deploy.sh` does
  it at stage 7.
- **No response bodies in the output.** Only status codes, header names, URLs,
  and short body markers are printed; a failing endpoint can echo request
  context, and this script must never be the thing that logs it.

Exit code is 0 only when every check passed.

## Deployment evidence

`tooling/deploy-evidence.mjs` maintains an append-only ledger per environment
under `ORGISTRY_EVIDENCE_DIR`:

```
<dir>/<environment>/records/<timestamp>-<commit12>-<mode>.json
<dir>/<environment>/releases/<commit>-<apiDigest12>.json     copy of the manifest
<dir>/<environment>/current.json                             newest record
```

A record carries: environment, mode (`deploy` or `rollback`), actor, timestamp,
the release identity (commit, ref, both digest-pinned references, both digests,
migration head, and the stored manifest filename), the **authorization** that
release carried (its type, deployability, provenance, and — for a deployable
release — the gate run IDs and conclusions), the **public configuration** the
deployment applied (its values plus a fingerprint), the migration result and
verified head, the backup preflight result with its reason/artifact/recovery
point, the smoke result and check count, the digests **observed running on the
target**, the rollback target that was known-good at that moment, and the
standing limitations that must travel with the evidence.

Six questions therefore have an answer that does not depend on anyone's memory:
what API digest is running, what web digest is running, what public runtime
configuration was applied, what release authorised those digests, what exact
gate runs authorised that release, and what the previous rollback target is.

Two properties make it useful rather than decorative:

- **Failed deployments are recorded too**, from the migration stage onward. A
  ledger that only contains successes describes a tidier history than actually
  happened.
- **A record cannot claim a validated deployment without observed digests.**
  Validation refuses a record whose smoke passed but whose runtime digests are
  absent.
- **Public configuration is recorded, and only public configuration can be.**
  The builder refuses any key outside `apiBaseUrl`, `csrfHeaderName`,
  `mailpitUrl`, so a secret cannot be written into evidence even by mistake.
- **A non-deployable release cannot carry gate runs**, and a deployable one must.

So both operational questions have an answer that does not depend on anyone's
memory:

```sh
pnpm deploy:evidence current --dir /var/lib/orgistry/deployments --environment staging-like
tooling/deploy-rollback.sh --config /etc/orgistry/deploy.env --dry-run
```

Every record is non-secret by construction and validated against the same
credential-shape guard as the release manifest.

## Rollback model

Three distinct operations. Conflating them is how a rollback turns into an
outage.

### 1. Application rollback — supported and rehearsed

```sh
tooling/deploy-rollback.sh --config /etc/orgistry/deploy.env [--dry-run]
```

Resolves the previous **known-good** release from the ledger, then redeploys
exactly those digests with `--no-migrate`, waits for health and readiness, and
re-runs smoke. "Known-good" means all of: post-deployment smoke passed, it is
not the release currently deployed, and it has not already been rolled away
from. That last rule is what stops a rollback from restoring the release the
previous rollback was escaping — a release can serve `/health` perfectly and
still be the reason for the rollback, so "smoke passed" alone is not enough.

If nothing qualifies, the command fails and says so. That is a legitimate
answer: the environment has no earlier release to fall back to, and the operator
must fix forward or recover.

The digests come from the previous release's own manifest, which the deployment
copied onto the host — so a rollback needs no registry API, no workflow artifact
that may have expired, and no operator remembering a SHA.

**What an application rollback restores: image digests only.** The environment's
public browser configuration is applied fresh from the deployment configuration
file, so rolling back across a configuration change restores the old code under
the *current* configuration. That is usually what an operator wants — the
rollback is about the code — but it must never be silent. `deploy-rollback.sh`
prints the public API origin recorded for the target release and, when the
environment's current value differs, says explicitly that the current one will
be applied. Rolling configuration back as well is the separate operation in
[Configuration rollback](#3-configuration-rollback), performed after the
application rollback with the restored configuration file.

### 2. Database rollback — does not exist, and must not be implied

- Deploying older containers **does not** reverse a schema change. It restores
  older code against the current schema.
- Migrations are forward-only; there are no down migrations.
- An application rollback across an additive migration is normally fine. It
  stops being fine the moment a migration dropped or rewrote something the older
  code reads — then the old code fails against the new schema.
- Undoing a destructive schema change is a **recovery** operation: restore from
  backup ([backup-and-restore.md](backup-and-restore.md)) or point-in-time
  recovery ([pitr.md](pitr.md)). Both are tested capabilities; neither is a
  routine rollback, both lose data written after the recovery point, and both
  require a real backup, which no deployed environment produces yet
  (ORG-PR-005).
- **Assess migration compatibility before reverting an application version.**
  Compare the target release's `migrations.head` with what the database has
  applied; the deployment records both, so the comparison is a ledger read
  rather than an investigation.

`tooling/deploy-rollback.sh` prints this scope warning on every non-dry run.

### 3. Configuration rollback

Secrets and runtime configuration are not in the ledger — they are operator-owned
files by design. The **public browser configuration** is different: it is
non-secret, so every deployment record carries its values and a fingerprint, and
a rollback can therefore tell you exactly what configuration the target release
ran with.

To roll configuration back: restore the previous `deploy.env` and/or
`runtime.env` (or the previous secret version in whatever store the operator
uses), then recreate the runtime, because configuration is read once at process
start and there is no hot reload
([runtime-secrets.md](runtime-secrets.md#restart-behavior)):

```sh
tooling/deploy.sh --manifest <the manifest currently deployed> --config /etc/orgistry/deploy.env --no-migrate
tooling/deploy-smoke.sh --api-url ... --web-url ...
```

Redeploying the same digests with restored configuration is the supported path:
readiness and smoke then validate the result exactly as they would a release
change. Because the web image is environment-neutral, changing the browser's API
origin is a configuration rollback of exactly this kind — no rebuild, no new
digest.

    pnpm deploy:evidence current --dir <ledger> --environment <env> --field publicConfig.values.apiBaseUrl

## The deployment rehearsal

`pnpm deploy:rehearsal` (`tooling/deploy-rehearsal.sh`) runs the entire
lifecycle on one machine against a throwaway OCI registry and throwaway
PostgreSQL and Redis containers:

```
build once -> push -> capture digests -> release manifest -> deploy by digest ->
migrate once -> readiness -> smoke -> evidence -> second release -> rollback to
the previous known-good digests -> verify what is actually running
```

Between the first and second releases it also **promotes** the first: the same
manifest is redeployed with a different `ORGISTRY_PUBLIC_API_BASE_URL`, and the
rehearsal asserts the running digests are unchanged while the served browser
configuration follows the new environment. That is the end-to-end proof that
promotion is a configuration change rather than a rebuild.

It exercises four refusals: a tag-pinned manifest; a rehearsal release offered
to a `deployment`-class environment; a rehearsal manifest relabelled as a
published release; and a group-readable runtime configuration file.

The two rehearsal releases are built from the same source and differ only by an
image **label**, which gives them distinct digests. That is deliberate: the
rehearsal proves the deployment switches between two digests and can return to
the earlier one — application behavior is the artifact smoke test's and the test
suites' job. Both are pushed under the same tag, demonstrating that the tag is
not the identity.

**Its manifests are never releases.** Every one is `release.type: rehearsal`,
`deployable: false`, with no gate evidence, and — when the working tree is
dirty — `provenance: working-tree` plus a fingerprint of that tree. See
[Release provenance](#release-provenance-published-vs-rehearsal).

**What it is not:** not staging, not a staging-like environment, not evidence
about GHCR (authentication, package visibility, and retention are the release
workflow's concern), and not a performance rehearsal. Everything it creates —
including the temporary runtime configuration file holding its fake credentials
— is destroyed on exit.

It runs on demand and weekly via `.github/workflows/deployment-rehearsal.yml`,
for the same reason the PITR drill is not in CI: it validates a *strategy* that
changes only when the deployment tooling, the compose topology, or the
Dockerfiles change.

## External and operator-only configuration

None of the following can be represented in this repository, and **none of it is
configured**. Each is an operator action in GitHub or on a host. Do not treat
any of it as done until the verification command confirms it.

| # | Action | Status | Verify |
| --- | --- | --- | --- |
| 1 | Run the `Release` workflow so the two GHCR packages exist | **DONE** — run `32776576782` published both images for `91664d0` | `gh run list --workflow=release.yml` |
| 2 | Decide and record each package's visibility | **OPEN — but the observed state is corrected.** Both packages are *currently* publicly pullable, verified 2026-08-25 by an unauthenticated digest pull; Sprint 26's "both remain private" entry was factually wrong. No visibility policy has been approved or recorded, and nothing in this repository changed it. See [Package visibility](#package-visibility--observed-state) | `docker pull` with `DOCKER_CONFIG` set to an empty directory |
| 3 | Give the deployment host a read-only pull credential | **NOT REQUIRED WHILE THE PACKAGES ARE PUBLIC** — this removes the host's only registry secret. Becomes required again if an operator makes them private | as above |
| 4 | Add required reviewers to the `staging-like` GitHub Environment | **OPEN — impractical for this repository.** The environment exists with **zero protection rules** (observed 2026-08-25: `protection_rules: []`, `deployment_branch_policy: null`). Required reviewers on a single-maintainer repository would mean the sole maintainer approving their own deployment, which is a log entry, not a control. Recorded as a limitation rather than simulated | `gh api /repos/DanielRosenberg00/Orgistry/environments` |
| 5 | Restrict that environment's deployment branches to `main` | **OPEN — worth doing, and unlike (4) it is a real control.** It stops a `Deploy` dispatch from an arbitrary branch reaching environment secrets. One operator command: `gh api -X PUT /repos/DanielRosenberg00/Orgistry/environments/staging-like -f 'deployment_branch_policy[protected_branches]=true' -f 'deployment_branch_policy[custom_branch_policies]=false'`. Not applied by Sprint 27: nothing in this repository mutates remote configuration | same call |
| 6 | Decide whether `Deployment rehearsal` should be a required check (see below) | **OPEN** — deliberately not required | `gh api /repos/DanielRosenberg00/Orgistry/rulesets/19769611` |

### GitHub Environment protection — status

```
Environment exists:                              YES  (staging-like)
Environment protection rules validated/configured: NO
Operator action required:                        YES
```

Observed 2026-08-25 via `gh api /repos/DanielRosenberg00/Orgistry/environments`:
`protection_rules: []`, `deployment_branch_policy: null`. **This requirement is
not complete and must not be reported as complete.** Nothing in this repository
mutates remote configuration, and no repository settings were changed — doing so
is an external side effect that needs explicit operator authorisation.

The single-maintainer limitation is real and stays documented: required
reviewers here would mean the sole maintainer approving their own deployment,
which produces a log entry rather than a control. The deployment-branch
restriction in (5) is a genuine control and is the action worth taking.

Until (4) and (5) happen, `environment: staging-like` provides no protection
beyond the workflow being manual-dispatch-only — GitHub created the environment
implicitly on the first `Deploy` run, with zero protection rules, and Sprint 27
re-observed it in exactly that state. The environment scoping is still worth
having: it is where a deployment secret would live, and it is the boundary an
untrusted pull request cannot cross.

## Branch protection

Sprint 26 changes nothing about the six existing required checks
(`Validate (offline)`, `Integration (PostgreSQL + Redis)`,
`Artifacts (build + smoke)`, `Dependency audit (pnpm)`,
`Secret scan (Gitleaks)`, `Analyze (javascript-typescript)`), and all of them
still run unchanged on every pull request. The new deployment tooling is covered
by them where it is deterministic: the release-manifest and evidence unit tests
run inside `pnpm test`, i.e. inside `Validate (offline)`, on every pull request.

The three new workflows are deliberately **not** required checks:

- `Release` runs only on pushes to `main` and manual dispatch — it is not a
  pull-request check at all.
- `Deploy` is manual, environment-scoped, and target-dependent. Making a
  deployment a universal PR gate would be wrong on its face.
- `Deployment rehearsal` is manual and weekly, matching the `Data durability`
  precedent: several minutes of image builds and three deployments per run, for
  a strategy that changes rarely. A maintainer who wants it enforced would make
  that a branch-protection change in repository settings; nothing in this
  repository mutates remote configuration.

Repository implementation and external GitHub ruleset configuration remain
separate concerns — see
[validation.md](validation.md#branch-protection) for the live-configuration
check.

## Known limitations

Deployment-specific. The project-wide list is
[known-limitations.md](known-limitations.md).

- ~~**No deployment target exists.**~~ **RESOLVED 2026-08-27.** A durable
  staging-like target exists and has been validated
  ([evidence](#sprint-27-real-target-validation-evidence)). **No production
  target exists**, and the staging-like target holds synthetic data only.
- **Account email does not work on the staging-like target.** `MAIL_DRIVER=smtp`
  points at a plaintext Mailpit sink while the driver requires implicit TLS with
  verification always on, so sends fail closed. That is the correct
  architectural behaviour, it was not exercised by Sprint 27 (all smoke is
  unauthenticated), and it means registration, verification, and invitation
  flows will error on that target. Fixing it means giving the sink a
  publicly-trusted certificate on an SMTPS port — not adding a provider
  (ORG-PR-002).
- **Published images are single-architecture `linux/amd64`.** They are built on
  GitHub's amd64 runners and no multi-arch manifest list is produced, so an
  arm64 host cannot run them without emulation. Since Sprint 27 this is
  **enforced** rather than merely documented: the target preflight and stage 5
  of every deployment refuse a platform mismatch before anything touches the
  database, and emulation is an explicit opt-in recorded on the deployment
  evidence. The constraint itself remains — a target must be x86-64, or the
  release workflow must start publishing multi-architecture images.
- **Rollback has now run on a durable target** (2026-08-27): two real,
  gate-authorised, GHCR-published releases, rolled back by digest, with public
  HTTPS smoke and running-digest verification. **Rollback under real user
  traffic remains untested** — the target has synthetic data and no users.
- **The `Deploy` workflow verifies; it does not deploy.** It resolves and
  authorises a release and emits the operator plan; the operator executes
  `tooling/deploy.sh` on the host. This is deliberate, and it is the model that
  was exercised for real on 2026-08-27 (run `33061763360`). **No inbound
  exposure was created to let CI reach the target**, and none should be.
- **The `staging-like` GitHub Environment now carries an active
  deployment-branch policy** (`protected_branches: true`), applied by the
  operator. **Required reviewers remain unconfigured** and are impractical on a
  single-maintainer repository — a documented limitation, not a simulated
  control.
- **The `main` ruleset is the source of the required-check list**, and the
  release gate mirrors it in `REQUIRED_GATES`. If a maintainer changes the
  ruleset without updating that list, the release gate would authorise against
  the old set. The list is deliberately in one place and imported by the
  manifest validator, but nothing automatically reconciles it with the live
  ruleset.
- **Migration rollback does not exist** and is not claimed anywhere.
- **The backup preflight is a single pre-migration backup**, not a backup
  programme: nothing schedules backups, nothing stores them off-host, nothing
  encrypts them, no WAL archival health check exists, and no RPO/RTO has been
  measured (ORG-PR-005).
- **Secrets are files on a host.** No secret store, no access control, no
  read auditing, no automated rotation (ORG-PR-006).
- **No TLS, DNS, reverse-proxy, WAF, or CDN configuration** is provided. A real
  deployment terminates TLS in front of these containers and sets `TRUST_PROXY`
  accordingly; all of that is the operator's responsibility.
- **No observability.** No metrics, dashboards, log shipping, or alerting on a
  failed deployment, a failed migration, or a fail-closed rate limiter
  (ORG-PR-007, ORG-PR-009).
- **No artifact signing and no provenance attestation** (deliberately out of
  Sprint 26 scope; tracked under ORG-PR-001's successor work).

<a id="remaining-staging-blockers"></a>
### Staging blockers — resolved 2026-08-27

All six blockers recorded through Sprint 26 are now satisfied: a durable
`linux/amd64` host, operator-provided PostgreSQL and Redis, a registry that
needs no credential, staging-safe mail configuration, TLS with real public
origins, and a GitHub Environment with an active deployment-branch policy. The
original list is kept below for continuity.

**Staging readiness is still NO** for reasons outside that list: account email
does not work on the target, and there is no observability there.

### Original staging blocker list (for continuity)

1. A host or provider account that can run the compose topology. **Host
   procurement constraint: select an x86-64 / amd64 target**, since the
   published images are single-architecture `linux/amd64` unless a future
   authorised sprint changes the publication architecture (see
   [the architecture constraint](#the-architecture-constraint-is-real-and-it-is-now-a-gate)).
2. A managed or operated PostgreSQL and Redis for it.
3. ~~A pull credential for the host, or public package visibility.~~
   **NOT CURRENTLY BLOCKING.** Both packages are *currently* publicly pullable
   from any host with outbound HTTPS, proven by an unauthenticated digest pull
   on 2026-08-25, so the deployment host needs no registry credential. This is
   an observed state, not an approved policy: if an operator makes the packages
   private, this blocker returns.
4. ~~A real SMTP provider.~~ **NOT A STAGING BLOCKER.** The production config
   guard constrains the mail *driver*, *credential*, and *sender domain* — not
   the endpoint's identity — so a staging-like target runs with
   `MAIL_DRIVER=smtp` pointed at an operator-run, isolated sink. See
   [Staging mail model](#staging-mail-model). Delivery through a real provider
   has still never been validated, and **ORG-PR-002 remains open** — it is
   simply not a prerequisite for deploying to a staging-like target.
5. TLS termination and a public origin, so `COOKIE_SECURE=true`,
   `WEB_DEMO_URL`, and `CORS_ORIGINS` describe something real.
6. A GitHub Environment with the deployment protections above.

### Remaining production blockers

Everything in the staging list, plus: scheduled off-host encrypted backups with
WAL archiving and a measured RPO/RTO (ORG-PR-005); a secrets platform with
access control and auditability (ORG-PR-006); validated external email
(ORG-PR-002); observability and alerting (ORG-PR-007); an incident process
(ORG-PR-008); and a rehearsed rotation and restore against the real environment.
**Orgistry is not production ready, and a successful deployment would not make
it so.**

## Extending this safely

- **Adding a deployment stage:** put it in `tooling/deploy.sh` as its own
  `deploy_stage`, fail with `deploy_die` naming what could not be satisfied, and
  decide explicitly whether a failure there should write a deployment record
  (it should, if the target was already touched).
- **Adding a host requirement:** put the check in
  `tooling/deploy-target-preflight.sh` if it qualifies a host, and in
  `tooling/deploy.sh` as well only if a deployment must refuse when it is unmet.
  The platform gate is in both for exactly that reason: the preflight tells an
  operator a host is unsuitable, and the deployment refuses to proceed on one.
- **Adding a smoke check:** put it in `tooling/deploy-smoke.sh` only if it needs
  nothing but the URLs. Anything needing the database, a credential, or
  configuration belongs in `tooling/deploy.sh`.
- **Adding a manifest field:** add it to `buildReleaseManifest` and a rule to
  `validateReleaseManifest` in `tooling/lib/release-manifest.mjs`, plus a test.
  Never add a field a build cannot genuinely know — deployment-time facts belong
  in the evidence record.
- **Adding an evidence field:** same split, in `tooling/lib/deploy-evidence.mjs`.
  If the field can be absent, decide what absence means and validate that.
- **Changing the rollback rule:** it lives in exactly one function,
  `selectRollbackTarget`. Change it there and nowhere else; the shell only
  consumes its output, one named field at a time.
- **Adding a public browser value:** add it to `PublicConfig` and
  `PUBLIC_CONFIG_DEFAULTS` in `apps/web-demo/src/public-config.ts`, to the
  `location = /public-config.js` block in `apps/web-demo/nginx.conf.template`
  with an `ORGISTRY_PUBLIC_` name and an `ENV` default in the web Dockerfile,
  and to `PUBLIC_CONFIG_KEYS` in `tooling/lib/deploy-evidence.mjs`. It must be
  safe to serve to every browser; the application refuses credential-shaped
  keys, and evidence refuses anything outside that list.
- **Changing the required checks:** update `REQUIRED_GATES` in
  `tooling/lib/release-gates.mjs` — the manifest validator imports it, so the
  two stay in step — and update the `main` ruleset to match.
- **Adding a runtime variable:** follow
  [runtime-secrets.md](runtime-secrets.md#extending-this-safely), then add it to
  the presence-check list in `tooling/deploy.sh` if a deployment cannot start
  without it.
- **After any change to the deployment tooling, the compose topology, or either
  Dockerfile:** run `pnpm deploy:rehearsal` before merging.

## Remote validation evidence

The first real release of this pipeline, recorded here because a deployment
model is only as good as its executed evidence. Source of truth: the runs
themselves.

| Item | Evidence |
| --- | --- |
| Release source | `91664d0fd639ca6ca8b5681317757bbcf0f0209b` (PR #38 merge, `main`) |
| `Release` run | `32776576782`, attempt 1, event `push`, **success** |
| Gate authorization | `32776576684` (CI: Validate / Integration / Artifacts), `32776576586` (Security: Dependency audit / Secret scan), `32776576905` (CodeQL: Analyze) — all `success`, all `head_sha` = the release commit |
| Published API image | `ghcr.io/danielrosenberg00/orgistry-api@sha256:9b79d72c045f…` |
| Published web image | `ghcr.io/danielrosenberg00/orgistry-web@sha256:20dc434b7b62…` |
| `Deploy` run | `32777270537`, environment `staging-like`, **success** — manifest validated, deployability and gate evidence confirmed, both digests resolved in the registry, plan emitted |
| `Deployment rehearsal` run | `32777259951`, **success** — 65 assertions, 4 deployments × 9 smoke checks, 4 refusals, same-digest promotion, rollback |
| `Data durability` run | `32777249673`, **success** — PITR drill re-verified after Sprint 26 modified the Sprint 25 durability tooling |

**The bounded-wait race behavior was exercised for real.** `Release` started
from the same push as CI, Security scans, and CodeQL. Its gate job logged
`[pending]` for every check that had not concluded, re-polled every 20s for
roughly three minutes, and proceeded only once all six reported `success`. No
gate was ever treated as satisfied because its run had not appeared yet.

**A second release followed on the same day.** The Sprint 26 final-artifact
merge `d51c76b5ee6b0d6183b76ac4b8efacdee94ae704` produced `Release` run
`32779601026`, publishing `orgistry-api@sha256:7afc079b3844…` and
`orgistry-web@sha256:b0d5dd000ab2…`. It declares the same migration head as
`91664d0`, which is what made the Sprint 27 rollback test possible without
manufacturing a release.

**Promotion was proven against the published artifact, not only the rehearsal.**
The published web digest `sha256:20dc434b7b62…` was started twice with two
different `ORGISTRY_PUBLIC_API_BASE_URL` values; both containers report the same
image digest, each serves its own origin from `/public-config.js`, and neither
origin appears anywhere in the built assets.

## Sprint 27 real-target validation evidence

```
Real staging-like target validated: YES  (2026-08-27)
ORG-PR-001: CLOSED
```

The Sprint 26 mechanism was executed end to end against a durable external
staging-like target. This supersedes the earlier published-artifact local
rehearsal, which is retained below as supporting history.

### The target

| | |
| --- | --- |
| Sanitized identity | `orgistry-staging-01` — DigitalOcean, FRA1 |
| Platform | `linux/amd64`, Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic |
| Resources | 2 vCPU · 4 GiB RAM · ~74 GiB free |
| Runtime | Docker 29.7.2 · Compose v5.5.0 · bash 5.2.21 · curl 8.5.0 · node v22.23.2 |
| Durability | Docker enabled at boot; `restart=unless-stopped`; PostgreSQL on a named volume |
| Public origins | `https://staging.drsvp.com`, `https://api-staging.drsvp.com` |
| Edge | Caddy v2.11.4; Let's Encrypt, valid to 2026-11-25; HTTP→HTTPS `308` |
| Inbound exposure | **22/80/443 only** — externally probed and confirmed |
| Data | **Synthetic only** |

### What was executed

| Step | Result |
| --- | --- |
| `deploy-target-preflight.sh` **on the host** | **PASS** — 0 failed, 0 warned |
| Target-side GHCR digest pulls | **PASS** — no registry credential exists on the host |
| Deploy `91664d0` | **PASS** — backup `taken`, migration applied once, head `0012_shocking_warbound` (13) verified, API healthy, web up, running digests verified, smoke 9/9, evidence written |
| **Public HTTPS smoke** | **PASS 9/9** — from outside the host |
| Restart / persistence | **PASS** — `/ready` 200 after 3s; ledger 13 before and after |
| Deploy `d51c76b` | **PASS** — same lifecycle; public HTTPS smoke 9/9 |
| **Real application rollback** | **PASS** — `91664d0`'s exact digests restored with `--no-migrate`; public HTTPS rollback smoke 9/9; running images cross-checked as Release 1's; ledger still 13 |
| Deploy workflow `33061763360` | **PASS** — bound to `staging-like`, manifest validated, gates confirmed, both digests resolved |
| Evidence secret-hygiene scan | **PASS** — no credential material |

### The 502s disappeared

| Origin | Before | After |
| --- | --- | --- |
| `https://staging.drsvp.com/` | 502 | **200** |
| `https://api-staging.drsvp.com/health` | 502 | **200** `{"ok":true,"data":{"status":"ok"}}` |
| `https://api-staging.drsvp.com/ready` | 502 | **200** `{"ok":true,"data":{"status":"ready"}}` |

### Deployment ledger on the target

```
2026-08-27T10:04:15.026Z  deploy    91664d0fd639  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=none
2026-08-27T10:07:13.595Z  deploy    d51c76b5ee6b  migration=applied  backup=taken    smoke=passed(9)  rollbackTarget=91664d0fd639
2026-08-27T10:08:02.764Z  rollback  91664d0fd639  migration=skipped  backup=skipped  smoke=passed(9)  rollbackTarget=d51c76b5ee6b
```

### How the tooling reached the host

Only the deployment tooling **dependency closure** was transferred — 13 files:
`tooling/`, `tooling/lib/`, and `infra/compose.deploy.yml`. **No Dockerfile, no
application source, no `packages/`.** The target is structurally incapable of
building the application, and `infra/compose.deploy.yml` contains zero `build:`
sections, which the deployment asserts before invoking Compose.

`git` and `pnpm` are **not installed** on the target for the deployment's
benefit, confirming the host tool requirements documented above.

### What this does NOT establish

- **Not staging readiness.** Account email does not work on that target
  (`MAIL_DRIVER=smtp` against a plaintext Mailpit sink while the driver requires
  implicit TLS — correct fail-closed behaviour, see
  [Staging mail model](#staging-mail-model)), and there is no observability
  there.
- **Not production readiness.** ORG-PR-002, ORG-PR-005, and ORG-PR-006 remain
  open; the target holds synthetic data only.
- **Not backup operations.** Two real pre-migration backups is a deployment
  boundary, not a backup programme. The target has **no PITR window**, and **no
  real-target restore or PITR drill was performed**.
- **Not email evidence.** The Mailpit sink has no external relay and reached no
  real recipient.

## Sprint 27 evidence — published-artifact local rehearsal (superseded)

Retained as supporting history. Before the real target existed, the lifecycle
was run on a workstation against the **actually published** GHCR artifacts,
under CPU emulation, over loopback, with no TLS, DNS, or durability. It found
the image/host platform gap that the real amd64 target later validated as fixed.
**It is subordinate to the real-target evidence above and must not be cited in
its place.**

## Sprint 27 changelog

- **Real durable-target validation (2026-08-27).** Two gate-authorised releases
  deployed by digest to a DigitalOcean staging-like host serving public HTTPS
  origins, a real application rollback, public HTTPS smoke 9/9 three times, and
  machine-generated evidence on the host. **ORG-PR-001 closed.** The
  operator-assisted boundary was preserved: GitHub Actions still does not reach
  the target, and no inbound exposure was created.

- **Image/host platform gate (stage 5).** `deploy_assert_image_runs_on_host` in
  `tooling/lib/deploy-common.sh`, called by `tooling/deploy.sh` immediately
  after the digest pull and before the backup preflight. Normalises both
  spellings of each architecture, refuses a mismatch with an actionable
  message, and accepts emulation only on an exact opt-in that is then recorded
  as a limitation on the deployment evidence. Ten unit tests exercise the real
  shell functions through bash rather than re-implementing the rule.
- **Target preflight (`tooling/deploy-target-preflight.sh`, `pnpm deploy:preflight`).**
  The repository had no way to qualify a candidate host. It now has one, and it
  is what turns "there is no target" into an executable definition of what a
  target must satisfy.
- **Package visibility: observed state corrected.** Sprint 26 recorded both GHCR
  packages as private. They are currently publicly pullable, proven by an
  unauthenticated pull. A deployment host therefore needs no registry credential
  today. This is a corrected *observation*, not an approved policy and not a
  decision made here — visibility remains an operator decision.
- **Rollback evidence upgraded** from locally built stand-ins to two real
  gate-authorised published releases.
- **Fail-open defect in the new gate, found in review and fixed.**
  `docker image inspect` and `docker info` exit 0 even when a template field
  renders empty, which produces the platform string `"/"`. If that happened on
  both sides, the equality check would have MATCHED and the gate would have
  passed by accident — a gate that fails open is worse than no gate.
  `deploy_require_determined_platform` now refuses an incompletely determined
  platform, in both getters and again at the decision point (the getters run
  inside a command substitution, so their refusal alone would surface as an
  empty value rather than as the assertion's own failure). Regression-tested.
- **The target preflight refuses a non-digest image reference** before pulling.
  The manifest schema already guarantees digest pinning, but that stage collects
  failures rather than exiting, so an invalid manifest could otherwise have led
  the preflight into resolving a mutable tag.
- **Staging mail boundary established — no code change needed.** The external
  prerequisite list previously said a staging-like target needs a real SMTP
  provider. It does not, and the claim was never accurate. Loading real
  configurations against the production config guard shows it constrains the
  mail *driver*, *credential*, and *sender domain* but **not the endpoint's
  identity**; the SMTP transport is created lazily so nothing connects at boot;
  and `/ready` probes only PostgreSQL and Redis. A target therefore runs
  `MAIL_DRIVER=smtp` against an operator-run isolated sink. One regression test
  pins the invariant. **No production email rule was weakened, and ORG-PR-002
  is untouched and still open.** See [Staging mail model](#staging-mail-model).
- **Host tool requirements corrected.** `git` was listed as a host prerequisite;
  no host-side script invokes it, and delivering the repository files is a free
  choice. `pnpm` is convenience only. See
  [Host tool requirements](#host-tool-requirements).
- **No new deployment mechanism.** Sprint 26's architecture, executor, manifest
  schema, evidence ledger, rollback rule, and smoke tooling are unchanged. The
  only executable additions are one gate inside the existing stage sequence and
  one new read-only script.

## Sprint 26 changelog

- **Target decision.** Single-host Docker Compose, operator-executed, promoted
  by digest — following the ratified self-hosted profile. Kubernetes, a managed
  container platform, and an SSH-from-CI deploy job were considered and rejected
  for the reasons recorded above.
- **Release identity split from deployment evidence.** The first design had one
  record covering both; it could not represent "built but not deployed" without
  null fields that read like facts. Splitting them removed every placeholder.
- **Migration head verification.** Initially the migration step only checked the
  container's exit code. Comparing Drizzle's ledger row count and newest
  `created_at` against the manifest turned "migrations ran" into "the database
  is at the release's head", with no SQL parsing and no new schema.
- **The web image's API origin was first made visible, then removed from the
  artifact entirely.** The rehearsal surfaced that a web image built for one
  environment would deploy silently into another. The first fix recorded the
  baked origin in the manifest and refused a mismatch — safe, but it meant one
  web digest could not be promoted between environments, which contradicted the
  build-once model. The refinement pass moved the value out of the build
  altogether (see [Runtime public configuration](#runtime-public-configuration)),
  deleted `images.web.apiBaseUrl` from the schema, and made the schema refuse any
  future attempt to put deployment configuration back into an image identity.
- **The rollback rule grew a "rolled away from" exclusion.** Selecting "the most
  recent other release whose smoke passed" would have restored the release the
  previous rollback was escaping, since a bad release usually passes smoke.
- **Two latent defects in Sprint 25 tooling were fixed**, both surfaced by the
  rehearsal: `tooling/db-backup.sh` could not back up a database with no
  migration ledger (PostgreSQL resolves relation names at parse time, so the
  `coalesce(...)` guard never had a chance to run), and `pg_start_server` failed
  under `set -u` on bash 3.2 when called with no extra Docker arguments. Both
  paths are on the first-deployment route, and neither had a caller before.
- **`--` tolerance.** `pnpm <script> -- --flag` forwards a bare `--`; the shell
  entry points now treat it as the end-of-options marker, matching the retention
  CLI's existing behavior. The documented
  `pnpm drill:restore -- --with-artifact` had been failing.
- **The `deploy` script name became `deploy:run`**, because `pnpm deploy` is a
  built-in pnpm command and shadowed the package script.

### Refinement pass (same day)

Three release-integrity defects found in review, all fixed without changing the
deployment architecture:

- **The web artifact is now truly promotable.** Public browser configuration
  moved from Vite build arguments to a runtime `/public-config.js` rendered by
  nginx from container variables. Manifest schema 2 drops
  `images.web.apiBaseUrl` and refuses any non-identity field on an image; the
  deployment applies and records the configuration instead; smoke verifies the
  served configuration AND that the environment's origin is absent from the
  bundle. Proven at three levels: unit tests over the resolver, the artifact
  smoke test running one image as two origins, and the rehearsal promoting one
  release between two configurations without a rebuild.
- **Rehearsal provenance can no longer be mistaken for a release.** Manifests
  now declare `release.type` and `source.provenance`; a dirty tree produces
  `working-tree` provenance with a content fingerprint and can never be
  `deployable`; a rehearsal never carries gate evidence; and a real environment
  refuses a non-deployable manifest. A printed warning was replaced by data the
  schema enforces.
- **Publication is authorised per-SHA.** A dedicated `gates` job resolves the
  actual workflow runs for the exact release commit, requires all six required
  checks to have concluded `success` at job granularity, and records their run
  IDs in the manifest — which the validator then binds to `source.commit`. The
  bounded-wait race behavior is documented above and never treats a missing run
  as success.
- **`eval` left the rollback path.** The ledger now exposes one named field per
  call, so no value from evidence can be interpreted as a command.
