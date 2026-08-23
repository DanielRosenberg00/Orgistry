# Sprint 23 Artifact Package — Deployable Artifact and Pipeline

> **STATUS: PROVISIONAL — pending remote validation evidence.** Local
> implementation and local validation are complete; the Sprint 23 Definition
> of Done additionally requires the remote workflows (CI — including the new
> `Artifacts (build + smoke)` job — Security scans, CodeQL) to pass on the
> pushed changes, and the artifact check to be registered as a required check
> in the `main` ruleset. This document becomes the final closing artifact
> only after that remote evidence is recorded here. Until then, Sprint 23 is
> **not closed**.

- **Execution date:** 2026-08-23 (local implementation & validation)
- **Scope:** production-shaped deployable artifacts for the currently required
  runtime — API container, web container, explicit migration entrypoint,
  production-like validation runtime, deterministic smoke gate, CI enforcement,
  image pinning policy, and the runtime/operator contract. Roadmap finding
  targets: ORG-PR-001 (advance), ORG-PR-042 (close), ORG-PR-006 (advance
  boundary only).
- **Explicitly out of scope (not performed):** real cloud/staging/production
  deployment, IaC, DNS/TLS/CDN/WAF, registry publishing, release automation,
  signing/provenance, secrets-manager integration, secret/JWT rotation,
  backup/PITR/restore, production SMTP validation, monitoring/alerting,
  retention cleanup, worker infrastructure, product/auth/API changes.

## 1. Implementation Summary

Before this sprint, nothing in the repository was runnable outside the pnpm
workspace: the API ran via `tsx src/server.ts`, and every `@orgistry/*`
package exports raw TypeScript source. Sprint 23 added:

| Component | File(s) |
| --- | --- |
| API production build (esbuild bundle of existing entrypoints) | `apps/api/scripts/build.mjs`, `apps/api/package.json` (`build` script, `esbuild` devDep) |
| API production image (multi-stage, non-root) | `apps/api/Dockerfile` |
| Web production image (Vite build on non-root nginx, SPA fallback) | `apps/web-demo/Dockerfile`, `apps/web-demo/nginx.conf` |
| Build-context boundary | `.dockerignore` (repo root) |
| Production-like validation runtime | `infra/compose.production-like.yml` |
| Deterministic artifact smoke gate | `tooling/artifact-smoke.sh`, root scripts `build:api` / `artifact:build` / `artifact:smoke` |
| CI enforcement | `.github/workflows/ci.yml` — new `artifacts` job |
| Image policy application (tag+digest everywhere) | both Dockerfiles, both `infra/*.yml`, `ci.yml` service containers, `.github/dependabot.yml` (docker ecosystem) |
| Runtime/operator contract | `docs/deployment-artifacts.md` (new, authoritative) + synchronized existing docs (§15) |

Validation-unblocking maintenance discovered during Sprint 23 (not sprint
scope): four transitive-dependency advisories published since Sprint 22
(`fast-uri`, `js-yaml`, `nanoid`, `brace-expansion` GHSA-rgw5-rvv9-x895)
failed the mandatory Sprint 21/22 scanner gates during the validation loop;
all four were updated in-range in `pnpm-lock.yaml` (the Sprint 21 precedent —
`fast-uri` is a fastify transitive that ships inside the API artifact). The one previously accepted advisory
(GHSA-mh99-v99m-4gvg) remains the only acceptance.

## 2. Deployable Artifact Strategy

Documented in full in
[../deployment-artifacts.md](../deployment-artifacts.md). Summary: esbuild
bundles the two EXISTING entrypoints (`apps/api/src/server.ts`,
`packages/db/scripts/migrate.ts`) with workspace source inlined and **all npm
dependencies external**, resolved at runtime from a lockfile-exact,
hoisted, production-only `node_modules` (`pnpm deploy --prod --legacy
--config.node-linker=hoisted`). The runtime executes the same dependency code
the test suites exercised. Rejected: shipping `tsx` (dev transpiler in
production), workspace-wide `tsc` builds (exports rewrite for no runtime
benefit), full bundling of node_modules (untested transformed dependency
code). The web artifact is the unchanged `vite build` output on static
non-root nginx.

## 3. API Artifact Summary

`orgistry-api` image (395 MB, `node:22.23.2-bookworm-slim` base): `/app`
contains exactly `dist/` (`server.mjs`, `migrate.mjs`, sourcemaps),
`migrations/` (Drizzle SQL baseline), and `node_modules/` — root-owned,
read-only to the runtime user. `USER node` (uid 1000), `EXPOSE 3000`,
`NODE_ENV=production`, `NODE_OPTIONS=--enable-source-maps`,
`CMD ["node", "dist/server.mjs"]`. No TypeScript source (outside registry
`.d.ts` files in node_modules), no `.env`, no git metadata, no pnpm/tsx, no
dev dependencies — all smoke-asserted. Health/readiness, coarse production
`/ready` disclosure, structured logging with sanitized request IDs, bounded
idempotent shutdown, and the production config guard are all preserved and
re-proven from the packaged artifact.

## 4. Web Artifact Summary

`orgistry-web` image (83 MB, `nginxinc/nginx-unprivileged:1.31.4-alpine`
base): the Vite production build under `/usr/share/nginx/html` plus
`nginx.conf` (SPA history fallback, immutable caching for hashed `/assets/`,
no-cache `index.html`, baseline `X-Content-Type-Options`/`Referrer-Policy`).
Runs as uid 101 on port 8080. `VITE_API_BASE_URL` /
`VITE_CSRF_HEADER_NAME` / `VITE_MAILPIT_URL` are build args — public frontend
configuration compiled into the bundle, explicitly non-secret; the smoke test
proves server secret values are absent from the static assets and that the
configured API base URL is represented in the built bundle. TLS and the web
origin's full security-header policy belong to the operator's fronting proxy
(documented boundary).

## 5. Worker Runtime Decision

**No worker artifact.** No current runtime behavior requires one: mail
delivery, audit/security-event writes, rate-limit accounting, and API-key
`last_used_at` throttling all run synchronously in the API request path;
"no worker/queue runtime" is a long-documented deliberate boundary
(`infra/docker-compose.yml`, `docs/known-limitations.md`). A worker becomes
necessary when the roadmap's backups/DR & background-jobs work implements
scheduled retention/expiry jobs (ORG-PR-015/016) or when queued email
delivery (ORG-PR-002) is adopted; that work defines its own runtime.

## 6. Runtime Process Model

Stateless API process + stateless static web serving; PostgreSQL is the only
durable store and, with Redis and the SMTP provider, is operator-provided
infrastructure. Startup order: PostgreSQL reachable → one-shot migration →
API (readiness gates on PostgreSQL + Redis; boots through a Redis outage and
reports it) → web. Ports 3000 (API) and 8080 (web) behind an
operator-provided TLS-terminating reverse proxy (`TRUST_PROXY` configures the
hop trust). Full model: [../deployment-artifacts.md](../deployment-artifacts.md).

## 7. Migration Policy

Migrations are never run at API boot. The deployable entrypoint is the API
image with `node dist/migrate.mjs` (same image, different command),
requiring only `DATABASE_URL`; idempotent; run to completion before the new
API starts (`depends_on: service_completed_successfully` in the reference,
validated by the smoke gate: migrate exits 0 before the API becomes healthy).
Forward-only — rollback is restore-from-backup, which does not exist yet
(ORG-PR-005); schema drift between code and baked baseline is prevented by
`pnpm db:check` in the same CI run.

## 8. Environment Contract Summary

The full classified inventory (required/optional/dev-only/test-only/
production-forbidden/secret/non-secret/public-frontend) is in
[../deployment-artifacts.md](../deployment-artifacts.md#environment-contract-deployable-api-artifact).
Hard-required: `DATABASE_URL`, `JWT_SECRET`. Production-guard-required:
`COOKIE_SECURE=true`, `MAIL_DRIVER=smtp` + SMTP credentials, deliverable
`MAIL_FROM_EMAIL`, https non-localhost `WEB_DEMO_URL`, no
`RATE_LIMIT_FAILURE_MODE=open`. Production-forbidden: `mailpit`/`memory`
mail drivers. `VITE_*` values are public web build args, not API runtime env.
No fictional variables were documented; `.env.example` and
`packages/config/src/schema.ts` remain the exhaustive references. No guard
was weakened.

## 9. Runtime Secret Boundary

Enforced and smoke-tested: no secrets at build time (no secret build args; no
secret-bearing layers), `.env` excluded from build context and proven absent
from images, secrets read only from the runtime environment, fake smoke
secrets proven absent from API logs and web assets, guard rejection of a
known dev secret proven from the packaged artifact (and the rejection message
proven not to echo the value). All credentials in the compose reference are
checked-in obvious fakes (`*-not-a-real-*`); Gitleaks passes over them. This
is the injection boundary a future secrets manager plugs into — **it is not
secrets management** (§17).

## 10. Non-Root / Filesystem Posture

Proven by execution, not assumed: API `id -u` → `uid=1000(node)`; web →
`uid=101(nginx)`. No elevated startup privileges; `/app` is root-owned and
the smoke test proves the runtime user cannot write to it (`touch
/app/dist/…` fails); the API needs no writable paths (stdout/stderr logging).
No `chmod` shortcuts anywhere. No exceptions required.

## 11. Image Policy

Selected policy: **exact patch tag + manifest-list digest** on every active
reference. Applied to: `node:22.23.2-bookworm-slim@sha256:d649c2…` (both
Dockerfile build/runtime stages; Debian slim because `@node-rs/argon2` ships
glibc binaries), `nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:c3fed6…`,
and `postgres:16.14-alpine` / `redis:7.4.10-alpine` / `axllent/mailpit:v1.30.5`
(with digests) in `infra/docker-compose.yml`, `infra/compose.production-like.yml`,
and the `ci.yml` service containers. No `latest`, no floating tags anywhere.
Dependabot: existing `docker-compose` ecosystem covers `infra/`; a new
`docker` ecosystem entry covers `apps/api` + `apps/web-demo`. Documented
exception: workflow `services:` images are outside Dependabot's ecosystems
and carry a manual bump procedure
([../validation.md](../validation.md#image-pinning-policy)).

## 12. CI Build Gate

`ci.yml` gained the `artifacts` job (PRs + `main` pushes, same SHA-pinned
checkout, workflow-level `contents: read` unchanged): it runs
`tooling/artifact-smoke.sh`, which builds both images with
`--frozen-lockfile` installs inside the build stages and runs the full smoke
suite. It needs no production secrets, publishes nothing, and pushes no
images; a build or smoke failure fails the job. The existing `validate`,
`integration`, Security-scans, and CodeQL workflows are unchanged (service
images digest-pinned only). `actionlint` exits 0.

**Branch enforcement (mandatory human closure action):** the `main` ruleset
selects required status checks by explicit check name (Sprint 22 registered
the CI/Security/CodeQL checks individually), so the new
`Artifacts (build + smoke)` check does **not** gate merges automatically —
it must be added to the ruleset's required checks after its first remote
run. Until that registration is verified (e.g. `gh api
/repos/DanielRosenberg00/Orgistry/rulesets`), this package does not claim
the artifact gate is branch-enforced.

## 13. Smoke-Test Strategy and Results

`tooling/artifact-smoke.sh` — deterministic, self-contained (docker + curl),
trap-guaranteed teardown. Checks and results (local, 2026-08-23 — all PASS):
build both images; migrate one-shot exit 0; `/health` 200; `/ready` 200;
production `/ready` body coarse (no dependency names/latency, in success AND
failure bodies); readiness 503 on `compose stop redis` and recovery after
restart; web serves the production build (no Vite dev markers) with SPA
fallback; configured `VITE_API_BASE_URL` present in built assets; server
secrets absent from web assets; API uid 1000 / web uid 101; `/app` not
writable; `/app` layout exactly `dist migrations node_modules`; no
`.env`/git/TS-source/local-state leakage outside node_modules; fake secrets
absent from API+migrate logs; structured JSON logs with `requestId`;
config-guard rejection of `dev-only-jwt-secret-change-me` (exit ≠ 0, names
`JWT_SECRET`, does not echo the value); SIGTERM exit 0 with shutdown logged;
containers/networks/volumes removed. **Not validated (documented):**
account-email delivery (implicit-TLS driver vs. plain Mailpit), browser
flows, any real-infrastructure concern.

## 14. Validation Evidence

All commands run locally on 2026-08-23, final working tree:

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm validate` | PASS (exit 0) | typecheck + lint + 867 unit tests (81 files) + 78 web tests (10 files) + web build + schema drift + whitespace |
| `pnpm validate:integration` (against the alternate-port validation PostgreSQL, 55432 + local Redis) | PASS (exit 0) | db 16/16, api 82/82 integration tests |
| `git diff --check` | PASS | no whitespace errors |
| `pnpm scan:deps` | PASS (exit 0) | after in-range transitive updates; only the documented acceptance remains ignored |
| `pnpm scan:deps:local` | PASS (exit 0) | osv-scanner: "No issues found", GHSA-mh99-v99m-4gvg listed as configured acceptance |
| `pnpm scan:secrets` | PASS | Gitleaks 37 commits, "no leaks found" (also `gitleaks dir` over the new fake-credential files: no leaks). History scanning cannot cover the still-uncommitted files — the remote post-commit scan is part of the final DoD evidence |
| `actionlint` | PASS | exit 0 after `ci.yml` changes |
| `pnpm build:api` | PASS | `dist/server.mjs` 327.5 kB, `dist/migrate.mjs` 2.0 kB; bundle boots standalone outside the workspace (fails exactly at config validation with no env — proves module resolution) |
| `pnpm artifact:build` (via smoke) | PASS | both images build; `docker compose config` valid for both compose files |
| `./tooling/artifact-smoke.sh` | PASS ("SMOKE OK", exit 0; run 3× total during hardening) | full check list in §13 |
| Remote CI / Security / CodeQL / artifacts-job runs | BLOCKED | requires the human operator to commit and push (§ Human follow-up); no remote evidence exists for this working tree |

## 15. Documentation Updates

New: `docs/deployment-artifacts.md` (authoritative artifact/runtime/migration/
env-contract/secret-boundary/image-policy reference), this package. Updated:
root `README.md` (structure, docs index, limitations wording);
`docs/validation.md` (artifact tier in quick reference, "Artifact validation"
+ "Image pinning policy" sections, three-job CI description);
`docs/runbook.md` (production-like reference + digest policy);
`docs/known-limitations.md` (deployment + image-pinning entries);
`docs/local-development.md` (artifact gate command);
`docs/architecture.md` (repo layout, TS-source-consumption caveat);
`docs/roadmap.md` (deployment-automation gap wording);
production-readiness: `findings-register.md` (Sprint 23 status block; 001/006
progress entries; 042 resolution; summary rows), `README.md` (status log),
`production-roadmap.md` (Sprint 23 result recorded — local complete, remote
pending; conditional Sprint 24 preview added; later Phase 5–6 placeholders
unnumbered pending scheduling),
`launch-checklist.md` (LC-1.6/LC-1.7 status text only; sprint columns
unchanged), `production-scorecard.md`
(Infrastructure 0→2, CI/CD + Supply chain evidence, Sprint 23 status update),
`security-assessment.md` (supply-chain/CI-CD/infrastructure sections),
`standards-matrix.md` (Secure Build, build-service, provenance rows),
`repository-inventory.md` (scripts/CI/Docker/docs inventories).

## 16. Findings Closed

Finding status here reflects implementation evidence and is distinct from
Sprint DoD status (which is pending remote evidence — see the banner).

- **ORG-PR-042 — CLOSED.** Every active image reference is exact-patch-tag +
  manifest-list-digest pinned (Dockerfiles, both compose files, CI services);
  no floating references remain; Dependabot coverage + the one documented
  manual-bump exception. Evidence: the pinned references are pulled and
  executed by `pnpm artifact:smoke` and CI.

## 17. Findings Advanced (still open)

- **ORG-PR-001 — Open, materially advanced.** Previous: no Dockerfiles, no
  pipeline, apps run only via `pnpm dev`. Now: CI-validated production-shaped
  build/run path with no local-development assumptions (validated boot from
  the packaged artifact outside the workspace). Remaining gap under the
  finding definition: no artifact **promotion to a target environment** —
  no environment, no registry, no deploy pipeline, no rollback orchestration.
  Closure would overstate: "deployment automation" does not exist.
- **ORG-PR-006 — Open, boundary advanced only.** The artifacts enforce the
  runtime-injection seam (build/runtime secret separation, proven). No
  secrets manager, no rotation procedure, no rotation rehearsal — the
  finding's validation criterion ("rehearsed rotation of `JWT_SECRET`") is
  untouched. Documentation of the boundary deliberately does not close this.

## 18. Findings Still Open (untouched, per scope)

ORG-PR-002 (no real email provider — Mailpit remains a local stand-in only;
the reference topology explicitly documents that a real deployment replaces
it), ORG-PR-005 (no backup/PITR/restore), ORG-PR-015 (no retention/cleanup),
ORG-PR-021/022 (DB timeouts, least-privilege DB roles — not addressed in
Sprint 23; scheduling TBD).
Open P1 blockers: **ORG-PR-001, 002, 005, 006 — unchanged in count.**

## 19. Remaining Risks

- Migrations are forward-only with no backup to restore from (ORG-PR-005) —
  a bad migration in any real environment is currently unrecoverable.
- Email delivery from the artifact is completely unexercised (ORG-PR-002).
- `VITE_API_BASE_URL` is build-time: one web image serves exactly one API
  origin; per-environment rebuilds required.
- Workflow `services:` image pins age silently outside Dependabot (manual
  procedure documented).
- The smoke gate validates single-instance behavior only; multi-replica
  concerns (rolling deploys, connection limits) are unvalidated.
- Real secret handling (storage, injection mechanism, rotation) is entirely
  operator-undefined until the runtime-secrets work (Sprint 24, contingent
  on Sprint 23 closure).

## 20. Remaining P1 Blockers

`ORG-PR-001` (deployment half), `ORG-PR-002`, `ORG-PR-005`, `ORG-PR-006` —
four, unchanged.

## 21. Scope-Control Confirmation

Not implemented, confirmed by diff review: no staging, no production
deployment, no registry publishing, no cloud IaC, no DNS/TLS/CDN/WAF, no
Kubernetes, no signing/provenance, no secrets manager, no secret/JWT
rotation, no backup/PITR/restore, no external SMTP validation, no
monitoring/alerting, no retention enforcement, no worker, no product or
auth/authorization/API contract changes. The only application-code-adjacent
changes are additive: the `build` script + `esbuild` devDependency in
`apps/api/package.json` and in-range transitive lockfile updates.

## 22. Final Readiness Classification

**C — Ready to continue production implementation.** Not ready for staging.
Not ready for production. The artifacts are buildable and validated locally
and (once pushed) in CI; buildability is not deployability — no target
environment exists. Four P1 blockers remain open.

## 23. Recommended Next Sprint

**If Sprint 23 remote closure succeeds, the next sprint is Sprint 24 —
Runtime Secrets and External Email Validation** (reserved by the binding
Sprint 23 specification). If remote closure exposes an artifact/runtime gap,
that residual is closed before Sprint 24 begins. Focus: runtime secret-injection
implementation/integration, secret rotation procedures, JWT/access-token
secret rotation planning (relates to ORG-PR-049), external production
SMTP/provider validation — sender-domain requirements, SPF/DKIM/DMARC
posture where applicable, real inbox delivery, email failure behavior — and
the related operational documentation. Primary findings: **ORG-PR-002,
ORG-PR-006**. It consumes what this sprint produced: the runtime
secret-injection boundary and the production-shaped smtp-driver artifact.
ORG-PR-001's residual deployment-environment/promotion work remains open and
must be scheduled separately; that scheduling is not decided here.
