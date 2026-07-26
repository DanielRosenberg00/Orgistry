# Sprint 22 — CodeQL Alert Inventory

Complete triage of every alert from the first operational CodeQL run.

- **Repository:** `DanielRosenberg00/Orgistry` (public)
- **Analyzed commit (baseline):** `c33a150fd0feaa1ce74313fc9185837ec2c2e1ef` (Sprint 21 closing commit)
- **Baseline analysis:** id `1528655701`, `refs/heads/main`, 2026-07-26T14:04:51Z, 41 results across 87 rules
- **Alerts at triage start:** 41 open, all `security-severity: high`, none dismissed or fixed
- **Alert URL form:** `https://github.com/DanielRosenberg00/Orgistry/security/code-scanning/<number>`

The baseline count in the sprint specification and the observed GitHub state agree exactly: 41 open High alerts, distributed 34 / 3 / 2 / 2 across the four queries, with alert numbers 1–41 and no prior dispositions.

## Contents

- [Query distribution](#query-distribution)
- [Root-cause groups](#root-cause-groups)
- [Classification totals](#classification-totals)
- [Master reconciliation table](#master-reconciliation-table) — all 41 alerts
- [Group analysis](#group-analysis) — evidence per root cause
- [Triage log](#triage-log)

## Query distribution

| Query | Baseline | Observed after remediation | Notes |
| --- | --- | --- | --- |
| `js/missing-rate-limiting` | 34 | 34 | 1 defect fixed (alert 12); the limiter stays invisible to the query (service layer), so the alert persists and is dismissed with evidence |
| `js/clear-text-logging` | 3 | 2 | alert 7's sink removed outright; alert 6 relocated by the edit and re-registered as alert 45 |
| `js/insufficient-password-hash` | 2 | 4 | +2 in the NEW test file, which computes SHA-256 of a password deliberately, to assert the stored hash is *not* that value |
| `js/biased-cryptographic-random` | 2 | 1 | the two duplicated sites collapsed into one shared helper — alert 42 supersedes 1 and 2 |
| **Total** | **41** | **41** | 45 alerts have existed in total |

Counts verified against GitHub after analysis `1528767654` (commit `9733b880`, `refs/heads/main`), not inferred from code inspection.

### Alerts created by the remediation itself

Four baseline alerts closed as *fixed* and four new alerts appeared. Only one of the four closures is an actual defect fix — the other three are location changes, and recording them as fixes without saying so would overstate the result.

| New | Query | Location | Relationship |
| --- | --- | --- | --- |
| 42 | biased-cryptographic-random | `packages/shared/src/random-alphabet.ts:53` | **Supersedes alerts 1 and 2.** Both closed because the duplicated mapping moved into one shared helper. Net effect: two alerts became one. No defect was fixed — the arithmetic was already uniform. |
| 43 | insufficient-password-hash | `packages/auth-core/src/hashing-invariants.test.ts:38` | **New, test-only.** The test computes `sha256(password)` so the next lines can assert the stored Argon2id hash is not it. Dismissed *used in tests*. |
| 44 | insufficient-password-hash | `packages/auth-core/src/hashing-invariants.test.ts:48` | **New, test-only.** Same pattern, asserting `verifyPassword(sha256, password)` is false. Dismissed *used in tests*. |
| 45 | clear-text-logging | `tooling/demo-seed.mjs:261` | **Supersedes alert 6.** Initially the same sink at a shifted line (256 → 261). **Remediated in the completion iteration** — API-key creation was removed from the bootstrap, so the sink no longer exists. |

Genuinely fixed by a code change: **alert 7 only** (the duplicate secret print inside the `curl` example was deleted). Alerts 1, 2, and 6 are bookkeeping closures caused by code motion, and their substance lives on in alerts 42 and 45.

A note on the two test-file alerts: writing a test that proves passwords are *not* SHA-256 hashed necessarily contains a SHA-256 call on a password. The scanner cannot distinguish an assertion's negative control from a real hashing path. That is a fair limitation to accept rather than a reason to delete the test — the test is the strongest evidence the invariant holds.

## Root-cause groups

| Group | Description | Alerts | Count |
| --- | --- | --- | --- |
| `S22-RC-001` | Per-actor mutation limiter enforced in the SERVICE layer; CodeQL models only the route module | 8, 13, 15, 18, 19, 22, 24, 25, 30, 34, 36, 37 | 12 |
| `S22-RC-002` | Per-key / per-organization limiter enforced inside the API-key AUTHENTICATOR | 11 | 1 |
| `S22-RC-003` | Read surface bounded by the global per-IP `onRequest` limiter registered in `app.ts` | 9, 14, 16, 17, 20, 23, 26, 27, 28, 29, 31, 32, 33, 35, 38, 39, 40 | 17 |
| `S22-RC-004` | Idempotent revoke: durable work is state-bounded by creation, which is itself throttled | 10, 21 | 2 |
| `S22-RC-005` | Fastify `onSend` response hook misidentified as a route handler | 41 | 1 |
| `S22-RC-006` | **Confirmed defect** — audit read has unbounded query cost and no per-actor ceiling | 12 | 1 |
| `S22-RC-007` | SHA-256 digest of a 32-byte CSPRNG opaque token modelled as password hashing | 3, 4 | 2 |
| `S22-RC-008` | Modulo over a 32-character alphabet, which divides the 256-value byte domain exactly | 1, 2 | 2 |
| `S22-RC-009` | **Confirmed defect** — demo bootstrap emitted the one-time API key secret to a terminal | 6, 7 | 2 |
| `S22-RC-010` | Demo bootstrap log helper flagged on a non-secret field of an `apiKey` object | 5 | 1 |
| | | **Total** | **41** |

## Classification totals

| Final classification | Count | Alerts |
| --- | --- | --- |
| Fixed defect | 3 | 6, 7, 12 |
| Covered by endpoint-specific control but invisible to CodeQL | 13 | 8, 11, 13, 15, 18, 19, 22, 24, 25, 30, 34, 36, 37 |
| Covered by global control but invisible to CodeQL | 19 | 9, 10, 14, 16, 17, 20, 21, 23, 26, 27, 28, 29, 31, 32, 33, 35, 38, 39, 40 |
| Framework/model false positive | 4 | 1, 2, 5, 41 |
| High-entropy-token false positive | 2 | 3, 4 |
| Accepted residual risk | 0 | — |
| Duplicate of another alert | 0 | — |
| Confirmed defect (unresolved) | 0 | — |
| Needs follow-up | 0 | — |
| Not reproducible | 0 | — |
| **Total** | **41** | |

Four classifications carry zero members, and that is a finding in itself: no alert was left as an unresolved true positive, none resisted reproduction, none needed follow-up, and — after the completion iteration — **none was accepted as a residual risk**. All three defects found were fixed inside this sprint.

Alert 6 moved from *Accepted residual risk* to *Fixed defect* during the sprint. The first pass accepted the credential print with a loopback-target compensating control; the completion iteration rejected that reasoning and removed the output entirely. See [S22-RC-009](#s22-rc-009--demo-bootstrap-emitted-the-one-time-api-key-secret) for why the original acceptance was indefensible.

### Verified final GitHub state

Read back from the API after all dispositions were applied, not asserted from intent:

| State | Count | Detail |
| --- | --- | --- |
| Open | 0 | — |
| Fixed | 4 | alerts 1, 2, 6, 7 |
| Dismissed | 41 | 38 *false positive*, 2 *used in tests*, 1 *won't fix* |
| **Total alerts ever created** | **45** | 41 baseline + 4 successors |

Every dismissal carries an individual comment naming its own route, control, or arithmetic; a check for dismissals with a comment shorter than 50 characters returns zero. GitHub caps `dismissed_comment` at 280 characters, so each comment states the specific evidence and cites its root-cause group in this document rather than reproducing the full analysis.

**Reaching zero open alerts was an outcome, not a target.** It follows from 34 of the 41 belonging to one architectural pattern the query cannot model. The honest consequence is recorded in [known-limitations.md](../known-limitations.md): this repository cannot use "zero open alerts" as a health signal, and depends instead on the dismissal-evidence rule in the [CodeQL alert policy](../validation.md#codeql-alert-policy).

## Master reconciliation table

Every one of the 41 baseline alerts, with its final state. `RC` links to the group analysis below.

| # | Query | Location | Route / symbol | RC | Final classification | GitHub disposition |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | biased-cryptographic-random | `apps/api/src/modules/api-keys/api-key-secret.ts:39` | `randomBase32` (display id) | 008 | Framework/model false positive | Auto-closed (code moved); superseded by alert 42, dismissed FP |
| 2 | biased-cryptographic-random | `packages/shared/src/ids.ts:53` | `randomBase32` (public ids) | 008 | Framework/model false positive | Auto-closed (code moved); superseded by alert 42, dismissed FP |
| 3 | insufficient-password-hash | `apps/api/src/modules/api-keys/api-key-secret.ts:56` | `hashApiKeySecret` | 007 | High-entropy-token false positive | Dismissed — false positive |
| 4 | insufficient-password-hash | `packages/auth-core/src/opaque-token.ts:32` | `hashOpaqueToken` | 007 | High-entropy-token false positive | Dismissed — false positive |
| 5 | clear-text-logging | `tooling/demo-seed.mjs:75` | `log()` helper | 010 | Framework/model false positive | Dismissed — false positive |
| 6 | clear-text-logging | `tooling/demo-seed.mjs:256` | one-time secret print | 009 | **Fixed defect** | Auto-closed (line moved); successor alert 45 remediated in the completion iteration (ORG-PR-056 closed) |
| 7 | clear-text-logging | `tooling/demo-seed.mjs:258` | `curl` example | 009 | Fixed defect | **Closed by fix** (verified: state `fixed` on GitHub) |
| 8 | missing-rate-limiting | `api-key.routes.ts:50-79` | `POST …/api-keys` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 9 | missing-rate-limiting | `api-key.routes.ts:85-97` | `GET …/api-keys` | 003 | Covered by global control | Dismissed — false positive |
| 10 | missing-rate-limiting | `api-key.routes.ts:103-116` | `DELETE …/api-keys/:apiKeyId` | 004 | Covered by global control | Dismissed — false positive |
| 11 | missing-rate-limiting | `external-projects.routes.ts:46-71` | `GET /v1/external/projects` | 002 | Covered by endpoint-specific control | Dismissed — false positive |
| 12 | missing-rate-limiting | `audit.routes.ts:43-65` | `GET …/audit-events` | 006 | **Fixed defect** | Dismissed — false positive (limiter now present, still invisible) |
| 13 | missing-rate-limiting | `auth.routes.ts:66-74` | `POST /v1/auth/login` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 14 | missing-rate-limiting | `auth.routes.ts:76-80` | `GET /v1/auth/me` | 003 | Covered by global control | Dismissed — false positive |
| 15 | missing-rate-limiting | `email-verification.routes.ts:32-38` | `POST …/email-verification/request` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 16 | missing-rate-limiting | `plan.routes.ts:51-60` | `GET …/plan` | 003 | Covered by global control | Dismissed — false positive |
| 17 | missing-rate-limiting | `plan.routes.ts:66-75` | `GET …/entitlements` | 003 | Covered by global control | Dismissed — false positive |
| 18 | missing-rate-limiting | `plan.routes.ts:81-92` | `PATCH …/plan/demo` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 19 | missing-rate-limiting | `invitation.routes.ts:59-71` | `POST …/invitations` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 20 | missing-rate-limiting | `invitation.routes.ts:77-89` | `GET …/invitations` | 003 | Covered by global control | Dismissed — false positive |
| 21 | missing-rate-limiting | `invitation.routes.ts:95-108` | `DELETE …/invitations/:invitationId` | 004 | Covered by global control | Dismissed — false positive |
| 22 | missing-rate-limiting | `invitation.routes.ts:123-134` | `POST /v1/invitations/accept` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 23 | missing-rate-limiting | `member.routes.ts:46-58` | `GET …/members` | 003 | Covered by global control | Dismissed — false positive |
| 24 | missing-rate-limiting | `member.routes.ts:64-76` | `PATCH …/members/:membershipId/role` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 25 | missing-rate-limiting | `member.routes.ts:82-92` | `DELETE …/members/:membershipId` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 26 | missing-rate-limiting | `org-rbac.routes.ts:53-56` | `GET …/roles` | 003 | Covered by global control | Dismissed — false positive |
| 27 | missing-rate-limiting | `org-rbac.routes.ts:61-67` | `GET …/permissions` | 003 | Covered by global control | Dismissed — false positive |
| 28 | missing-rate-limiting | `org-rbac.routes.ts:72-75` | `GET …/permissions/matrix` | 003 | Covered by global control | Dismissed — false positive |
| 29 | missing-rate-limiting | `org-rbac.routes.ts:81-87` | `GET …/permissions/effective` | 003 | Covered by global control | Dismissed — false positive |
| 30 | missing-rate-limiting | `organization.routes.ts:49-54` | `POST /v1/organizations` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 31 | missing-rate-limiting | `organization.routes.ts:56-64` | `GET /v1/organizations` | 003 | Covered by global control | Dismissed — false positive |
| 32 | missing-rate-limiting | `organization.routes.ts:68-75` | `GET /v1/organizations/:organizationId` | 003 | Covered by global control | Dismissed — false positive |
| 33 | missing-rate-limiting | `project.routes.ts:52-64` | `GET …/projects` | 003 | Covered by global control | Dismissed — false positive |
| 34 | missing-rate-limiting | `project.routes.ts:70-81` | `POST …/projects` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 35 | missing-rate-limiting | `project.routes.ts:87-100` | `GET …/projects/:projectId` | 003 | Covered by global control | Dismissed — false positive |
| 36 | missing-rate-limiting | `project.routes.ts:106-121` | `PATCH …/projects/:projectId` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 37 | missing-rate-limiting | `project.routes.ts:127-140` | `DELETE …/projects/:projectId` | 001 | Covered by endpoint-specific control | Dismissed — false positive |
| 38 | missing-rate-limiting | `rbac.routes.ts:33-36` | `GET /v1/roles` | 003 | Covered by global control | Dismissed — false positive |
| 39 | missing-rate-limiting | `rbac.routes.ts:38-41` | `GET /v1/permissions` | 003 | Covered by global control | Dismissed — false positive |
| 40 | missing-rate-limiting | `rbac.routes.ts:43-46` | `GET /v1/permissions/matrix` | 003 | Covered by global control | Dismissed — false positive |
| 41 | missing-rate-limiting | `plugins/security-headers.ts:49-74` | `onSend` hook (not a route) | 005 | Framework/model false positive | Dismissed — false positive |

All route paths under `…` are prefixed `/v1/organizations/:organizationId`. All API-module paths are relative to `apps/api/src/modules/`.

## Group analysis

### S22-RC-001 — Per-actor mutation limiter enforced in the service layer

**Alerts:** 8, 13, 15, 18, 19, 22, 24, 25, 30, 34, 36, 37 (12)

**Why CodeQL reports it.** `js/missing-rate-limiting` looks for a rate-limiting call reachable from the route-handler function it is analyzing. Orgistry's route handlers are deliberately thin — they authenticate, parse a Zod contract, and delegate. Every per-actor limiter lives one module away, in the service that owns the workflow, and is reached through an interface (`ProjectService`, `MemberService`, …) whose implementation is selected at composition time in `app.ts` / `server.ts`. The query does not follow that indirection, so it sees a handler that performs authorization and no `consume` call.

**Why the placement is correct and not moved.** Sprint 19 (ORG-PR-032) put the buckets AFTER the permission check on purpose: a limiter in front of authorization would let an unauthorized caller learn that a resource exists by observing 429 instead of 404. `mutation-throttle.test.ts:178` and `project-throttle.test.ts:85` pin exactly that ordering. Hoisting the limiters into route handlers to satisfy the scanner would reintroduce the leak the tests forbid.

**Control detail.**

| Alert | Route | Limiter key | Config ceiling | Enforced at |
| --- | --- | --- | --- | --- |
| 8 | `POST …/api-keys` | `rl:api-key:create:user:<userId>` | `RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX` (10) | `api-key.service.ts:242` |
| 13 | `POST /v1/auth/login` | `rl:login:ip:<ip>`, `rl:login:email:<sha256(email)>` | `RATE_LIMIT_LOGIN_PER_IP_MAX` (10), `…PER_EMAIL_MAX` | `auth.service.ts:429,436` |
| 15 | `POST …/email-verification/request` | `rl:email-verification:request:user:<userId>`, `…:ip:<ip>` | `RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_PER_{USER,IP}_MAX` | `email-verification.service.ts:275,282` |
| 18 | `PATCH …/plan/demo` | `rl:plan:change:org:<orgId>` | `RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX` (10) | `plan.service.ts:209` |
| 19 | `POST …/invitations` | `rl:invitation:create:user:<userId>`, `…:org:<orgId>` | `RATE_LIMIT_INVITATION_CREATE_PER_{USER,ORG}_MAX` | `invitation.service.ts:392,396` |
| 22 | `POST /v1/invitations/accept` | `rl:invitation:accept:user:<userId>` | `RATE_LIMIT_INVITATION_ACCEPT_PER_USER_MAX` | `invitation.service.ts:563` |
| 24, 25 | `PATCH …/members/:id/role`, `DELETE …/members/:id` | `rl:member:mutate:user:<userId>` (shared) | `RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX` (30) | `member.service.ts:224,256` |
| 30 | `POST /v1/organizations` | `rl:org:create:user:<userId>` | `RATE_LIMIT_ORG_CREATE_PER_USER_MAX` (10) | `organization.service.ts:161` |
| 34 | `POST …/projects` | `rl:project:create:user:<userId>` | `RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX` (30) | `project.service.ts:259` |
| 36, 37 | `PATCH …/projects/:id`, `DELETE …/projects/:id` | `rl:project:mutate:user:<userId>` (shared) | `RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX` (60) | `project.service.ts:309,334` |

**Key dimensions.** Authenticated user id and/or organization id — trusted server-resolved identities, never client-supplied. Email appears only as a SHA-256 digest (`auth.service.ts:437`); raw tokens and raw email addresses never enter a limiter key.

**Redis failure behavior.** All buckets route through `enforceStoreAvailability(decision, rateLimitFailureMode)` (`lib/rate-limit.ts:57`). Production is configured `closed` — a store outage yields a generic 503, never a silent bypass. Development/test default `open`. Pinned by `mutation-throttle.test.ts:94` (fail closed) and `rate-limit.failure-mode.test.ts`.

**Registration path.** `server.ts` → `buildApp(options)` (`app.ts:186`) → `register<Module>Routes(app, { service, authenticator })`. Each service is constructed in `server.ts` with `rateLimiter` (the Redis-backed store), `rateLimits` (from typed config) and `rateLimitFailureMode`.

**Test evidence.** `organization/mutation-throttle.test.ts` (org create, member buckets, isolation, fail-closed, auth-before-limiter), `projects/project-throttle.test.ts` (create + update/delete shared bucket, cross-tenant 404), `api-keys/api-key-create-throttle.test.ts`, `entitlements/plan-throttle.test.ts` (per-org bucket, org isolation, permission-first), `invitations/invitation.throttle.test.ts` (create per user + per org, accept, permission-first), `auth/rate-limit.routes.test.ts` (login per IP + per email), `auth/email-verification.routes.test.ts:210`.

**Final action.** No code change. Dismissed individually as false positives, each comment naming the route, the limiter key, and the enforcing line.

### S22-RC-002 — Limiter enforced inside the API-key authenticator

**Alerts:** 11 (1)

**Source → sink.** `external-projects.routes.ts:46` registers `GET /v1/external/projects`; the handler calls `authenticator.authenticate(...)` at line 56 before any data access. CodeQL sees the authorization call and no limiter in the same module.

**Control.** `api-key.authenticator.ts:312-339` consumes two buckets as step 8 of the documented validation order, after auth correctness and before the actor is returned:

- `rl:ext:key:<apiKeyId>` — ceiling `RATE_LIMIT_EXTERNAL_PER_KEY_MAX` (120/60s)
- `rl:ext:org:<organizationId>` — ceiling `RATE_LIMIT_EXTERNAL_PER_ORG_MAX` (600/60s), short-circuited when the per-key bucket already rejected

A separate bucket, `rl:ext:auth-fail-events:ip:<ip>` (`api-key.authenticator.ts:175`), bounds durable `security_events` writes under an invalid-credential storm (ORG-PR-013).

**Why the placement is correct.** The limiter cannot key on a key id that has not been resolved yet. Placing it after resolution is what makes per-key accounting possible at all; the module comment at `api-key.authenticator.ts:49` states the invariant that auth correctness never depends on the limiter.

**Redis failure behavior.** `enforceStoreAvailability` with the configured mode; production fails closed with a generic 503 because "abuse controls on the machine surface must not silently disappear".

**Test evidence.** `external-projects.routes.test.ts:467` (per-key bucket returns RATE_LIMITED with a request id), `:162` (auth correctness independent of the limiter), `:558` (store outage never re-opens write amplification); `api-key.failed-auth-bounding.test.ts`; `api-key.failed-auth.integration.test.ts`.

**Final action.** No code change. Dismissed as false positive.

### S22-RC-003 — Read surfaces bounded by the global per-IP limiter

**Alerts:** 9, 14, 16, 17, 20, 23, 26, 27, 28, 29, 31, 32, 33, 35, 38, 39, 40 (17)

**Control.** `plugins/global-rate-limit.ts:41` registers an `onRequest` hook consuming `rl:global:ip:<request.ip>` against `RATE_LIMIT_MAX` (300) per `RATE_LIMIT_WINDOW_SECONDS` (60). It is registered in `app.ts:228` before any route, so it runs ahead of body parsing, authentication, and handler work for every route in the table. Only `/health`, `/ready` and `OPTIONS` are exempt (`global-rate-limit.ts:33,42`).

`request.ip` is trustworthy by construction: `trustProxy` is fixed at construction time from typed config (`app.ts:202-212`) and the schema makes "trust every peer" unrepresentable.

**Why CodeQL cannot see it.** The hook is registered on the root Fastify instance in a different module from every route. `js/missing-rate-limiting` reasons per handler and does not model Fastify's `onRequest` hook chain or plugin encapsulation.

**Per-alert abuse analysis.** Each of these 17 is a READ. None writes a durable row, sends email, or mints a credential, so none carries the amplification profile that earned the mutation surfaces their own buckets. Cost per call:

- 9, 20, 23, 31, 33 — single indexed keyset page, `limit` capped at `MAX_PAGE_LIMIT` = 100 (`packages/contracts/src/pagination.ts:13`).
- 32, 35 — single indexed row read scoped by org + id.
- 16, 17 — plan/entitlement snapshot resolution for one organization.
- 26, 27, 28, 29, 38, 39, 40 — static RBAC catalog; 38–40 serve a compile-time constant table with no query at all.
- 14 — `GET /v1/auth/me`: one JWT verification plus one user lookup.

Every one is bounded above by a single indexed query with a capped page size, which is what makes the global ceiling a sufficient control rather than a fig leaf. The audit read is the one member of this shape that is NOT so bounded, and it was therefore separated into `S22-RC-006` and fixed.

**Failure mode, stated honestly.** The global bucket fails OPEN on a store outage regardless of `RATE_LIMIT_FAILURE_MODE` (`global-rate-limit.ts:20-25`). During a Redis outage these 17 reads have no rate limit. The compensating controls are that `/ready` reports the instance unhealthy (removing it from rotation in production) and that every sensitive surface keeps its own fail-closed bucket. This is a deliberate, documented tradeoff from Sprint 19, not an oversight, and it is recorded as residual risk in the artifact package.

**Test evidence.** `plugins/global-rate-limit.test.ts` — limit enforcement with the standard envelope, per-IP isolation, `/health` + `/ready` exemption, `OPTIONS` exemption, and the documented fail-open behavior. `app.proxy-trust.test.ts` pins that `request.ip` honors only the configured trust.

**Final action.** No code change. Dismissed individually as false positives.

### S22-RC-004 — Idempotent, state-bounded revokes

**Alerts:** 10 (`DELETE …/api-keys/:apiKeyId`), 21 (`DELETE …/invitations/:invitationId`) (2)

These are mutations, so the global limiter alone would not be an adequate answer. The additional bound is a verified state invariant.

**Verified idempotence.**

- `api-key.repo.ts:199-222` — locks the row `FOR UPDATE` scoped by org + id; a missing or cross-tenant key is a uniform not-found; `if (target.revokedAt !== null) return { alreadyRevoked: true }` returns **before** `recordKeyEvent`. A second revoke writes nothing.
- `invitation.repo.ts:256-301` — locks the row scoped by org + id; `assertAcceptable(invitation, now)` throws for an already-revoked, accepted, or expired invitation, so `recordInvitationEvent` is unreachable on a repeat.

The durable-write count is therefore capped by the number of revocable resources, and creating those resources is itself throttled (`rl:api-key:create:user`, `rl:invitation:create:user` + `:org` — alerts 8 and 19). A loop cannot amplify audit rows.

**Residual cost, stated plainly.** A repeat revoke still costs one JWT verification, one membership/permission resolution, one entitlement check, and one locking `SELECT`. That cost is bounded by the global per-IP bucket and, for the same target row, self-serializing on the row lock. It is not materially different from the read surfaces in `S22-RC-003`, which is why no additional bucket was added.

**Provenance.** This is the analysis recorded in the ORG-PR-032 resolution (Sprint 19): "Only the revokes (invitation, API key, session) remain deliberately unthrottled: a revoked resource cannot be revoked twice, so their durable writes are capped by creation — which is itself throttled." Sprint 22 re-verified the claim against the repository code rather than accepting it, and it holds.

**Test evidence.** `api-key.routes.test.ts` and `invitation.routes.test.ts` cover the idempotent-revoke and cross-tenant-not-found paths.

**Final action.** No code change. Dismissed as false positives with the state-bound evidence in the comment.

### S22-RC-005 — `onSend` response hook is not a route handler

**Alerts:** 41 (1)

`plugins/security-headers.ts:49-74` is an `app.addHook('onSend', …)` callback that sets response headers. It registers no route, reads no body, performs no authorization, and executes no query. CodeQL's route-handler model matches the `(request, reply) => …` shape and misclassifies it.

The conditional the query most likely reads as authorization is `request.protocol === 'https'` (line 65), an HSTS emission guard. There is no authorization decision anywhere in the hook.

Rate limiting this hook is not a meaningful operation: it runs on the way OUT of every response, including the 429 that a limiter itself produces.

**Test evidence.** `plugins/security-headers.test.ts` covers the header set, the HSTS production/protocol conditions, and the no-store policy on credential-bearing paths.

**Final action.** No code change. Dismissed as false positive.

### S22-RC-006 — Confirmed defect: unbounded-cost audit read

**Alerts:** 12 (1) — **the one true positive in the `js/missing-rate-limiting` set.**

**Source → sink.** `audit.routes.ts:41` registers `GET /v1/organizations/:organizationId/audit-events`; the handler authenticates, then calls `service.listAuditEvents(...)`, which reaches `audit.repo.ts:39 listAuditEvents`.

**Why this one is a real defect while the other 16 reads are not.** Every other list endpoint costs at most one indexed page. This one does not. `audit.repo.ts:59-66` builds the `targetId` filter as an OR across five JSONB metadata keys:

```
metadata ->> 'targetProjectId'    = $targetId  OR
metadata ->> 'targetKeyId'        = $targetId  OR
metadata ->> 'targetInvitationId' = $targetId  OR
metadata ->> 'targetMembershipId' = $targetId  OR
metadata ->> 'membershipId'       = $targetId
```

No index covers those expressions. `ix_security_events_org_created_id` (`packages/db/src/schema/auth.ts:317`) orders the scan but cannot satisfy the predicate, so PostgreSQL walks the organization's slice of `security_events` in keyset order and filters row by row. A `targetId` that matches nothing reads the **entire** slice before returning an empty page — and `security_events` has no retention or cleanup policy (ORG-PR-015, still open), so that slice grows without bound.

The permission gate (`audit_events.read`) and the independent entitlement gate (`audit_log_access`) bound WHO may ask. Neither bounds HOW OFTEN. Before this sprint the only ceiling was the global per-IP bucket — which is coarse (300/60s), shared with all other traffic from that IP, and keyed on IP rather than on the actor or tenant whose data is being scanned.

**Risk.** An authenticated member of a Business-plan organization can issue repeated `?targetId=<nonexistent>` requests, each forcing a full scan of that tenant's event history. Distributed across IPs, the global bucket does not constrain it at all.

**Fix.** Per-actor and per-tenant fixed-window ceilings in the service, placed after both gates and immediately before the query they protect (`audit.service.ts`):

- `rl:audit:read:user:<userId>` — `RATE_LIMIT_AUDIT_READ_PER_USER_MAX`, default 60/60s
- `rl:audit:read:org:<organizationId>` — `RATE_LIMIT_AUDIT_READ_PER_ORG_MAX`, default 240/60s

Per-user is consumed first so a runaway client is attributed to itself before it eats the shared tenant allowance. Both use the existing `RateLimiter` interface, the existing `enforceStoreAvailability` failure-mode policy (production: fail closed), and the existing `rateLimitedError()` envelope. No parallel throttling mechanism was introduced.

**Code changed.**

- `packages/config/src/schema.ts` — `RATE_LIMIT_AUDIT_READ_{WINDOW_SECONDS,PER_USER_MAX,PER_ORG_MAX}`
- `packages/config/src/index.ts` — `rateLimit.auditRead` typed group
- `apps/api/src/modules/audit/audit.service.ts` — `AuditReadRateLimits`, `enforceReadRateLimit`, enforcement as step 4 of the documented order
- `apps/api/src/server.ts` — wires the Redis limiter, config ceilings, and failure mode
- `apps/api/src/modules/audit/testing/build-audit-test-app.ts` — optional test overrides
- `.env.example` — documented defaults

**Test evidence.** `apps/api/src/modules/audit/audit-read-throttle.test.ts` (8 cases): per-user ceiling with the standard envelope; the expensive `targetId` path specifically bounded; per-user isolation between members; the per-organization ceiling firing across distinct members who are each under their own limit; cross-organization isolation; legitimate traffic below the ceiling still succeeding; non-member still sees 404 not 429; non-entitled member still sees 403 not 429 and never consumes the allowance.

**Follow-up.** Registered as **ORG-PR-055** (found and fixed in Sprint 22). A durable fix for the underlying scan cost — an index on the target-id metadata keys, or retention under ORG-PR-015 — remains open and is recorded there. The limiter bounds exploitation; it does not make the query cheap.

**Final action.** Fixed. The alert is nonetheless expected to persist, because the new limiter lives in the service layer exactly like `S22-RC-001`, so it is dismissed with a comment pointing at the fix and the test.

### S22-RC-007 — SHA-256 over high-entropy opaque tokens

**Alerts:** 3 (`api-key-secret.ts:56 hashApiKeySecret`), 4 (`opaque-token.ts:32 hashOpaqueToken`) (2)

CodeQL reports "Password … is hashed insecurely" because it classifies any credential-shaped value reaching a fast hash as a password. Neither value is a password.

**Generator and entropy.**

| Alert | Generator | Entropy source | Size | Encoding |
| --- | --- | --- | --- | --- |
| 3 | `generateApiKeySecret()` (`api-key-secret.ts:60`) | `node:crypto randomBytes` | 32 bytes = 256 bits | base64url, 43 chars |
| 4 | `generateOpaqueToken()` (`opaque-token.ts:19`) | `node:crypto randomBytes` | 32 bytes = 256 bits | base64url, 43 chars |

Alert 4's flagged flow names `generatePasswordResetToken` — that function (`password-recovery.token.ts:16`) is a one-line delegation to `generateOpaqueToken()`. The word "password" in its name is what draws the query; the value is a server-minted reset token, never a user-chosen password.

**Hash purpose, storage, comparison.** The digest is a *lookup key*. Only the hash is persisted; the raw token is delivered once out of band (email or a single API response) and is unrecoverable from the database. Verification is a unique-index equality lookup on the digest, not a per-candidate verification loop. A salted, slow KDF would make that lookup impossible — you cannot index a value you must recompute per row.

**Why fast is right here and wrong for passwords.** The digest defends against an exfiltrated database being replayed against the live system. It does not need to defend against offline brute force, because there is nothing to brute-force: guessing a 256-bit CSPRNG value is not a computational problem. A human-chosen password has perhaps 20–40 bits of real entropy, which is exactly why it needs Argon2id.

**The password invariant, verified across every credential flow.** `hashPassword` / `verifyPassword` (`packages/auth-core/src/password.ts`) are the only password primitives and are Argon2id-only (`ALGORITHM_ARGON2ID = 2`, memoryCost 19456, timeCost 2, parallelism 1). Every non-test call site:

| Flow | Call site | Primitive |
| --- | --- | --- |
| Registration completion | `registration.service.ts:496` | `hashPassword` (Argon2id) |
| Password reset completion | `password-recovery.service.ts:355` | `hashPassword` (Argon2id) |
| Password change | `auth.service.ts:747` | `hashPassword` (Argon2id) |
| Login verification | `auth.service.ts:463` | `verifyPassword` (Argon2id) |
| Login timing-equalization dummy | `auth.service.ts:179, 448` | `hashPassword` / `verifyPassword` (Argon2id) |
| Password change — current check | `auth.service.ts:709, 727` | `verifyPassword` (Argon2id) |
| Email change — current check | `auth.service.ts:788` | `verifyPassword` (Argon2id) |

No password reaches `createHash('sha256')` on any path. No raw token is persisted where the design requires hash-only storage.

**Non-password SHA-256 uses, catalogued so none is mistaken for password hashing.**

| Use | Site | Input | Purpose |
| --- | --- | --- | --- |
| Token lookup digest | `opaque-token.ts:32` | 32-byte CSPRNG token | unique-index lookup |
| API key lookup digest | `api-key-secret.ts:56` | 32-byte CSPRNG secret component | unique-index lookup |
| Second-order rate-limit key | `invitation.token.ts:42`, `password-recovery.token.ts:33`, `registration.token.ts:35` | `sha256(sha256(rawToken))` | limiter key that is deliberately NOT the storage digest, so a leaked Redis key cannot be replayed as a DB lookup |
| Email limiter-key digest | `auth.service.ts:437`, `registration.service.ts:367`, `password-recovery.service.ts:263` | normalized email | keeps raw addresses out of Redis keys |
| Migration snapshot | `tooling/lib/migrations-snapshot.mjs:37` | file content | content hash, not security |

**Test evidence.** `packages/auth-core/src/hashing-invariants.test.ts` (new, 8 cases) pins the boundary as behavior: the password hash always carries the `$argon2id$` prefix and never equals or contains the SHA-256 digest of the password; `verifyPassword` rejects a SHA-256 digest presented as a stored hash (proving no fast-hash fallback exists); password hashes are salted and therefore unusable as lookup keys; opaque tokens decode to exactly 32 bytes; token digests match `^[0-9a-f]{64}$` and never carry the Argon2 prefix. Also `password.test.ts`, `opaque-token.test.ts`.

**Final action.** No production code change (the tests are new). Dismissed as false positives.

### S22-RC-008 — Modulo over an alphabet that divides the byte domain

**Alerts:** 1 (`api-key-secret.ts:39`, API key display id), 2 (`ids.ts:53`, public entity ids) (2)

**The arithmetic.** Both sites map a CSPRNG byte into the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which is 32 characters. The byte domain is 256 values and **256 = 32 × 8 exactly**. Every character is therefore the image of precisely 8 of the 256 byte values, and the mapping is perfectly uniform. There is no modulo bias — not "small" bias, none.

For contrast, the bias the query exists to catch: a 30-character alphabet would map bytes 0–15 to residues 0–15 nine times over 0–255 while the rest map eight times, making the first sixteen characters ~12.5% more likely.

**Sensitivity of the outputs.** Neither is a security token. Alert 2 produces public entity identifiers (`user_…`, `org_…`) that appear in URLs and logs by design. Alert 1 produces the API key *display id* — explicitly documented as "a short, high-entropy, NON-secret identifier … safe to show in lists/logs" (`api-key-secret.ts:11-12`). The API key's actual secret component never touches this path: it is `randomBytes(32).toString('base64url')` (`api-key-secret.ts:62`), raw CSPRNG bytes with no alphabet mapping at all.

So the finding is a false positive twice over: the arithmetic is unbiased, and the outputs are not security tokens.

**Change made anyway, and why.** The original comment read "Uniform enough for opaque IDs" — which understates the guarantee and, worse, frames an exact property as an approximation. That is the kind of note that lets a future engineer drop `U` from the alphabet for readability and silently introduce real bias. The logic (duplicated verbatim in two files) was extracted to `packages/shared/src/random-alphabet.ts`, where `assertUniformAlphabet` **enforces** the divisibility precondition at module load. Editing either alphabet to a non-divisor length now fails at import instead of degrading quietly.

This is a clarity and invariant-hardening change, not an attempt to move the scanner: the modulo still exists, in one place, and both alerts are still expected to report.

**Test evidence.** `packages/shared/src/random-alphabet.test.ts` (8 cases) — deterministic, not statistical: the Crockford alphabet has length 32 and `256 % 32 === 0`; every divisor length is accepted; lengths 3, 30, 31, 33, 62 and the empty alphabet are rejected with an actionable message; output length is exact; output draws only from the supplied alphabet. No probabilistic distribution assertions were added, so nothing here can fail nondeterministically. `ids.test.ts` and `api-key-secret.test.ts` continue to pass unchanged, proving behavior was preserved.

**Final action.** Refactor for clarity + enforced invariant; alerts dismissed as false positives with the divisibility proof.

### S22-RC-009 — Demo bootstrap emitted the one-time API key secret

**Alerts:** 6 (`demo-seed.mjs:256`), 7 (`demo-seed.mjs:258`) (2) — successor alert 45.

Both sinks were `console.log` in `tooling/demo-seed.mjs`, a local developer CLI that drives the public API to produce a presentable demo state. It is not part of the deployed API and ships no runtime code.

**Both are now Fixed defects.** This group was triaged twice, and the second pass reversed the first. The reversal is recorded here rather than smoothed over, because it is the instructive part.

**Alert 7 — fixed in the first pass.** The line printed a second copy of the secret inside a ready-to-run `curl` example. The secret was already printed two lines above, so the duplicate carried no information while doubling the number of places it could be captured from. Replaced with a placeholder. Closed as `fixed` on the next analysis.

**Alert 6 — accepted, then rejected and fully remediated.**

*First pass (superseded).* The remaining print was classified as an accepted residual risk on the reasoning that the API returns a key secret exactly once, so printing it to the terminal *was* the delivery channel and the demo depended on it. A loopback-target guard (`assertLocalTarget`) was added as a compensating control, bounding where a misdirected run could emit a secret.

*Why that was wrong.* The argument treated the delivery channel as fixed and then protected it. It should have questioned it. Three things make the accepted-risk framing indefensible:

1. The Definition of Done condition — *no raw secrets, tokens, passwords, Authorization headers, cookies, or SMTP credentials are logged* — admits no accepted-risk exception. A finding that contradicts a mandatory condition is not a candidate for acceptance.
2. A terminal is a logging sink like any other. Scrollback, screen shares, terminal recordings, tmux/CI capture, and `> out.txt` all retain it. "Interactive terminal, not an aggregated log pipeline" understated that.
3. The loopback guard bounds *where* the credential is emitted. It never stopped it being emitted. A compensating control that does not remove the exposure cannot discharge a condition that forbids the exposure.

*Second pass (final).* The delivery channel was changed instead:

- `ensureApiKey` was **removed** from `demo-seed.mjs`. The bootstrap creates no API key and touches no `/api-keys` endpoint, so no secret is produced for it to print.
- The summary block emits identifiers and locations only. The owner password — a published local-only literal — is **pointed at** (`see docs/demo-walkthrough.md`) rather than reprinted, so no output path in the tool carries a credential of any kind.
- Key creation moved to the **existing** authenticated web-demo surface (`/app/api-keys`), where the backend returns the raw secret exactly once to the requesting browser. Walkthrough steps 12–13 already documented that path, so no new product feature, API route, or contract was added.
- The loopback guard was **kept**, with its documentation corrected. It no longer stands between a secret and a terminal; it prevents seeding published demo credentials into a shared environment and mutating organization, plan, project, and invitation state somewhere real.

**Substitutions explicitly rejected**, because each defeats the scanner without changing the exposure: switching to `process.stdout.write`, base64-encoding the secret, printing it via an error, embedding it in a command example, printing the whole HTTP response, writing it to a file, or suppressing the query.

**Why the Pino redaction backstop is not the answer here.** `lib/logging.ts` redacts `apiKeySecret` and `apiKey` on the API's structured logger. It has no bearing on these alerts: `demo-seed.mjs` is a separate process using `console.log` with string interpolation, which bypasses path-based redaction entirely. Claiming coverage from the backstop would be false — recorded explicitly so no future reader assumes otherwise.

**Test evidence.**

- `tooling/demo-seed.output.test.ts` (7 cases) runs the REAL script as a child process against a stub API on loopback and inspects everything it actually wrote to stdout and stderr — deliberately end-to-end rather than a source scan, so a credential emitted through *any* output primitive would be caught. It proves: exit 0 with empty stderr; **no** request to any `/api-keys` path; no owner password, access token, or key secret in the captured output, asserted both by literal value and by shape (`/orgistry_[A-Z0-9]{6,}_/`, `/Bearer\s+\S+/`, `/[A-Za-z0-9_-]{40,}/`) so a *different* credential also fails the test; the org id, sign-in address, and web-demo URL still printed; the operator directed to the API Keys page; the rest of the flow intact (login, org list/create, plan change, three projects, invitation); and a non-loopback target refused before any request is issued.
- **Negative control:** temporarily reinstating API-key creation plus a secret print made exactly two cases fail (`creates no API key…`, `emits no password, token, or key secret…`); the file was then restored byte-identically. The test has teeth rather than passing vacuously.
- `tooling/demo-target-guard.test.ts` (5 cases) unchanged and still green.

**Final action.** Alert 7 fixed in the first pass; alerts 6/45 fully remediated in the completion iteration. **ORG-PR-056 is closed, and no accepted clear-text logging risk remains in this repository.**

### S22-RC-010 — Log helper flagged on a non-secret field

**Alerts:** 5 (`demo-seed.mjs:75`) (1)

**Sink.** `function log(step, message) { console.log(\`[${step}] ${message}\`) }`.

**Actual source.** The flagged flow is "sensitive data returned by access `apiKey`". The only `log()` call in the file touching an `apiKey` object is line 233 (post-edit line number shifted by the guard import):

```js
log('apikey', `Created API key "${created.apiKey.name}" — secret shown once below.`)
```

The value interpolated is `created.apiKey.name` — a user-supplied display label, here the literal `'Demo Read Key'` (line 229). The secret is `created.secret`, a *sibling* property, which this call does not touch; `ensureApiKey` returns it to the caller instead. CodeQL flags the property access because its parent object is named `apiKey`, without distinguishing which field is read.

**Confirmation that no other call passes a secret.** Every other `log(...)` call in the file passes org names, project names, invitee email addresses, and status strings. The secret reaches `console.log` only at the two `S22-RC-009` sites, which are separate alerts — so this is not a duplicate of them.

**Final action.** No code change. Dismissed as false positive naming the exact field (`created.apiKey.name`) that makes the sink safe.

## Triage log

Chronological record of triage iterations, classification changes, and evidence added.

**Iteration 1 — preflight.** Verified branch `main`, HEAD `c33a150f` (identical to the specification baseline), clean working tree, in sync with `origin/main` (0 ahead, 0 behind). `gh auth status` authenticated as `DanielRosenberg00`; repository public. Retrieved 41 open alerts via the code-scanning API; distribution matched the specification exactly. Confirmed 0 dismissed and 0 fixed alerts, and that analysis `1528655701` on `refs/heads/main` produced them. Recorded that no branch protection and no rulesets exist — the enforcement gap that Stage 8 has to close.

**Iteration 2 — rate-limit architecture mapping.** Read `app.ts`, `plugins/global-rate-limit.ts`, `lib/rate-limit.ts` and all 13 flagged route modules. Established that route handlers are uniformly thin and that all per-actor limiters live in the service layer, which explains the entire `js/missing-rate-limiting` cluster. Built the route → limiter map.

**Iteration 3 — initial assessment revised twice.**
- Alert 11 (`GET /v1/external/projects`) was initially assessed as a genuine gap: the route module contains no limiter and the surface is machine-facing. Reading `api-key.authenticator.ts` overturned this — the per-key and per-org buckets are enforced at lines 312-339. Reclassified to `S22-RC-002`, covered by an endpoint-specific control.
- Alerts 10 and 21 (revokes) were initially assessed as unthrottled mutations. The ORG-PR-032 resolution claims they are state-bounded; rather than accept that, the claim was verified against `api-key.repo.ts:220` and `invitation.repo.ts:279`. Both short-circuit before their event write, so the claim holds. Reclassified to `S22-RC-004`.

**Iteration 4 — the one true positive.** Alert 12 (audit read) was initially grouped with the other reads. Reading `audit.repo.ts` showed the `targetId` filter compares against five un-indexed JSONB expressions, so unlike every other read its cost is not bounded by page size. Cross-checked `packages/db/src/schema/auth.ts:311-317`: no index covers those expressions. Cross-checked ORG-PR-015: `security_events` has no retention policy, so the scanned range is unbounded. Reclassified as a confirmed defect and fixed.

**Iteration 5 — hashing invariant.** Traced every `hashPassword` / `verifyPassword` / `createHash` call site outside tests. Confirmed Argon2id-only for all seven password paths and catalogued all five non-password SHA-256 uses. No defect found; alerts 3 and 4 confirmed as high-entropy-token false positives. Added `hashing-invariants.test.ts` so the boundary is pinned as behavior rather than asserted in prose.

**Iteration 6 — random bias.** Computed `256 % 32 = 0` for both flagged sites; both are exactly uniform. Noted that the `ids.ts` comment ("Uniform enough") understated an exact property. Extracted the duplicated mapping to `random-alphabet.ts` with an enforced precondition, and added deterministic tests. Classification unchanged (false positive); confidence raised from "reviewed" to "enforced by assertion".

**Iteration 7 — logging.** Traced all three sinks. Alert 5 resolved to `created.apiKey.name` (a display label) — false positive. Alert 7's duplicate secret print removed. Alert 6 confirmed as a real dataflow that is also the credential's only delivery channel; classified as accepted risk and given a loopback-target guard rather than being relabelled a false positive.

**Iteration 8 — validation and reconciliation.** Full local validation run; all 41 alerts reconciled against the classification totals; group counts summed to 41 independently of the master table.

**Iteration 9 — a flaky test surfaced by the remote gate.** The first remote CI run on the Sprint 22 commit (`9733b880`) failed while `pnpm validate` had passed locally. The failure was NOT caused by any Sprint 22 change: `audit.routes.test.ts > redacts sensitive top-level and nested metadata keys` seeded two-character sentinel values (`'pw'`, `'rt'`) and asserted their absence from `JSON.stringify(item).toLowerCase()`. That payload contains generated Crockford base32 ids, so any id containing `PW` or `RT` lowercased into a false "leak". Measured over 100,000 generated organization ids: `RT` appears in 2.37%, `PW` in 2.43%, either in **4.77%** — a pre-existing flake rate of at least one run in twenty, which local runs had simply been lucky enough to miss.

Fixed by replacing every sentinel with a long, distinctive value (`nested-password-value`, `refresh-token-value`, …) and, while there, asserting the two sentinels that had been seeded but never checked (`apiKeySecret`, `invitationTokenHash`) — so the test now proves more than it did before. Re-ran the suite 15 consecutive times: 15/15 green. This is exactly the class of defect the sprint specification warns against ("avoid probabilistic tests that can fail nondeterministically"), and it mattered here because a gate that fails randomly cannot be made a required check.

**Iteration 10 — the accepted risk was reopened and removed.** A completion review held the sprint against its own Definition of Done condition — *no raw secrets, tokens, passwords, Authorization headers, cookies, or SMTP credentials are logged* — and found alert 6/45 in violation. The first pass had accepted the credential print because it was the key's only delivery channel, and had added a loopback-target guard as compensation. That reasoning does not survive the condition: a terminal is a logging sink, and a guard that bounds *where* a secret is emitted does not stop it being emitted.

The fix was to change the delivery channel rather than defend it: `ensureApiKey` was removed from the bootstrap, the owner password print became a pointer to documentation, and key minting moved to the web demo's existing API Keys page, where the backend hands the raw secret to the requesting browser exactly once. The loopback guard was kept — it still prevents seeding published demo credentials into a shared environment — with its documentation corrected to stop claiming it protects a secret print.

Alert 6's classification changed from *Accepted residual risk* to *Fixed defect*, taking the sprint to **zero accepted clear-text logging risks**. A new end-to-end test (`demo-seed.output.test.ts`) runs the real script against a stub API and inspects captured stdout/stderr, and a negative control confirmed it fails when key creation is reinstated.
