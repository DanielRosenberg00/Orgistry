# Deployment and Promotion

Sprint 26 (ORG-PR-001). How a source commit becomes a running deployment: what
is built, how it is published, how a release is identified, how it reaches a
target, how it is validated once it is there, and how it is rolled back.

**Scope guard — read this before quoting anything below.** This document
describes a deployment *mechanism* that is implemented, rehearsed, and
**executed remotely**: both images are published to GitHub Container Registry
for the merged Sprint 26 commit, authorised by the required checks for that
exact SHA (see [Remote validation evidence](#remote-validation-evidence)).
Orgistry nonetheless has **no staging environment and no production
environment** — nothing here has ever been deployed to a real target, no host
runs Orgistry, and the `staging-like` GitHub Environment carries no reviewer
protection. Publishing and authorising an artifact is not deploying it. Finding
status: `ORG-PR-001` remains **open, materially advanced** in the
[findings register](production-readiness/findings-register.md).

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
| Exists today | yes | yes | yes | **no** | **no** |
| Defined by | `infra/docker-compose.yml` | `.github/workflows/*.yml` | `infra/compose.production-like.yml` | `infra/compose.deploy.yml` + `tooling/deploy.sh` | same as staging-like |
| Operator | developer | CI | developer or CI | operator | operator |
| Data classification | throwaway | throwaway | throwaway | synthetic only | real user data |
| Real user data allowed | no | no | no | **no** | yes |
| Secrets source | `.env` local defaults | fake checked-in/generated values | fake checked-in values | operator runtime env file (0600) or `<NAME>_FILE` mounts | same |
| Email behavior | Mailpit sink | none delivered | Mailpit stand-in, delivery not exercised | real provider required, unvalidated (ORG-PR-002) | same |
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

### Package visibility (operator action)

Packages published to GHCR from a public repository are **private by default**
until an owner changes the package's visibility, and a private package requires
`docker login` on the deployment host. Neither state is configured yet; both are
listed under [external configuration](#external-and-operator-only-configuration).

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
| `SMTP_*`, `MAIL_*` | mixed; `SMTP_PASSWORD` secret | A real provider is required and remains unvalidated (ORG-PR-002) |
| `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGINS`, `WEB_DEMO_URL`, `HSTS_MAX_AGE_SECONDS` | non-secret, environment-scoped | Set `TRUST_PROXY` to the real hop count/CIDRs behind the operator's proxy |
| `RATE_LIMIT_FAILURE_MODE`, `LOG_LEVEL`, `RETENTION_*` | non-secret, optional | Leave `RATE_LIMIT_FAILURE_MODE` unset in production (derives to `closed`) |
| API and web image digests | **deployment-generated** | From the release manifest only |
| `ORGISTRY_PUBLIC_API_BASE_URL` | **public browser configuration**, required | The API origin the browser will call. Applied to the web container at start; recorded in deployment evidence; verified by smoke |
| `ORGISTRY_PUBLIC_CSRF_HEADER_NAME`, `ORGISTRY_PUBLIC_MAILPIT_URL` | public browser configuration, optional | Defaults match the application's own; the CSRF name must match the API's `AUTH_CSRF_HEADER_NAME` |
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
| 5 | Backup / recovery-point preflight | the pre-deployment backup fails, or a skip has no recorded reason |
| 6 | Migrations, exactly once | the migration container exits non-zero |
| 7 | Verify the applied migration head | the database's applied migrations do not match the release's declared head |
| 8 | Deploy the API, wait for health | the API container never becomes healthy |
| 9 | Deploy the web artifact | the web container does not start |
| 10 | Wait for readiness | `/ready` does not return 200 |
| 11 | Verify the running container digests | a running container is not the released image |
| 12 | Post-deployment smoke | any smoke check fails |
| 13 | Record deployment evidence | — (evidence is written for failures too, from stage 6 onward) |

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
| 2 | Decide and set each package's visibility (private is the default) | **OPEN** — both packages remain private, which is the safe default | the package's settings page |
| 3 | If packages stay private, give the deployment host a read-only pull credential | **OPEN** — no host exists yet | `docker pull ghcr.io/danielrosenberg00/orgistry-api@sha256:…` on the host |
| 4 | Add required reviewers to the `staging-like` GitHub Environment | **OPEN** — the environment now exists (auto-created by the first `Deploy` run) but has **zero protection rules** | `gh api /repos/DanielRosenberg00/Orgistry/environments` |
| 5 | Restrict that environment's deployment branches to `main` | **OPEN** | same call |
| 6 | Decide whether `Deployment rehearsal` should be a required check (see below) | **OPEN** — deliberately not required | `gh api /repos/DanielRosenberg00/Orgistry/rulesets/19769611` |

Both packages are private by default and were verified by authenticated
registry inspection; nothing was made public to validate them. Until (4)
happens, `environment: staging-like` provides no protection beyond the workflow
being manual-dispatch-only — GitHub created the environment implicitly on the
first `Deploy` run, with zero protection rules, exactly as this table predicted.

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

- **No deployment target exists.** No staging host, no production host, no
  provider account, no deployment credential. Everything below follows from
  that.
- **Published images are single-architecture `linux/amd64`.** They are built on
  GitHub's amd64 runners and no multi-arch manifest list is produced, so an
  arm64 host cannot run them without emulation. This is adequate for the
  single-host x86-64 target this model assumes, and it is a real constraint on
  which host may be provisioned. Surfaced by inspecting the first real release.
- **Rollback is validated only in the rehearsal**, between two releases that
  differ by an image label, on one machine, with a throwaway database. Rollback
  in a long-lived environment with real traffic is untested.
- **The `Deploy` workflow verifies; it does not deploy.** It resolves and
  authorises a release and emits the operator plan. No target execution has
  occurred anywhere.
- **No GitHub Environment is configured**, so environment-scoped protection and
  required reviewers are documented rather than enforced.
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

### Remaining staging blockers

1. A host or provider account that can run the compose topology.
2. A managed or operated PostgreSQL and Redis for it.
3. A pull credential for the host, or public package visibility — the two
   packages now exist and are private (external action 2/3 above).
4. A real SMTP provider — the production config guard refuses to boot without
   one, and delivery through a real provider has still never been validated
   (ORG-PR-002).
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

**Promotion was proven against the published artifact, not only the rehearsal.**
The published web digest `sha256:20dc434b7b62…` was started twice with two
different `ORGISTRY_PUBLIC_API_BASE_URL` values; both containers report the same
image digest, each serves its own origin from `/public-config.js`, and neither
origin appears anywhere in the built assets.

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
