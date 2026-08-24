# Deployable Artifacts

Sprint 23 (ORG-PR-001). How Orgistry's production-shaped artifacts are built,
what they contain, how they run, and where the operator boundary sits.

Scope guard: this document describes **buildable, locally/CI-validated
artifacts and a validation runtime**. How those artifacts are published,
promoted, and deployed is a separate document — [deployment.md](deployment.md)
(Sprint 26). There is still no staging environment, no production deployment,
no image published to any registry, and no secrets manager — see
[known-limitations.md](known-limitations.md) and the findings register
(ORG-PR-001 remains open, materially advanced).

## Artifact strategy

| Artifact | Definition | Runtime |
| --- | --- | --- |
| API | `apps/api/Dockerfile` → image with `dist/server.mjs`, `dist/migrate.mjs`, `migrations/`, production `node_modules` | `node dist/server.mjs`, non-root (`node`, uid 1000) |
| Web | `apps/web-demo/Dockerfile` → image with the Vite production build | non-root nginx (`nginxinc/nginx-unprivileged`, uid 101, port 8080) |
| Worker | **None** — deliberate; see [Worker decision](#worker-decision) | — |

The workspace consumes `@orgistry/*` packages as TypeScript source (their
`exports` maps point at `./src/index.ts`), so nothing in the repository was
runnable by plain Node before this sprint. The API build
(`apps/api/scripts/build.mjs`, `pnpm build:api`) therefore bundles the two
EXISTING entry points with esbuild:

- `apps/api/src/server.ts` → `dist/server.mjs` — the same tested process
  entrypoint `pnpm start` uses; no second implementation path.
- `packages/db/scripts/migrate.ts` → `dist/migrate.mjs` — the same migration
  CLI behind `pnpm db:migrate`.

Workspace source is inlined into the bundles; **every npm dependency stays
external** and resolves at runtime from a production-only `node_modules`
installed from `pnpm-lock.yaml` (`pnpm deploy --prod` with a hoisted layout,
because the bundles import transitive workspace-package dependencies such as
`postgres` and `jose` directly). The runtime executes exactly the dependency
code the test suites exercised — bundling risk is confined to our own
TypeScript.

Rejected alternatives:

- **`tsx` in the runtime image** — ships a TypeScript transpiler and dev
  dependency tree to production; equivalent to running the web app on the Vite
  dev server.
- **`tsc` project-references build** — would require rewriting every package's
  `exports` (dual source/dist resolution) across the workspace for no runtime
  benefit.
- **Bundling node_modules into the artifact** — smaller image, but the runtime
  would execute esbuild-transformed dependency code that no test suite ever
  ran (pino/fastify/nodemailer dynamic-require risk).

## API artifact

Multi-stage build from the repository root context (`.dockerignore` keeps the
context small and secret-free; the smoke test independently verifies nothing
leaked):

1. **build stage** (`node:22.23.2-bookworm-slim`, digest-pinned): corepack
   activates the exact `packageManager` pnpm; `pnpm install --frozen-lockfile`;
   esbuild bundle; `pnpm --filter @orgistry/api deploy --prod --legacy
   --config.node-linker=hoisted` produces the flattened production
   `node_modules`, from which the unused `@orgistry/*` TypeScript sources are
   removed (the bundle already inlines them).
2. **runtime stage** (same base image): `/app` contains exactly
   `dist/ migrations/ node_modules/`, all root-owned and read-only to the
   runtime user. `USER node`, `EXPOSE 3000`, `NODE_ENV=production`,
   `NODE_OPTIONS=--enable-source-maps`, `CMD ["node", "dist/server.mjs"]`.

`dist/` holds three entrypoints, all bundled from existing source by
`apps/api/scripts/build.mjs` — there is no second implementation path:

| Entrypoint | Command | Purpose |
| --- | --- | --- |
| `dist/server.mjs` | the image `CMD` | The API process. |
| `dist/migrate.mjs` | `node dist/migrate.mjs` | Operator-run migrations (see [Migration policy](#migration-policy)). |
| `dist/retention.mjs` | `node dist/retention.mjs [--apply]` | Operator-run retention cleanup (Sprint 25 — [retention.md](retention.md)). |

Shipping the maintenance command in the API image is deliberate: an operator
runs it with the same image digest, the same runtime configuration, and the
same secret-injection seam as the service itself, so a maintenance job cannot
drift from the deployment it maintains.

Preserved behavior (validated from the packaged artifact by
`tooling/artifact-smoke.sh`): structured pino JSON logs with sanitized
`requestId`s, `/health` liveness, coarse production `/ready` (Sprint 19
disclosure policy) that fails closed on a Redis outage, bounded idempotent
SIGTERM/SIGINT shutdown (exit 0), and the production config guard
(`packages/config/src/production-policy.ts`) — the artifact refuses to boot
with development secrets.

The API needs **no writable filesystem paths**: logs go to stdout/stderr, and
no code path writes to the application tree (the smoke test proves `/app` is
not writable by the runtime user).

## Web artifact

Stage 1 runs the existing `vite build` in the workspace; stage 2 serves
`apps/web-demo/dist` with non-root nginx and an SPA history fallback
(`apps/web-demo/nginx.conf.template`, rendered to
`/etc/nginx/conf.d/default.conf` at container start). The runtime contains no
Node, no source, no workspace.

**Public configuration is applied at RUNTIME, and the image carries no
environment identity.** The web Dockerfile takes **no build arguments at all**
since the Sprint 26 refinement. The three public browser values — the API
origin, the CSRF header name, and the Mailpit UI — are served to the browser by
the running container:

- `apps/web-demo/nginx.conf.template` declares an exact-match
  `location = /public-config.js` that returns
  `window.__ORGISTRY_PUBLIC_CONFIG__ = {…}` built from `ORGISTRY_PUBLIC_*`
  container variables. The base image's own template step renders it at
  container start, with `NGINX_ENVSUBST_FILTER=^ORGISTRY_PUBLIC_` so nginx's own
  `$uri`/`$host` are untouched.
- `apps/web-demo/src/public-config.ts` resolves runtime → `import.meta.env.VITE_*`
  (development only) → built-in localhost defaults, and **refuses to start** if
  the runtime object carries a credential-shaped key.
- `apps/web-demo/public/public-config.js` is an empty assignment shipped in the
  bundle purely so the Vite dev server resolves the script tag; a deployed
  container never serves it.

This is what makes one validated web digest promotable between environments
instead of rebuildable per environment
([deployment.md](deployment.md#runtime-public-configuration)). Server-only
secrets must never be passed as build args to either Dockerfile, and never into
the public configuration; the smoke test asserts server secret values do not
appear in the static assets, that the runtime configuration reflects the
container's variables, and that the SAME image adopts a different API origin
without being rebuilt.

**Security-header boundary.** When web and API are served from separate
origins, the API's security headers (`apps/api/src/plugins/security-headers.ts`)
cover API responses only. The nginx config adds origin-neutral baseline
headers (`X-Content-Type-Options`, `Referrer-Policy`); TLS termination, HSTS
for the web origin, and any CSP for the demo UI belong to the fronting
reverse proxy a real deployment provides.

## Worker decision

No worker artifact exists because no worker runtime is required: every
side-effecting flow (account email, audit/security-event writes, rate-limit
accounting, API-key `last_used_at` throttling) executes synchronously inside
the API request path, and `infra/docker-compose.yml` + `docs/architecture.md`
have always documented "no worker/queue runtime" as a deliberate boundary.

Sprint 25 did not change this. The retention cleanup (ORG-PR-015) is a
**one-shot command** in the existing API image, not a worker: it connects,
sweeps, prints a summary, and exits. A worker or scheduler still becomes
necessary when something must INVOKE that command — and the backup command — on
a schedule (ORG-PR-016, open), or if queued email delivery/bounce handling
(ORG-PR-002) is adopted; that work defines its own runtime.

## Runtime process model

| Component | Kind | Notes |
| --- | --- | --- |
| API (`node dist/server.mjs`) | stateless process | all durable state in PostgreSQL; scale-out is not limited by process state |
| Web (nginx) | stateless static serving | rebuilt per config change |
| PostgreSQL | **operator-provided, stateful** | the only durable store; must persist outside application containers, and is the entire backup scope ([backup-and-restore.md](backup-and-restore.md)) |
| Redis | operator-provided | rate limiting + readiness; data is reconstructible (limiter windows), durability not required and deliberately not backed up |
| SMTP provider | operator-provided | production driver is implicit-TLS + SASL auth; external delivery still unvalidated (ORG-PR-002) |

Startup order (encoded in `infra/compose.production-like.yml`):
PostgreSQL reachable → **migrations run as an explicit one-shot step** → API
starts (readiness gates on PostgreSQL + Redis) → web serves. The API boots
even if Redis is down (`lazyConnect`) and reports the outage via `/ready`;
sensitive rate limiters fail closed in production.

Ports: API 3000 (only exposed port), web 8080. Both sit behind the operator's
TLS-terminating reverse proxy in any real deployment; set `TRUST_PROXY` to the
actual hop count/CIDRs there (default `false` = direct exposure).

## Migration policy

Migrations are **never run implicitly at API boot**. The deployable migration
entrypoint is the API image itself with a different command:

```sh
docker run --rm -e DATABASE_URL=... <api-image> node dist/migrate.mjs
```

- Requires only `DATABASE_URL` (`packages/db/src/env.ts` — migrations
  deliberately do not need the full application config) and a reachable
  PostgreSQL.
- Runs the full Drizzle baseline from `./migrations` (baked into the image
  next to `dist/`, where the migrator's `../migrations` resolution expects
  it); idempotent on an already-migrated database, complete from scratch on an
  empty one.
- Execution order: migrate to completion **before** starting the new API
  process. The compose reference encodes this
  (`depends_on: migrate: service_completed_successfully`).
- **Rollback limitation:** migrations are forward-only; no down migrations
  exist. Recovery from a bad migration is restore-from-backup or point-in-time
  recovery. Both now exist as tested tooling (Sprint 25 —
  [backup-and-restore.md](backup-and-restore.md), [pitr.md](pitr.md)), and the
  restore drill proves a restored database is compatible with this exact
  migration entrypoint. What does **not** exist is a scheduled backup in any
  deployment, so the artifact a real rollback would restore from has no
  producer yet (ORG-PR-005 stays open on that half). Schema drift between
  `src/schema` and `migrations/` is caught by `pnpm db:check` in CI, so the
  baked baseline matches the code in the same image.
- **Take a labelled backup immediately before a production migration:**
  `pnpm db:backup -- --label pre-migration`. The runbook for a failed migration
  is in
  [backup-and-restore.md](backup-and-restore.md#handle-a-failed-migration) and
  is explicitly labelled as unrehearsed guidance.
- A migration failure exits non-zero and must abort the deploy; the running
  old API is unaffected (it never observes a half-applied transaction —
  drizzle applies each migration transactionally). Sprint 26 makes that
  mandatory rather than advisory: `tooling/deploy.sh` runs this entrypoint
  exactly once per deployment, aborts before starting any application
  container if it fails, and then verifies the applied head against the release
  manifest ([deployment.md](deployment.md#migration-lifecycle)).

## Environment contract (deployable API artifact)

Only `DATABASE_URL` and `JWT_SECRET` are unconditionally required by the
schema (`packages/config/src/schema.ts`); everything else defaults. Under
`NODE_ENV=production` the config guard
([production-config-guard.md](production-config-guard.md)) additionally
requires production-safe values as noted. Classification:

| Variable | Class | Production notes |
| --- | --- | --- |
| `NODE_ENV` | required, non-secret | `production` (baked into the image; overridable but the artifact is production-shaped) |
| `API_HOST` / `API_PORT` | optional, non-secret | default `0.0.0.0` / `3000` |
| `LOG_LEVEL` | optional, non-secret | default `info` |
| `DATABASE_URL` | **required, secret** (embeds DB credentials) | operator-provided PostgreSQL |
| `REDIS_URL` | required in practice, secret if credentialed | defaults to localhost, which is wrong inside a container — set it |
| `JWT_SECRET` | **required, secret** | guard: ≥32 chars, no known dev values/placeholders (`openssl rand -hex 32`) |
| `JWT_PREVIOUS_SECRET` | optional, **secret** | set only during a rotation window; same guard as `JWT_SECRET`; must differ from it; remove to complete the cutover |
| `<NAME>_FILE` | optional, **non-secret path** | mounted-secret alternative for `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_PREVIOUS_SECRET`, `SMTP_USERNAME`, `SMTP_PASSWORD`; setting both forms of one variable is refused |
| `COOKIE_SECURE` | required in production, non-secret | must be `true`; guard-enforced |
| `WEB_DEMO_URL` | required in production, non-secret | https, non-localhost; embedded in emailed links; guard-enforced |
| `CORS_ORIGINS` | required in practice, non-secret | comma-separated browser origins |
| `TRUST_PROXY` | required behind a proxy, non-secret | hop count or CIDR list; `true` is rejected |
| `HSTS_MAX_AGE_SECONDS` | optional, non-secret | HSTS emitted only on proxied-https production responses |
| `MAIL_DRIVER` | required in production, non-secret | must be `smtp`; `mailpit`/`memory` are development/test-only and **production-forbidden** |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` | required with smtp driver, non-secret | implicit-TLS endpoint (default port 465) |
| `SMTP_PASSWORD` | required with smtp driver, **secret** | guard rejects placeholders/dev values |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | required in production, non-secret | deliverable address on a controlled domain; reserved domains rejected |
| `MAILPIT_*` | development-only | read only when `MAIL_DRIVER=mailpit` |
| `RATE_LIMIT_FAILURE_MODE` | optional, non-secret | leave unset in production (derives to `closed`); explicit `open` is rejected |
| `AUTH_*`, `RATE_LIMIT_*`, `*_TTL_SECONDS`, `API_KEY_LAST_USED_THROTTLE_SECONDS`, `MAIL_TIMEOUT_MS` | optional tuning, non-secret | defaults documented in `.env.example` |
| `RETENTION_*` | optional policy, non-secret | read ONLY by `dist/retention.mjs`; each has a hard floor, so a zero/negative value fails process start rather than widening a deletion predicate ([retention.md](retention.md)) |
| `TEST_DATABASE_URL` | test-only | never set in a deployable environment |
| `POSTGRES_USER/PASSWORD/DB` | development-only | consumed by the local compose files, not by the application |
| `VITE_*` | **public frontend configuration** | web **build args**, not API runtime env; compiled into the browser bundle |

`.env.example` remains the exhaustive local-development reference. The
container never reads a `.env` file: `.dockerignore` excludes them from the
build context, no workspace root exists inside the image (so
`loadWorkspaceEnv()` is a no-op), and the smoke test asserts none is present.

## Secret boundary

Enforced invariants (checked by `tooling/artifact-smoke.sh` where testable):

- real server secrets never enter Docker build arguments or image layers, and
  neither image's config declares a secret-bearing variable;
- `.env` files never enter the build context or artifacts;
- server secrets are read only at process start, from one of exactly two
  runtime sources: a direct environment value, or a mounted secret **file**
  (`<NAME>_FILE`, Sprint 24 — see below);
- frontend `VITE_*` values are public by definition; server secret values
  never appear in the static web assets;
- the fake smoke credentials never appear in API logs — for both the
  env-injected and the file-injected form;
- the production config guard rejects development/placeholder secrets at boot,
  **whichever source they came from** (the smoke test proves the packaged
  artifact still does this for a direct value and for a file-loaded value, and
  that neither rejection message echoes the secret).

### Mounted secret files (Sprint 24)

Six variables accept a `<NAME>_FILE` path instead of a direct value —
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_PREVIOUS_SECRET`,
`SMTP_USERNAME`, `SMTP_PASSWORD` — so a deployment can mount an orchestrator
secret rather than exporting it into the process environment:

```yaml
environment:
  JWT_SECRET_FILE: /run/secrets/jwt_secret
  SMTP_PASSWORD_FILE: /run/secrets/smtp_password
```

Setting both forms of one variable is refused at boot; the file is read once at
process start (there is no hot reload); one terminal newline is stripped; and
an empty, missing, or unreadable file fails validation with the path but never
the contents. Resolution happens *before* schema validation, so file-backed
values are held to exactly the same production rules. Contract:
[runtime-secrets.md](runtime-secrets.md).

Every credential in `infra/compose.production-like.yml` is a checked-in
obvious fake (`*-not-a-real-*`) using the direct-environment form; the smoke
test exercises the file form with temporary files it creates and deletes, so
no secret file is ever committed. **Where operators store secrets is still
unsolved** — there is no secrets-manager integration and no automated
rotation. Sprint 24 defined the injection sources and the manual rotation
procedures ([rotation-runbook.md](rotation-runbook.md)); ORG-PR-006 remains
open.

## Image policy (ORG-PR-042)

Every active image reference is pinned **exact patch tag + manifest-list
digest** (`name:X.Y.Z@sha256:…`): the two Dockerfiles' base images
(`node:22.23.2-bookworm-slim`, `nginxinc/nginx-unprivileged:1.31.4-alpine` —
Debian slim for the Node runtime because `@node-rs/argon2` ships glibc
binaries; unprivileged nginx for out-of-the-box non-root), both compose files
(`postgres:16.14-alpine`, `redis:7.4.10-alpine`, `axllent/mailpit:v1.30.5`),
and the CI service containers. No `latest`, no floating tags. Dependabot
covers Dockerfiles (`docker` ecosystem) and compose files (`docker-compose`);
workflow `services:` images are the one Dependabot-uncovered case and are
bumped manually with the same digests. Update procedure:
[validation.md](validation.md#image-pinning-policy).

## Production-like runtime reference and smoke test

`infra/compose.production-like.yml` is a **validation topology**, not a
deployment: it proves the built artifacts fit together (build → migrate →
boot → serve) under `NODE_ENV=production` with fake guard-passing
configuration. The deployment topology is a different file with different
rules — `infra/compose.deploy.yml` has no `build:` section at all and runs
published digests supplied by a release manifest ([deployment.md](deployment.md)). PostgreSQL/Redis run in containers here only for validation; a
real deployment provides managed stateful services, replaces Mailpit with a
real email provider, and injects real secrets at runtime.

`tooling/artifact-smoke.sh` (local: `pnpm artifact:smoke`; CI: the
`artifacts` job in `.github/workflows/ci.yml`) is the deterministic gate; its
header enumerates the checks, extended in Sprint 24 with the mounted-secret
file path (boot from `_FILE` secrets, rejection of an unsafe file-loaded
secret, rejection of an ambiguous env+file pair, a missing-file failure naming
the path, absence of file-loaded secrets from the logs, and no secret-bearing
variable in either image config). It needs **no real SMTP or provider
credentials** and creates its own temporary fake secret files.

What it deliberately does **not** validate: account-email delivery (the
implicit-TLS smtp driver cannot negotiate with plain Mailpit — consistent with
ORG-PR-002 remaining open), browser flows against the web artifact, and any
real-infrastructure concern (TLS, DNS, backups, monitoring).
