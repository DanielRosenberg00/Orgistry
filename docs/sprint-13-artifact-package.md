# Sprint 13 Artifact Package — Final Review & Portfolio Packaging

**Sprint type:** packaging, review, documentation, validation, and
release-candidate preparation. **Not** a product feature sprint — no new backend
modules, frontend surfaces, routes, permissions, roles, entitlements, or quotas
were added.

This artifact records what Sprint 13 changed, the validation evidence captured
after the changes, the exact git state, and the recommended next steps. It is
honest about what was and was not run.

---

## 1. Implementation Summary

Sprint 13 prepared Orgistry for external review as an engineering artifact. The
work was documentation and packaging, plus one small, accurate-comment fix in
`.env.example`. Specifically:

- **Created three reviewer-facing documents:** a portfolio case study, an
  evaluation guide, and a roadmap.
- **Wired them into the README** with a new "Start here (reviewers)" entry point
  in the documentation index.
- **Corrected a misleading public-facing comment** in `.env.example`: Redis-backed
  rate limiting was labeled "future" though it is fully implemented; also
  neutralized a few sprint-era section labels in that reviewer-facing file.
- **Audited the authoritative docs** (links, commands, env vars, routes, maturity
  claims) — found clean apart from the `.env.example` comment above.
- **Captured final validation evidence** (offline gate green; integration gate
  documented as environment-blocked).
- **Produced this artifact** and a commit hygiene plan with exact, ready-to-copy
  git commands.

No code paths, APIs, schema, or product behavior were modified.

## 2. Repository Cleanup Summary

- `git status` reviewed. **The working tree is not clean** — and is not expected to
  be: it carries the accumulated, **uncommitted** Sprint 11/12 changes (already
  staged at session start) plus this sprint's edits. See §5 for the precise,
  itemized state.
- **No accidental junk files detected:** no `node_modules`, `dist/`, `build/`,
  coverage outputs, `*.log`, `.DS_Store`, or editor files are tracked or
  untracked-and-pending. (Verified via `git status --porcelain --untracked-files=all`.)
- **No committed `.env`:** `.env` is untracked and `.gitignore`-covered;
  `git ls-files .env` returns nothing.
- **No secrets in tracked files:** the only `*secret*` matches are source/test
  files for the API-key secret feature (`api-key-secret.ts/.test.ts`,
  `api-keys-secret.test.tsx`) — code, not credentials. `.env.example` values are
  explicitly local-only development defaults.
- **No raw API key secrets or invitation tokens persisted:** confirmed by *static
  review* of `tooling/demo-seed.mjs` — it prints the one-time API key secret to
  stdout only and never writes it to a file; raw invitation tokens exist only in
  the Mailpit email, never in URLs/logs/files. (The seed was not executed in this
  environment — see §4a.)
- `.gitignore` is comprehensive (deps, build output, `.env*`, logs, editor/OS,
  coverage).

## 3. Documentation Index

**New this sprint:**

- [`docs/portfolio-case-study.md`](./portfolio-case-study.md)
- [`docs/evaluation-guide.md`](./evaluation-guide.md)
- [`docs/roadmap.md`](./roadmap.md)
- [`docs/sprint-13-artifact-package.md`](./sprint-13-artifact-package.md) (this file)

**Authoritative (current), unchanged this sprint except the README index:**

- [README](../README.md) · [architecture](./architecture.md) ·
  [security model](./security-model.md) · [API surface index](./api-surface.md) ·
  [validation](./validation.md) · [local development](./local-development.md) ·
  [runbook](./runbook.md) · [troubleshooting](./troubleshooting.md) ·
  [known limitations](./known-limitations.md) ·
  [demo walkthrough](./demo-walkthrough.md) · [web demo](./web-demo.md) ·
  [API conventions](./api-conventions.md).

**Subsystem references:** auth, sessions, organizations, RBAC, projects,
entitlements/plans/quotas, API keys & external API, invitations, audit log,
database (under `docs/`).

**Historical:** `docs/sprint-*-artifact-package.md` and
`docs/sprint-1-foundation.md` — development record, clearly labeled historical in
the README.

**Link audit result:** all relative markdown links in the authoritative docs and
README resolve to files on disk; all `pnpm` command snippets match `package.json`;
all env vars referenced in docs exist in `.env.example`; route examples are
consistent with the API surface index. No broken links, stale commands, or
overstated-maturity claims were found (the one stale `.env.example` comment was
fixed).

## 4. Validation Evidence

Captured **after** all Sprint 13 changes. Counts are from a full-output run; the
post-change run reproduced the same pass with exit code 0.

| Command | Status | Notes |
| --- | --- | --- |
| `pnpm validate` | **PASS** (exit 0) | Full offline gate, run after changes. |
| ├─ `pnpm typecheck` | PASS | Strict `tsc --noEmit`, all workspaces. |
| ├─ `pnpm lint` | PASS | `eslint .` (flat config). |
| ├─ `pnpm test` | PASS | **53 files, 489 tests passed.** |
| ├─ `pnpm test:web` | PASS | **5 files, 19 tests passed.** |
| ├─ `pnpm build:web` | PASS | Vite build (≈378 kB / ≈111 kB gzip). |
| ├─ `pnpm db:check` | PASS | Schema-drift: migrations in sync with schema. |
| └─ `pnpm check:whitespace` | PASS | `git diff --check` clean. New docs also verified free of trailing whitespace. |
| `pnpm validate:integration` | **NOT RUN (environment-blocked)** | See below. |
| `pnpm lint` (standalone) | PASS | Covered by `pnpm validate`. |
| `pnpm db:check` (standalone) | PASS | Covered by `pnpm validate`. |
| `pnpm --filter @orgistry/web-demo build` | PASS | Covered as `build:web`. |
| `git diff --check` | PASS | No whitespace errors. |

**Why integration validation was not run (honest limitation):** `pnpm
validate:integration` requires a live Orgistry PostgreSQL. At validation time,
only the Redis and Mailpit containers were running; the Orgistry PostgreSQL
container was **not** up, and host port 5432 is held by a **foreign** PostgreSQL
(a read-only probe with the Orgistry credentials returned `password
authentication failed for user "orgistry"`). Running the integration suite — which
begins with a destructive `db:reset:test` — against an unknown foreign database
would be unsafe and is therefore deliberately skipped, not faked. This matches a
known local-environment constraint (port 5432 occupied by a foreign Postgres;
integration validation needs the Orgistry Postgres, optionally on an alternate
port).

**Exact commands for a maintainer to run integration validation locally:**

```bash
# Ensure the Orgistry Postgres container is up (free port 5432 first, or remap it
# in infra/docker-compose.yml + DATABASE_URL/TEST_DATABASE_URL to an alternate port).
pnpm infra:up                 # PostgreSQL, Redis, Mailpit
cp .env.example .env          # local-only defaults
pnpm validate:integration     # db:reset:test + migration-from-scratch + live API tests
```

CI (`.github/workflows/ci.yml`) runs both gates on every push, including the
integration job against `postgres:16-alpine` + `redis:7-alpine` service
containers, so the live paths are continuously exercised there.

### 4a. Demo seed status (precise)

`pnpm demo:seed` was **statically reviewed, not executed end-to-end** in this
environment. Do not read it as fully verified.

- **Status:** Documented and statically reviewed. **Not executed locally** — it
  requires the API running against a live Orgistry PostgreSQL, which was
  unavailable (foreign Postgres on port 5432; see above).
- **Requires:** live API (`pnpm dev:api`) + Orgistry PostgreSQL + Redis + Mailpit.
- **What static review confirmed:** drives the **public HTTP API only** (never the
  database directly), so all backend invariants hold; idempotent (reuses existing
  state instead of duplicating); prints the one-time API key secret to **stdout
  only** (never to a file); uses local-only demo credentials documented in the
  [demo walkthrough](./demo-walkthrough.md).
- **Maintainer verification command** (with infra + API up):

  ```bash
  pnpm demo:seed
  ```

This is intentionally aligned with the integration-validation limitation: the same
missing Orgistry PostgreSQL blocks both a full integration run and an end-to-end
demo-seed run.

## 5. Commit Hygiene / Git State

Precise status (do not read "clean" anywhere — the working tree is **not** clean):

- **No commits created.**
- **No tag created.**
- **Nothing pushed.**
- **Working tree is not clean:** expected Sprint 13 files plus pre-existing staged
  changes remain. **Maintainer action required before tagging.**
- **No accidental junk files detected** (see §2).

### 5.1 Three categories in the working tree

The index is in a **mixed** state. `git status --short` distinguishes them by the
two status columns (column 1 = index/staged, column 2 = working tree):

**(A) Pre-existing staged working set from earlier sprints (Sprint 11/12 — NOT
authored in this pass).** Staged at session start; column 1 is `A`/`M`/`D`:

```
M  .github/workflows/ci.yml
M  apps/api/src/lib/rate-limit.test.ts
A  docs/api-surface.md
A  docs/architecture.md
A  docs/demo-walkthrough.md
A  docs/known-limitations.md
M  docs/local-development.md
A  docs/runbook.md
A  docs/security-model.md
A  docs/sprint-12-artifact-package.md
A  docs/troubleshooting.md
A  docs/validation.md
A  eslint.config.js
M  infra/docker-compose.yml
M  package.json
M  packages/config/src/schema.ts
M  pnpm-lock.yaml
A  tooling/check-schema-drift.mjs
A  tooling/demo-seed.mjs
D  tooling/lint-placeholder.mjs
```

**(B) Sprint 13 edits to two already-staged files (`MM` — staged Sprint 11/12
content *plus* this pass's unstaged edits in the same files):**

```
MM .env.example      # comment-only cleanup this pass
MM README.md         # reviewer entry point added this pass
```

**(C) Sprint 13 new, untracked files (`??` — created this pass):**

```
?? docs/portfolio-case-study.md
?? docs/evaluation-guide.md
?? docs/roadmap.md
?? docs/sprint-13-artifact-package.md
```

### 5.2 Why a naive `git add` + `git commit` is unsafe here

Because a large set is **already staged** (category A), a plain `git commit` after
`git add README.md .env.example` would sweep **all** staged files — categories A
and B together — into one commit. The safe commit plan in §10 avoids this with
`git commit --only <paths>` (verified in this repo: `--only` commits *only* the
named paths and leaves the rest of the index untouched), plus an explicit
`git add` for the untracked category-C files first (verified: `git commit --only`
errors on a path not yet known to git).

## 6. Release Candidate / Milestone Recommendation

- **Recommended milestone:** `v0.1.0` — first coherent, externally reviewable
  cut of the identity/access foundation.
- **Recommended tag (after the changes are committed):** `v0.1.0-rc1`.
- **Rationale:** the implemented surface is complete for a reference foundation,
  fully type-checked/linted/tested offline, CI-mirrored, and now documented for
  external review. It is explicitly **not production-certified**, so a release
  *candidate* (rc1), not a final release, is the honest label.

**Release-candidate summary:** A fully typed pnpm monorepo implementing a
multi-tenant SaaS identity/access backbone — auth & sessions, organizations &
memberships, fixed RBAC, plans/entitlements/quotas, Projects, API keys + a
read-only external API, invitations, and an audit-log read — with a thin React
admin demo and a two-tier validation gate mirrored in CI.

- **Feature status:** see §1 and the [API surface index](./api-surface.md).
- **Validation evidence:** §4 (offline green; integration via CI / local with
  Postgres).
- **Known limitations:** [known limitations](./known-limitations.md).
- **Next steps:** [roadmap](./roadmap.md).

**Do not create or push the tag without maintainer approval.** Exact command (run
only after committing, and only if approved):

```bash
git tag -a v0.1.0-rc1 -m "Orgistry v0.1.0-rc1 — portfolio-ready identity/access foundation (not production-certified)"
# Push only if explicitly approved:
# git push origin v0.1.0-rc1
```

## 7. Portfolio Packaging Summary

An external reviewer can now answer every intended question from the docs:

- *What is it / why / what does it prove?* → [README](../README.md) +
  [portfolio case study](./portfolio-case-study.md).
- *What is / isn't implemented?* → [API surface index](./api-surface.md) +
  [known limitations](./known-limitations.md).
- *How do I run / validate / demo it?* → README + [validation](./validation.md) +
  [demo walkthrough](./demo-walkthrough.md) + `pnpm demo:seed`.
- *Architecture / security boundaries?* → [architecture](./architecture.md) +
  [security model](./security-model.md).
- *What should I inspect first / how to judge it?* →
  [evaluation guide](./evaluation-guide.md).
- *What's next?* → [roadmap](./roadmap.md).

**GitHub presentation recommendations** (cannot be set from the repo; for the
maintainer to apply manually in repo settings):

- **Repository description:**

  > Portfolio-grade SaaS identity and access foundation with organizations, RBAC,
  > entitlements, API keys, invitations, audit logs, and a React admin demo.

- **Topics** (all match the current repository):

  ```txt
  saas
  multi-tenant
  rbac
  auth
  fastify
  react
  postgresql
  drizzle
  typescript
  portfolio-project
  ```

- **Homepage / demo field:** **none yet** — leave empty. There is no hosted demo;
  it runs locally (`pnpm dev` + `pnpm demo:seed`). Add a URL only if a hosted demo
  is published later.
- **Pinned README sections / first-reviewer path:** the README's
  "Start here (reviewers)" block already surfaces the evaluation guide, case study,
  and roadmap as the intended first-reviewer path — no further pinning needed.
- **Release notes draft for `v0.1.0-rc1`:**

  > **Orgistry v0.1.0-rc1 — portfolio-ready identity/access foundation**
  >
  > First externally reviewable cut of a fully typed pnpm monorepo implementing a
  > multi-tenant SaaS identity/access backbone: auth & sessions (Argon2id, JWT,
  > rotating hash-only refresh tokens with reuse detection, CSRF, Redis rate
  > limits), organizations & memberships, fixed RBAC, plans/entitlements/quotas,
  > Projects, organization-scoped API keys + a read-only external API, the
  > invitation lifecycle, and an audit-log read — plus a thin React/Vite admin
  > demo and a two-tier validation gate mirrored in CI.
  >
  > **Not production-certified.** Out of scope by design: billing, OAuth/MFA/
  > password reset, production email, RLS, custom roles, ABAC, audit export,
  > webhooks, SDKs, workers, and deployment automation. See `docs/known-limitations.md`.
  > Start with `docs/evaluation-guide.md`.

## 8. Remaining Risks

- **Integration validation not executed in this environment.** Offline is green
  and CI exercises the live paths, but the local integration run was blocked by a
  foreign Postgres on 5432 (§4). Low risk to packaging; the maintainer should run
  it once locally with the Orgistry Postgres up.
- **Test counts are point-in-time.** 489 unit / 19 web reflect the validation run
  in this session; re-running `pnpm validate` reproduces them.
- **Demo assets (screenshots) not produced.** Optional; remains future work
  ([roadmap](./roadmap.md) → documentation/demo improvements).
- **Repository carries a large uncommitted working set** (Sprint 11/12 + Sprint
  13). Committing it per the plan in §10 is recommended before tagging.

## 9. Scope Control Confirmation

No product scope was expanded. Confirmed absent: new backend module, new frontend
product surface, new API route, new permission, new role, new entitlement, new
quota, billing/Stripe, OAuth, MFA, password reset, production email provider,
workers/queues, PostgreSQL RLS, custom roles, resource-level/ABAC permissions,
audit export, webhooks, SIEM, SDK publishing, production deployment automation,
UI redesign, analytics, or monitoring infrastructure.

The only implementation-file change was a **comment-only** edit in `.env.example`
(correcting "future rate limiting" to reflect that it is implemented, and
neutralizing a few sprint-era section labels in a reviewer-facing file). No
executable behavior changed.

## 10. Final Reviewer Commands

```bash
# Offline review (no services required)
pnpm install
pnpm validate

# Live review (requires Docker; Orgistry Postgres must own/​reach the DB)
pnpm infra:up
cp .env.example .env
pnpm db:migrate
pnpm dev:api          # http://localhost:3000   (separate terminal)
pnpm dev:web          # http://localhost:5173   (separate terminal)
pnpm demo:seed        # presentable demo state via the public API
pnpm validate:integration
```

### Safe commit plan for Sprint 13 changes only

**Why this is non-trivial:** a large set is already staged from Sprint 11/12 (§5.1
category A), so a plain `git add … && git commit` would sweep those pre-existing
staged files into the commit too. Both options below were verified against this
repo's state. **Nothing here pushes, tags, or runs without you.**

#### Option A — Recommended: preserve the existing staging, commit only Sprint 13 paths

Uses `git commit --only <paths>`, which commits *only* the named paths (their full
working-tree content) and leaves the rest of the index untouched. Untracked files
must be `git add`ed first, because `git commit --only` errors on a path not yet
known to git (verified).

```bash
# 1. The two tracked files this pass edited (MM). --only commits just these two,
#    full current content; the pre-existing staged set (category A) stays staged.
git commit --only README.md .env.example \
  -m "docs: polish repository overview and reviewer entry point"

# 2. Stage the four untracked Sprint 13 docs so --only can address them...
git add docs/portfolio-case-study.md docs/evaluation-guide.md \
        docs/roadmap.md docs/sprint-13-artifact-package.md

# 3. ...then commit them in two logical groups, each scoped to its own paths.
git commit --only docs/portfolio-case-study.md docs/evaluation-guide.md \
  -m "docs: add portfolio case study and evaluation guide"
git commit --only docs/roadmap.md docs/sprint-13-artifact-package.md \
  -m "docs: add roadmap and sprint 13 artifact package"

# 4. Confirm what remains (should be the Sprint 11/12 staged set, category A).
git status --short
```

After Option A, the three Sprint 13 commits exist locally and the Sprint 11/12
working set is still staged-and-uncommitted, ready for a separate commit (below).

#### Option B — Alternative: fully reset staging first, then stage logical groups

Use only if you prefer to rebuild the index from scratch. **`git reset` unstages
everything (including the Sprint 11/12 set); it does NOT discard working-tree
changes** — your edits and untracked files are preserved, just no longer staged.

```bash
git reset    # OPTIONAL, INDEX-ONLY: unstage all; working tree changes preserved

# Now nothing is staged, so plain git add + git commit is safe and scoped:
git add README.md .env.example
git commit -m "docs: polish repository overview and reviewer entry point"

git add docs/portfolio-case-study.md docs/evaluation-guide.md
git commit -m "docs: add portfolio case study and evaluation guide"

git add docs/roadmap.md docs/sprint-13-artifact-package.md
git commit -m "docs: add roadmap and sprint 13 artifact package"

git status --short   # Sprint 11/12 changes now appear UNSTAGED; commit separately
```

#### Optionally: commit the pre-existing Sprint 11/12 working set separately

This is the category-A set (and, under Option B, also the now-unstaged Sprint 11/12
files). Commit it on its own so history stays legible — **after** the Sprint 13
commits, or before, as you prefer:

```bash
# Stage and review the remaining Sprint 11/12 working set explicitly, then:
git add -A
git status --short                 # verify only Sprint 11/12 paths remain
git commit -m "chore: sprint 11/12 packaging, tooling, and CI working set"
```

## 11. Readiness Assessment

**Sprint 13 is complete against its definition of done**, with one honest caveat:
integration validation was not run in this environment (foreign Postgres on 5432)
and is delegated to the maintainer / CI, with exact commands provided.

- Repository state reviewed: no accidental junk files, no secrets. Working tree is
  **not clean** (expected Sprint 13 files + pre-existing staged changes remain). ✅
- README final-reviewed; documentation index coherent. ✅
- Portfolio case study, evaluation guide, roadmap, and this artifact created. ✅
- Known limitations and security limitations current and explicit; no unsupported
  production claims; no out-of-scope feature implied as implemented. ✅
- Link/command/env/route audit clean (one stale comment fixed). ✅
- Offline validation green after final changes; integration documented honestly. ✅
- Demo seed **statically reviewed and documented (not executed locally)**;
  walkthrough realistic. ✅
- No commits, no tag, nothing pushed; **safe** commit plan (§10) + exact commands
  provided; maintainer action required before tagging. ✅
- Scope control confirmed; only a comment-level code change. ✅

## 12. Suggested Next Steps

1. **Run integration validation once locally** with the Orgistry Postgres up
   (§4 / §10) to confirm the live paths on this machine.
2. **Commit** the working set using the grouping in §10.
3. **Tag `v0.1.0-rc1`** (only with approval; §6) and optionally draft release
   notes from the release-candidate summary.
4. **Apply the GitHub description/topics** recommendations (§7).
5. **(Optional) Capture demo screenshots** for the README/case study
   ([roadmap](./roadmap.md)).
