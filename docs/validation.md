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
| `pnpm db:backup` | durability (Docker) | Takes a `pg_dump -Fc` logical backup plus a SHA-256 checksum and a provenance sidecar. |
| **`pnpm drill:restore`** | **durability (Docker)** | **Backup → checksum verify → restore into a FRESH database → schema/migration/data assertions → migration no-op. Add `-- --with-artifact` to also drive the packaged API artifact (see [Data-durability validation](#data-durability-validation)).** |
| `pnpm drill:pitr` | durability (Docker + pnpm) | Point-in-time recovery: base backup + verified WAL archiving + recovery to a target time, proving pre-target state survives and post-target damage does not. |
| `pnpm backup:verify-store` | backup programme (host, network) | Writes, reads back, lists, and deletes a probe object — proves the configured bucket and credentials work before a scheduled job depends on them. |
| `pnpm backup:ship` | backup programme (host, Docker + network) | Takes the real logical backup, encrypts it client-side, stores it off-host, and records the recovery point. |
| `pnpm backup:catalog` | backup programme (host, network) | Prints the recovery-point inventory, derived from the store itself. |
| `pnpm backup:health` | backup programme (host, network) | Is the database protected right now? Exits non-zero when it is not. |
| `pnpm backup:wal-health` | backup programme (host, Docker + network) | Is continuous WAL archiving working end to end? Exits non-zero when it is not. |
| `pnpm backup:prune -- --dry-run` | backup programme (host, network) | Reports what the artifact lifecycle would delete. Deletes nothing. |
| `pnpm rehearse:restore -- --config PATH [--api-image REF]` | backup programme (host, Docker) | **Real-target logical restore rehearsal**: retrieve from the store → decrypt → verify digest → restore into an isolated database → schema, ledger, and data assertions → packaged migration no-op → packaged API readiness. |
| `pnpm rehearse:pitr -- --config PATH --source-container NAME` | backup programme (host, Docker) | **Real-target PITR rehearsal**: recovery to a chosen timestamp using WAL the deployed database produced and shipped, verified in both directions. |
| `pnpm db:retention -- --dry-run` | durability | Reports retention-eligible rows per category. Mutates nothing. |
| `pnpm db:retention -- --apply` | durability | Deletes retention-eligible rows in bounded batches. **Destructive** — take a backup first. |
| `pnpm release:manifest validate PATH` | deployment | A release manifest is well-formed, digest-pinned, tagged with its commit, and free of anything credential-shaped. |
| `pnpm deploy:preflight -- [--config PATH] [--manifest PATH] [--json]` | deployment (Docker) | Qualifies a candidate host BEFORE deploying to it: toolchain, host baseline and boot persistence, release pullability and image/host platform, and the configuration boundary. Read-only; deploys nothing. |
| `pnpm deploy:run -- --manifest PATH --config PATH` | deployment (Docker) | Deploys one release to one single-host environment and fails on any unmet stage (see [Deployment validation](#deployment-validation)). |
| `pnpm deploy:smoke -- --api-url URL --web-url URL` | deployment | Nine post-deployment checks against a running deployment, over HTTP only. |
| `pnpm deploy:rollback -- --config PATH [--dry-run]` | deployment (Docker) | Redeploys the previous known-good digests and re-runs smoke. |
| **`pnpm deploy:rehearsal`** | **deployment (Docker)** | **The whole lifecycle end to end against a throwaway registry and throwaway services: build once → publish → digest → manifest → deploy → migrate → smoke → evidence → second release → rollback.** |

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

The Sprint 26 refinement replaced the "public API base URL is baked into the
bundle" assertion with its opposite: the script now checks that the web
container SERVES its public configuration at `/public-config.js`, and then
starts a **second container from the same image** with a different
`ORGISTRY_PUBLIC_API_BASE_URL` to prove the served configuration follows while
the built assets contain no such origin. That is the artifact-level regression
test for promotion-by-digest
([deployment.md](deployment.md#runtime-public-configuration)).

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

## Data-durability validation

Sprint 25 (ORG-PR-005, ORG-PR-015). Three drills, all self-contained: they
create their own throwaway PostgreSQL containers from the pinned image, so they
never touch a developer's database or the CI service containers, and they
destroy every container, volume, network, and backup file on exit.

**`pnpm drill:restore`** — `tooling/db-restore-drill.sh`. Migrates a throwaway
source, seeds deterministic Orgistry data, takes a backup with the REAL
`tooling/db-backup.sh`, verifies the artifact's checksum, asserts the target is
empty before restoring, proves that BOTH a truncated copy and a MISSING path
are rejected by `pg_restore` without leaving a partially restored target,
restores with `--exit-on-error`, then asserts every table, the Drizzle
migration ledger, each seeded entity, an owner→organization→plan→project join,
and byte-identical API-key hash metadata. Finally it re-runs migrations against
the restored database and requires the ledger to be unchanged.

**`pnpm drill:restore -- --with-artifact`** — additionally boots
`orgistry-api:production-like` against the restored database (build it first
with `pnpm artifact:build`), checks `/health` and `/ready`, reads the restored
projects back through the API-key-authenticated
`GET /v1/external/projects`, asserts an unknown key still returns 401 and no
drill secret reaches the logs, and runs the packaged retention command in both
modes. In this mode migrations run through the artifact's own
`dist/migrate.mjs`, so no workspace install is needed.

**`pnpm drill:pitr`** — `tooling/db-pitr-drill.sh`. Twelve checks from
`wal_level`/`archive_mode` through verified WAL archival, `pg_basebackup`,
pre-target writes that exist only in archived WAL, a recorded recovery target,
destructive post-target writes, recovery in an independent server, proof that
archived WAL was actually consumed, and the target boundary in both directions.
Requires a workspace install (it applies the real migration baseline). Full
detail and recorded evidence: [pitr.md](pitr.md).

Retention behavior itself is covered by
`apps/api/src/maintenance/retention.integration.test.ts`, which runs as part of
`pnpm validate:integration`. See [retention.md](retention.md).

### Backup programme validation (Sprint 28)

Two classes of check, deliberately kept apart. **Repository tests are not proof
that an external target is protected.**

**Offline, in `pnpm validate`.** The parts of the backup programme whose
correctness does not need a network, a bucket, or a database:

| Suite | What it pins |
| --- | --- |
| `tooling/backup-crypto.test.ts` | round-trip fidelity, owner-only file mode, no plaintext left recognisable in the artifact, and loud failure on a wrong key, a truncated artifact, a flipped ciphertext bit, and a same-length header forgery |
| `tooling/object-store.test.ts` | AWS SigV4 signatures reproduced against the **two published AWS examples**, RFC 3986 encoding, listing pagination, path- and virtual-host addressing, header (never presigned-URL) authentication, that no secret appears in a request, and the transport-retry contract: a connect failure is retried with a rebuilt body, exhaustion is bounded, and an HTTP 403 is **never** retried |
| `tooling/backup-config.test.ts` | the configuration file is parsed and never sourced, secret files must be mode 0600 and non-empty, every required key is named when missing, and `describeConfiguration` contains no secret |
| `tooling/backup-catalog.test.ts` | recovery-point shape, orphaned-metadata detection, WAL window derivation, and a rendering that truncates digests and leaks nothing |
| `tooling/backup-health.test.ts` | every way a backup programme dies quietly: nothing stored, a stale backup, an unencrypted artifact, a half-finished upload, a recorded failed run, archive_mode off, a currently-failing `archive_command`, and a spool that is filling because shipping is broken — plus the inverse, that an **idle** database is not reported unhealthy for an ageing archive |

The AWS vectors matter more than a self-consistent golden file: a signing bug
surfaces at a provider as an opaque HTTP 403 with no indication of which
canonicalisation rule was broken, so the check has to come from outside this
repository.

**Operational, on the deployment host.** These cannot run in CI — they need the
real database, the real archive, and real DigitalOcean Spaces credentials — and
their results are recorded as operator evidence, never as repository test
results. `verify-store` is the **first** thing to run after any credential
change: a truncated secret surfaces only as `SignatureDoesNotMatch` at the first
upload, and this catches it in one second.

```bash
pnpm backup:verify-store        # the store accepts write/read/list/delete
pnpm backup:ship                # a real backup reaches the store, encrypted
pnpm backup:catalog             # the recovery point is visible
pnpm backup:health              # the database is protected
pnpm backup:wal-health          # continuous archiving is working
pnpm backup:prune -- --dry-run  # the lifecycle would do what is intended
pnpm rehearse:restore -- ...    # a stored backup really restores
pnpm rehearse:pitr -- ...       # a chosen timestamp is really recoverable
```

Both rehearsals write a secret-free JSON evidence record and destroy every
container, volume, and decrypted artifact they create. See
[backup-and-restore.md](backup-and-restore.md) and [pitr.md](pitr.md).

Requirements: Docker; `curl` for `--with-artifact`; `pnpm` for the non-artifact
restore mode and for the PITR drill. No real secrets and no real database are
involved.

### Loopback test fixtures: dial the address you bound

A second Linux-only failure (PR #33, CI run 32657860558) came from the same
class of defect in a unit test: a fixture bound a listener on `127.0.0.1` but
the client connected to `localhost`, which resolves to `::1` first on a
dual-stack Linux host. The connection was refused instead of reaching the
listener, turning a timeout test into a connection-refused test.

**Convention:** when a test starts a loopback listener, connect to the address
`server.address()` reports, not to `localhost`. The exception is TLS fixtures —
`mail/testing/tls-fixtures.ts` certifies `localhost`, so tests that must pass
certificate hostname verification keep using that name and rely on the listener
being reachable over IPv4. Both traps are invisible on macOS.

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
   across `apps/*/Dockerfile`, `infra/*.yml`, `.github/workflows/ci.yml`, and
   `tooling/` — `tooling/lib/pg-tools.sh` pins PostgreSQL for the durability
   drills and `tooling/deploy-rehearsal.sh` pins the throwaway registry and
   Redis).
4. Run `pnpm artifact:smoke` (and `pnpm infra:up` if the dev stack images
   changed) to prove the pinned images still work.

`infra/compose.deploy.yml` is the one file with no pinned image literals, by
design: the images it runs are Orgistry's own release images, and their digests
come from the release manifest at deployment time.

## Deployment validation

Sprint 26 (ORG-PR-001). Two tiers, matching how much infrastructure each needs.

**Deterministic, no infrastructure — runs inside `pnpm validate`.**
`tooling/release-manifest.test.ts` and `tooling/deploy-evidence.test.ts` are
part of `pnpm test`, so every pull request already proves the release-manifest
and deployment-evidence contracts: image references are digest-pinned and never
tag-pinned, the image tag is the source commit, the migration head is derived
from the repository journal rather than supplied, the web image declares the API
origin it was built against, a record cannot claim a validated deployment
without observed runtime digests, an unexplained backup or migration skip is
refused, nothing credential-shaped can be written into either record, and the
rollback target is the most recent smoke-passing release that is neither
currently deployed nor already rolled away from.

**`pnpm deploy:rehearsal`** — `tooling/deploy-rehearsal.sh`. The full lifecycle
on one machine: it starts a throwaway OCI registry plus throwaway PostgreSQL and
Redis, builds both images, pushes them, captures their registry digests,
generates and validates a release manifest, deploys by digest through the real
`tooling/deploy.sh` (backup preflight → one-shot migration → verified migration
head → API → web → readiness → smoke → evidence), asserts the RUNNING container
image IDs are the manifest's digests, publishes a second release, deploys it
over the first, rolls back with `tooling/deploy-rollback.sh`, and asserts the
rollback restored the first release's exact digests and ran no migrations. It
also **promotes** the first release between the two: the same manifest is
redeployed with a different public API origin, and the running digests are
asserted unchanged while the served browser configuration follows — the
end-to-end proof that promotion needs no rebuild. It proves four refusals: a
tag-pinned manifest; a rehearsal release offered to a `deployment`-class
environment; a rehearsal manifest relabelled as published; and a runtime
configuration file that is not mode 0600.

The two rehearsal releases differ only by an image label, so they have distinct
digests from identical source — the rollback check is about digest switching,
not application behavior. Both are pushed under the same tag, which is why a tag
is never the identity.

Requirements: Docker with compose v2, `node`, `curl`, and free host ports 5001,
3100, 8180. No workspace install, no real secrets, no real registry, no
deployment target. Everything it creates — including the temporary runtime
configuration file holding its fake credentials — is destroyed on exit.

**It is not staging, and its output is not a release.** It proves the deployment
MECHANICS work. Every manifest it produces is `release.type: rehearsal`,
`deployable: false`, carries no gate evidence, and — when the working tree is
dirty — records `provenance: working-tree` with a fingerprint of that tree
rather than an unqualified commit SHA. A rehearsal result must never be cited as
evidence about a commit, and a real environment refuses to deploy one. It is not
evidence that Orgistry has an environment, that anything has been published to
GHCR, or that the project is ready for staging or production. See
[deployment.md](deployment.md).

Run it before merging any change to `tooling/deploy*.sh`,
`tooling/lib/deploy-common.sh`, `tooling/release-manifest.mjs`,
`tooling/release-gates.mjs`, `tooling/deploy-evidence.mjs`,
`infra/compose.deploy.yml`, `apps/web-demo/nginx.conf.template`, or either
Dockerfile.

**What the rehearsal structurally cannot prove (Sprint 27).** It builds its
images locally, so they are always native to the machine running it. A published
image's architecture can therefore never mismatch inside a rehearsal — which is
exactly how the deployment shipped for a sprint with no image/host platform
check, and why the arm64 failure mode was found only by pulling the real
published release onto an arm64 host. It also uses a throwaway registry, so it
proves nothing about GHCR authentication, package visibility, or retention.
Treat "the rehearsal passes" as evidence about the *mechanics*, and go looking
for the classes of defect its construction excludes.

#### Sprint 27 outcome (2026-08-27)

The Sprint 27 changes — `tooling/deploy.sh`, `tooling/lib/deploy-common.sh`,
`tooling/deploy-smoke.sh`, the new `tooling/deploy-target-preflight.sh` and
`tooling/deploy-platform-guard.test.ts`, `packages/config/src/config.test.ts`,
`package.json`, and documentation — were published as **PR #40**
(head `0b6e6967bb95…`) and passed every mandatory remote gate:

| Workflow | Result |
| --- | --- |
| CI — `Validate (offline)`, `Integration (PostgreSQL + Redis)`, `Artifacts (build + smoke)` | **PASS** |
| Security scans — `Dependency audit (pnpm)`, `Secret scan (Gitleaks)` | **PASS** |
| CodeQL — `Analyze (javascript-typescript)` | **PASS** |
| **Deployment rehearsal** — run `33065548416`, manually dispatched at the published head | **PASS** |

**Data durability** was correctly not required — its owned surface is untouched.
**Release** was not required: `release.yml` is unchanged and no new application
release was published. **Deploy** needed no new run — it is unchanged, and run
`33061763360` provided the operational validation against the real target.

`ORG-PR-001` is **CLOSED** on real-target evidence and **Sprint 27 DoD met:
YES**. Sprint 27 is complete. Staging readiness remains NO and production readiness remains NO — see
[sprint-27-artifact-package.md](production-readiness/sprint-27-artifact-package.md).

### `pnpm deploy:preflight` — qualify a host

`tooling/deploy-target-preflight.sh`. New in Sprint 27. Run it on a candidate
deployment host before the first deployment, and after any change to that host:

```sh
pnpm deploy:preflight -- --config /etc/orgistry/deploy.env \
                        --manifest release-manifest.json --json
```

All arguments are optional — a host being evaluated has no configuration and no
chosen release yet. It checks the deployment toolchain, the host baseline
(platform, Docker/Compose versions, CPU/memory/storage, and whether Docker
starts at boot, which is what makes a target durable rather than merely
running), that both release images actually pull *from that host* and match its
platform, and the configuration boundary (environment class, runtime-file
permissions, loopback port binds, HTTPS public origin, evidence and backup
directory permissions).

It collects every failure rather than stopping at the first, exits non-zero if
any check FAILED, and prints a sanitized baseline with `--json`. It stats the
runtime configuration file but never reads it, so it cannot print a secret.

**What it does not check: mail.** SMTP is neither a boot dependency nor a
readiness probe, so the preflight has nothing to probe. A staging-like target
runs `MAIL_DRIVER=smtp` against an operator-run isolated sink and needs no
production email provider — see
[deployment.md](deployment.md#staging-mail-model). The rules that *are*
enforced (driver, credential shape, sender domain) live in the API's own
production config guard and are covered by `pnpm test`.

**Read-only contract.** It may inspect versions, file modes, and directory
writability; pull and inspect immutable digest-pinned images; compare
architectures; and structurally validate non-secret configuration. It must never
run a migration, touch the application database, start or reconfigure the
deployment, change firewall or host configuration, persist a secret, or mutate
GitHub settings or package visibility. **A passing preflight is not a
deployment** — it starts no container, runs no migration, and writes nothing to
the evidence ledger.

### Forwarding flags through pnpm

`pnpm run <script> -- --flag` forwards a **bare `--`** to the script under
pnpm 10. Every shell entry point in `tooling/` now treats it as the conventional
end-of-options marker (matching the retention CLI, which already did), so the
documented `pnpm drill:restore -- --with-artifact` form works. Note also that
`pnpm deploy` is a **built-in pnpm command**; the deployment script is therefore
`pnpm deploy:run`.

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

Seven workflows exist on GitHub-hosted CI (Sprint 21 hardening: every action is
pinned to a full commit SHA and every workflow declares explicit least-privilege
permissions — see [CI security policy](#ci-security-policy)). Four run
automatically on the pull-request path; three are manual or scheduled.

`.github/workflows/ci.yml` mirrors this matrix as three jobs:

- **Validate (offline)** — install (frozen lockfile), typecheck, lint, unit
  tests, web tests, web build, schema drift check, whitespace check.
  Equivalent to `pnpm validate`.
- **Integration (PostgreSQL + Redis)** — spins up `postgres:16.14-alpine` and
  `redis:7.4.10-alpine` service containers (tag+digest pinned, matching
  `infra/docker-compose.yml`), creates the test database, applies the
  migration baseline, runs `pnpm validate:integration`, and then runs the
  data-layer backup/restore drill (`./tooling/db-restore-drill.sh`).
- **Artifacts (build + smoke)** — runs `tooling/artifact-smoke.sh`: builds the
  production API and web images and validates them against the
  production-like compose reference (see
  [Artifact validation](#artifact-validation)), then runs
  `./tooling/db-restore-drill.sh --with-artifact` against the image it just
  built. Needs no production secrets; publishes and pushes nothing.

Mailpit is intentionally omitted from CI (see above).

`.github/workflows/data-durability.yml` (manual + weekly) runs the PITR drill.
It has been executed against `main` and passed
([run 32702918307](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702918307),
42 s).
It is deliberately outside the pull-request path: the drill starts two
PostgreSQL servers and waits on archive recovery, and it validates the recovery
STRATEGY, which changes only when the tooling, the pinned PostgreSQL image, or
the migration baseline changes. Run it on demand before merging any such
change. Rationale in full: [pitr.md](pitr.md).

**Operator follow-up (not repository-controlled):** the Sprint 25 steps run
inside the existing `integration` and `artifacts` jobs, so they are covered by
whatever required-check configuration those jobs already have. The new
`Data durability` workflow is intentionally NOT a required check — it is
manual/scheduled. If a maintainer later wants it enforced, that is a GitHub
branch-protection change made in repository settings; nothing here mutates
remote configuration.

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

`.github/workflows/deployment-rehearsal.yml` (manual + weekly, Mondays 05:10
UTC) runs the deployment rehearsal (see
[Deployment validation](#deployment-validation)). Like the PITR drill it is
deliberately outside the pull-request path — it builds two image sets and
performs three deployments, and it validates a deployment STRATEGY that changes
only when the deployment tooling, the compose topology, or the Dockerfiles
change. It has been executed on GitHub Actions against merged `main`
(`91664d0`): run
[32777259951](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32777259951),
**success**, 65 assertions.

`.github/workflows/release.yml` (push to `main`, manual dispatch) is the only
workflow that publishes anything (Sprint 26, ORG-PR-001), and it publishes only
what the required checks have already authorised. Its first job resolves the
actual workflow runs for the **exact release commit** and requires all six
required checks — `Validate (offline)`, `Integration (PostgreSQL + Redis)`,
`Artifacts (build + smoke)`, `Dependency audit (pnpm)`,
`Secret scan (Gitleaks)`, `Analyze (javascript-typescript)` — to have concluded
`success` at JOB granularity, recording their run IDs. Because it is triggered
by the same push that starts those checks, it waits with a bounded timeout: a
failure fails the release immediately, a missing run is pending and never
counted as success, and a timeout fails with the pending list so an operator can
re-dispatch. Its second job then runs the artifact gate itself, publishes the
images that gate produced to GitHub Container Registry under an immutable
commit-SHA tag, captures their digests, and uploads a release manifest carrying
the gate run IDs. It never runs on pull requests, so untrusted fork code has no
path to publishing; `actions: read` is scoped to the gate job and
`packages: write` to the publish job, so neither can do the other's work; and
its credential is the job's own short-lived `GITHUB_TOKEN`, passed on stdin. No
production runtime secret is involved, and image builds take no secrets — and,
since the refinement, no build arguments at all.
It has been executed: run
[32776576782](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32776576782)
published `ghcr.io/danielrosenberg00/orgistry-api` and `…/orgistry-web` for
commit `91664d0`, after its gate job proved all six required checks succeeded
for that exact SHA (CI `32776576684`, Security `32776576586`, CodeQL
`32776576905`). Both packages are **private**; they were verified by
authenticated registry inspection.

`.github/workflows/deploy.yml` (manual dispatch only) authorises and verifies a
deployment: it binds to a GitHub Environment, downloads a release run's
manifest, validates it, refuses a release that is not deployable, re-states the
gate runs that authorised it, proves both digests still resolve in the registry,
and emits the deployment plan and operator commands. It is read-only everywhere and does **not** contact a
deployment target — none is reachable from CI, and target execution is the
operator-run `tooling/deploy.sh` ([deployment.md](deployment.md)).
It has been executed: run
[32777270537](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32777270537)
against environment `staging-like`, **success**. The environment now exists
(GitHub created it on first use) but has **zero protection rules** — adding
required reviewers remains an operator action.

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

**Sprint 26 changes none of this.** The three new workflows are deliberately not
required checks: `Release` runs only on pushes to `main` and manual dispatch,
`Deploy` is manual and target-dependent (a deployment must never be a universal
pull-request gate), and `Deployment rehearsal` is manual/weekly on the same
reasoning as `Data durability`. The deterministic half of the new deployment
tooling — the release-manifest and evidence contracts — is already enforced on
every pull request, because its unit tests run inside `pnpm test` and therefore
inside the required `Validate (offline)` check. Whether to add
`Deployment rehearsal` as a required check is a repository-settings decision for
a maintainer; nothing here mutates remote configuration.

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
- **No workflow on the pull-request path publishes, deploys, or writes
  repository contents.** Publishing is confined to `release.yml`, which runs
  only on pushes to `main` and manual dispatch, holds `packages: write` on its
  publish job alone, and uses the job's own short-lived `GITHUB_TOKEN`. The
  deployment workflow is read-only everywhere. Dependency-update PRs
  (Dependabot) require human review; auto-merge is not configured and must not
  be enabled.
- **Routine CI never consumes a real credential.** No workflow reads a
  production runtime secret, an email-provider credential, or a
  secrets-manager credential; the repository has no configured Actions
  environments and no repository secrets. `deploy.yml` declares an
  `environment:`, which is where a future deployment credential belongs — until
  a maintainer creates that environment in repository settings, it grants no
  protection beyond the workflow being manual-dispatch-only. The three jobs run on fake,
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
