# Sprint 17 Artifact Package — Recovery and Credential Management

Official closing artifact for Sprint 17. Executed 2026-07-20 against `main`
(base revision `b1d3403`, tree clean at sprint start). Companion design doc:
[credential-management.md](../credential-management.md).

## 1. Implementation summary

Sprint 17 completed Orgistry's core credential-management lifecycle:

- **Password recovery** — public `POST /v1/auth/password-recovery/request`
  (enumeration-safe by contract: identical `{ accepted: true }` for existing,
  unknown, and inactive accounts, and on internal persistence or mail
  failure; issuance serialized per user; persist-and-commit before send) and
  public
  `POST /v1/auth/password-recovery/complete` (raw token + new password in the
  body; one `FOR UPDATE` transaction swaps the hash, consumes the token,
  invalidates siblings, and revokes every session and refresh token; no
  session is issued).
- **Authenticated password change** — `POST /v1/auth/change-password` with
  mandatory current-password re-auth, current-password-reuse rejection, and
  the keep-current-session policy (every other session + its refresh tokens
  revoked transactionally).
- **Authenticated email change** — `POST /v1/auth/change-email`
  (direct-change policy) with mandatory current-password re-auth; the
  transaction swaps the address, clears `email_verified_at`, and invalidates
  outstanding verification tokens; a fresh verification email goes
  best-effort to the NEW address.
- **Registration de-enumeration (partial)** — per-normalized-email-digest
  rate limit on registration plus a durable
  `auth.registration_duplicate_email` probe event; the 409 conflict itself is
  retained (see §11).
- **Shared password policy** — one `newPasswordSchema` contract parsed by
  registration, reset completion, and password change.
- **Frontend** — `/auth/forgot-password`, `/auth/reset-password` (Sprint 16
  fragment-token hygiene), and the authenticated `/app/account`
  account-security surface (email + verification state + resend, password
  change, email change), with a login-page entry link.
- **Credential-lifecycle security events and rate limits** throughout, on the
  existing sanitized-event and Redis fixed-window infrastructure.

## 2. Findings closed or advanced

| Finding | Status (evidence-based) |
| --- | --- |
| ORG-PR-004 — No password recovery flow | **Closed** |
| ORG-PR-039 — No password-change / email-change flows | **Closed** |
| ORG-PR-030 — User enumeration on registration | **Materially advanced** (still open) |

Statuses, evidence, and residuals are recorded in the
[findings register](findings-register.md) (Resolution/Status lines on each
entry).

## 3. Files changed

**Database & migrations:** `packages/db/src/schema/auth.ts`
(`password_reset_tokens`), `packages/db/src/schema/index.ts`,
`packages/db/src/index.ts`, `packages/shared/src/ids.ts` (`prtok` prefix),
`packages/db/migrations/0009_lovely_karnak.sql` (+ meta journal/snapshot).

**Backend:** new module files
`apps/api/src/modules/auth/password-recovery.{token,email,errors,types,repo,service,routes}.ts`;
extended `auth.service.ts` (changePassword/changeEmail, register per-email
limit + probe event), `auth.repo.ts` (two new transactional methods),
`auth.routes.ts`, `auth.types.ts`, `auth.errors.ts`, `security-events.ts`,
`email-verification.service.ts` (`sendEmailChangeVerificationEmail`),
`app.ts`, `server.ts`; config in `packages/config/src/{schema,index}.ts` and
`.env.example`; test-infra fix in
`apps/api/src/modules/mail/testing/fake-smtp-server.ts` (socket error
handler — closes an intermittent full-suite ECONNRESET flake).

**Tooling:** `tooling/check-schema-drift.mjs` +
`tooling/lib/migrations-snapshot.mjs` + `tooling/check-schema-drift.test.ts`
(+ a `tooling/**/*.test.ts` entry in `vitest.config.ts`). The drift check now
implements its documented contract — content before-vs-after generation —
instead of `git status`, which misreported a correctly generated but
uncommitted migration as drift (and reported in-sync committed state
misleadingly). Detection strength is unchanged and now unit-tested; a
genuine-drift probe (schema table added without regeneration) was verified to
fail the check.

**Contracts:** `packages/contracts/src/auth.ts` (Sprint 17 section +
`newPasswordSchema`), `error-codes.ts` (three reset-token codes),
`index.ts`.

**Frontend:** new `apps/web-demo/src/pages/{ForgotPasswordPage,ResetPasswordPage,AccountSecurityPage}.tsx`;
extended `App.tsx`, `AppShell.tsx`, `LoginPage.tsx`.

**Tests:** new `password-recovery.routes.test.ts`,
`credential-change.routes.test.ts`, `password-recovery.integration.test.ts`,
`testing/in-memory-password-recovery-repo.ts`, web-demo
`password-recovery.test.tsx`, `account-security.test.tsx`; extended
`packages/contracts/src/auth.test.ts`, `rate-limit.routes.test.ts`,
`build-auth-test-app.ts`, `in-memory-auth-repo.ts`,
`in-memory-email-verification-repo.ts`.

**Documentation:** new `docs/credential-management.md` and this artifact;
updated `README.md`, `api-surface.md`, `api-conventions.md`,
`auth-foundation.md`, `email-and-verification.md`, `security-model.md`,
`web-demo.md`, `demo-walkthrough.md`, `validation.md`,
`known-limitations.md`, `roadmap.md`, `evaluation-guide.md`, and
`production-readiness/{README,findings-register,production-roadmap,launch-checklist,product-gap-analysis,production-scorecard}.md`.

## 4. Database changes and migration

New table `password_reset_tokens` (migration `0009_lovely_karnak.sql`,
generated by `drizzle-kit`, schema-drift clean): `id` (`prtok_` prefixed),
`user_id` FK → `users.id`, `token_hash` (SHA-256 of the raw token — raw
values never persisted), `expires_at`, `used_at` (consumed),
`invalidated_at` (retired unused), `created_at`. Unique index
`uq_password_reset_tokens_token_hash` (lookup + insert-race guard); index
`ix_password_reset_tokens_user_id` (active-token invalidation, future
retention sweeps). Deliberately separate from `email_verification_tokens`
(different question, blast radius, TTL, and retention). No request metadata
(IP/UA/link) is stored on the row — the security-events seam owns sanitized
context. Migration applied from scratch by `pnpm validate:integration`
(migration-from-scratch suite + live API tests) against PostgreSQL 16.

## 5. API surfaces added or changed

| Endpoint | Auth | Contract |
| --- | --- | --- |
| `POST /v1/auth/password-recovery/request` | none | `{ email }` → `{ accepted: true }` always |
| `POST /v1/auth/password-recovery/complete` | none | `{ token, newPassword }` → `{ reset: true }`; errors `PASSWORD_RESET_TOKEN_INVALID` 404 / `_EXPIRED` 410 / `_USED` 409 |
| `POST /v1/auth/change-password` | Bearer | `{ currentPassword, newPassword }` → `{ success: true }`; wrong current password → `INVALID_CREDENTIALS` **400** |
| `POST /v1/auth/change-email` | Bearer | `{ currentPassword, newEmail }` → `{ user }`; duplicate → `EMAIL_ALREADY_REGISTERED` 409 |

Registration request/response contracts are unchanged (the per-email limiter
returns the standard `RATE_LIMITED`). Three new error codes; no existing code
changed meaning. Standard envelopes throughout.

## 6. Reset-token security summary

32-byte CSPRNG opaque tokens; SHA-256 hash-only persistence; short TTL
(`PASSWORD_RESET_TTL_SECONDS`, default 1 h); single-use with explicit
`used_at`/`invalidated_at` lifecycle; sibling invalidation on every new
generation and on completion; fragment-only link transport
(`/auth/reset-password#token=…`); token accepted only in the request body;
raw tokens/hashes never appear in responses, routes, query strings, logs,
security events, or persisted rows (asserted by dedicated hygiene tests).
Completion rate-limiting keys on a second-order digest (hash of the storage
hash), so neither the raw token nor the DB lookup value enters Redis.
**Mail ordering is persist-and-commit before send:** the recovery email is
handed to `AccountMailer` only after the token hash has durably committed —
every emailed token was persisted first. This is not a liveness guarantee
for sent links: a concurrent or subsequent recovery request supersedes them
(exactly one generation survives issuance; older emails then carry an
invalidated token — expected single-generation behavior, not leakage). A
persistence failure sends no email; a mail failure leaves a harmless
persisted token (unknown, expiring, retired by the next generation). After
schema validation and rate limiting succeed, account lookup, token
persistence, mail delivery, and recovery-request event recording cannot
change the generic public response — a thrown lookup (e.g. database outage)
is swallowed inside the same boundary (`outcome: lookup_failed`).
**Event attribution:** every request-endpoint event is anonymous
(null user/session, coarse outcome metadata, no email or account reference —
submitting an email authenticates nobody; the schema has no subject field,
so request events are deliberately not account-linked). Successful
completion is attributed to the resolved user by single-use-credential proof
(the verification-completion convention); rejections are anonymous.

## 7. Transaction and concurrency summary

- Reset issuance: the transaction locks the USER row (`SELECT … FOR UPDATE`)
  before invalidate-then-insert — plain invalidate-then-insert is not
  race-safe under `READ COMMITTED`. Concurrent recovery requests may each
  send an email, but exactly one generation is usable after they settle;
  proven against live PostgreSQL (concurrent-generation integration test:
  one active row, loser invalidated and rejected with
  `PASSWORD_RESET_TOKEN_USED`, password unchanged by the loser).
- Reset completion: `SELECT … FOR UPDATE` on the token row serializes
  concurrent attempts; classification, password swap, token consumption,
  sibling invalidation, and session/refresh revocation are one transaction.
  Exactly one of two concurrent completions succeeds — proven in-memory
  (route suite) and against live PostgreSQL (integration suite).
- Password change: hash swap + other-session revocation + refresh revocation
  in one transaction (`changePasswordKeepingCurrentSession`).
- Email change: address swap + verification clear + verification-token
  invalidation in one transaction; the unique index on `normalized_email` is
  the authoritative duplicate guard (violation mapped to the registration
  conflict).
- Argon2id hashing runs BEFORE transactions, never under a row lock.

## 8. Session and refresh-token invalidation summary

- **Reset:** ALL of the user's sessions revoked (reason `password_reset`) and
  ALL refresh tokens of all their sessions revoked, in the completing
  transaction. No new session issued. Old access tokens fail at the existing
  server-side session revalidation; old refresh cookies classify as reuse.
- **Password change:** every session except the caller's revoked (reason
  `password_changed`) with the refresh tokens of the revoked sessions; the
  caller's session and refresh chain keep working (verified by refresh after
  change in the integration suite).
- **Email change:** sessions untouched by design (identity re-proved via
  current password; the credential did not change).

## 9. Password-change policy

Current password mandatory (verified against the stored Argon2id hash);
current-session identifier taken exclusively from the verified access-token
context; new password parsed by the shared policy; new-equals-current
rejected by verifying the candidate against the existing hash; wrong current
password → `INVALID_CREDENTIALS` at 400 with a `password_change_rejected`
event.

## 10. Email-change and verification policy

Direct change (no pending-email architecture — none exists in the repo, and
verification is advisory). Current password mandatory, checked before any
duplicate lookup. Committed change always clears verification and kills old
verification tokens transactionally; a fresh verification generation is sent
best-effort to the new address using the Sprint 16 never-throw semantics
(failure recorded, resend available; account remains usable unverified).
Consistency behavior on mail failure is documented in
[credential-management.md](../credential-management.md).

## 11. Registration de-enumeration status

**Materially advanced, not closed.** Shipped: per-email-digest registration
rate limit (counted before lookup, identical for known/unknown addresses — no
oracle in the limiter) and a durable probe event per duplicate attempt
(anonymous actor, null user id, coarse `reason` metadata — no email, digest,
or victim reference; the unproven caller is never represented as the account
owner). The
409 `EMAIL_ALREADY_REGISTERED` remains distinguishable: registration
synchronously returns a live session, so a duplicate cannot be answered
uniformly without fabricating credentials or a verification-required
registration redesign (explicitly out of sprint scope). The residual
disclosure, the rationale, and the follow-up are recorded on ORG-PR-030 in
the findings register and in the design note in
[credential-management.md](../credential-management.md). The public recovery
flow is fully enumeration-safe; login hardening and invitation email-match
enforcement are unchanged (regression-covered).

## 12. Rate-limit summary

New Redis-backed fixed-window buckets (shared auth window; fail-open policy
unchanged and still documented as a limitation): recovery request per IP
(default 5/min) + per email digest (3/min); recovery completion per IP
(10/min) + per token digest (5/min); registration per email digest (3/min);
change-password per user (5/min); change-email per user (3/min). Exceedance
uses the standard `RATE_LIMITED` envelope and bucket-name-only events. No
sensitive material in any key.

## 13. Frontend summary

Login page links to `/auth/forgot-password` (generic confirmation, identical
for any input; validation/rate-limit errors surfaced safely).
`/auth/reset-password` mirrors the Sprint 16 verification page's token
hygiene: fragment capture once → immediate history scrub → transient
component memory → body-only submission → token dropped after settle; never
storage, never DOM, never a query string; distinct invalid/expired/used/
missing states; success links to login. `/app/account` shows the current
email + backend-derived verification state with resend, and hosts the
password-change and email-change forms (current password required; password
fields cleared after every submission; current user re-fetched after email
change).

## 14. Tests added

- `password-recovery.routes.test.ts` — 28 tests: enumeration uniformity
  (status + body identical for known/unknown/disabled/soft-deleted; an
  eight-scenario injected-failure matrix — event-store failure across
  active/unknown/disabled/soft-deleted states, token-persistence failure,
  mail failure, thrown account lookup, and lookup + event-store failure
  combined — proving byte-identical acceptances), anonymous request-event
  attribution across all six outcomes (incl. `lookup_failed`), completion
  attribution (user by token proof on success, anonymous on rejection),
  persist-and-commit-before-send ordering (no email on persistence failure;
  undelivered persisted token retired by the next generation; delivered link
  matches the committed hash), hash-only storage, generation replacement,
  full reset behavior (old password dead, new alive, no session issued, all
  sessions/refresh revoked, old cookies dead),
  reuse/expired/unknown/disabled-account rejection, concurrent completion
  (exactly one success), shared password policy, all four limiter buckets,
  event + store secret/email hygiene sweeps.
- `credential-change.routes.test.ts` — 23 tests: password change (auth
  required, current password mandatory/wrong/ reuse rejected, hash rotation,
  session policy incl. refresh behavior, events, per-user limit), email
  change (auth, wrong password, invalid/same/duplicate email, verification
  clear + re-issue, old-token invalidation under mail failure, current-user
  consistency, events, per-user limit), registration duplicate behavior
  (contract, anonymous/null-attribution probe event with no email or victim
  reference, per-email throttle, no-oracle counting).
- `password-recovery.integration.test.ts` — 8 DB-backed tests: durable
  hash-only rows, generic unknown-email handling, concurrent GENERATION
  under the user-row lock (two parallel requests → exactly one active row,
  loser invalidated and unable to reset, winner completes within the same
  test, no token/hash in responses or events), `FOR UPDATE` concurrent
  completion (self-contained: issues its own fresh generation), durable
  session/refresh revocation, SQL-layer password-change policy, durable
  email change + verification reset, durable sanitized events. The two
  concurrency tests share no state and are independently runnable by
  test-name filter (verified: each passes alone against a fresh database).
- `tooling/check-schema-drift.test.ts` — 6 tests pinning the drift check's
  content-comparison contract (identical/added/changed/removed, nested
  paths, missing-directory bootstrap).
- Web-demo `password-recovery.test.tsx` (15) and `account-security.test.tsx`
  (10): the §13 behaviors including storage/DOM/query-string token hygiene
  and fragment scrubbing.
- `packages/contracts/src/auth.test.ts` — Sprint 17 contract pinning incl.
  the shared-policy cross-surface test.
- Extended `rate-limit.routes.test.ts` fixtures for the new bucket fields.

## 15. Validation evidence

Executed 2026-07-20 on this machine (final acceptance-iteration runs; exit
codes observed directly, not via pipelines):

- `pnpm validate` — **exit 0.** Typecheck all 7 workspaces; ESLint clean;
  `pnpm test` 632 unit tests / 59 files (includes the drift-check helper
  suite); `pnpm test:web` 59 tests / 8 files; production Vite build;
  `pnpm db:check` PASS (content-comparison contract — the sprint's
  uncommitted-but-in-sync migration `0009` correctly passes; a genuine-drift
  probe was separately verified to fail). An earlier full-suite run had
  surfaced a pre-existing intermittent unhandled `ECONNRESET` from the fake
  SMTP test server; fixed in-sprint (socket error handler in test infra) and
  not observed since.
- `pnpm validate:integration` — **exit 0** (test-DB reset + migrations from
  scratch; 13 db + 52 api integration tests, including the 8-test Sprint 17
  suite with both concurrency proofs). **Environment note:** the local
  machine's port 5432 is held by a foreign PostgreSQL, so the run used a
  dedicated PostgreSQL 16 container on port 55432 via
  `DATABASE_URL=postgres://…@localhost:55432/orgistry` and
  `TEST_DATABASE_URL=postgres://…@localhost:55432/orgistry_test` overrides —
  same engine and migrations, alternate port only.
- `git diff --check` — **exit 0** (no whitespace errors).
- Test-isolation proof (exit 0 each, name-filtered against a fresh
  database): the concurrent-generation test alone (1 passed / 7 skipped),
  the concurrent-completion test alone (1 passed / 7 skipped), and the full
  file (8 passed).
- Targeted (all exit 0): recovery routes (28, incl. the eight-scenario
  injected-failure matrix and attribution tests), credential-change (23),
  security-events (10), email-verification regression (21), invitation
  regression (38 across 3 files), drift-check helpers (6) — 126 tests in one
  run; web-demo suite 59/8 including `password-recovery.test.tsx` (15) and
  `account-security.test.tsx` (10); standalone `pnpm db:check` exit 0.

## 16. Documentation index

New: [credential-management.md](../credential-management.md) (developer doc,
architectural notes, contracts/invariants, integration notes, limitations,
test commands — §23.1–23.5 of the sprint spec) and this artifact.

§23.6 changelog — the sprint ran in two iterations. **Iteration 1**
(implementation): full backend/frontend/tests/docs; test-layer defects fixed
during validation (fake-SMTP socket flake, a timestamp-coercion test bug, a
concurrency-winner assumption in the integration suite). **Iteration 2**
(review-driven refinement): (a) reset-token issuance made concurrency-safe
per user (user-row `FOR UPDATE`; invalidate-then-insert alone was not
race-safe under `READ COMMITTED`) with a live-PostgreSQL
concurrent-generation proof; (b) recovery mail ordering pinned to
persist-and-commit-before-send (previously deliver-then-persist) with
persistence-failure and mail-failure tests; (c) the registration-probe
security event corrected to anonymous actor / null user id / no email
(previously victim-attributed with the normalized email in metadata), and
the recovery unknown-email event's normalized email removed; (d) the
schema-drift check corrected to its documented content-comparison contract
(unit-tested) — resolving the `pnpm validate` failure without committing or
weakening detection; (e) surgical comment trims and full documentation
resynchronization. **Iteration 3** (final acceptance refinement): (a) ALL
recovery-request events made anonymous (null user/session; previously the
resolved-account outcomes carried the user id and 'user' actor) and unified
behind one no-throw recorder, so an event-store failure can never become an
existence oracle — with a five-scenario injected-failure test matrix proving
byte-identical acceptances; (b) completion attribution made deliberate and
tested (user by token proof on success, anonymous on rejection); (c)
mail-ordering claims corrected — "emailed link always corresponds to a
committed, usable token" overstated the guarantee; the invariant is
persisted-before-send, and sent links may be superseded by a newer
generation; (d) the two integration concurrency tests decoupled (no shared
token state; each self-contained and verified independently runnable by
name filter). **Iteration 4** (micro-refinement): the account LOOKUP was the
one step still outside the request endpoint's enumeration-safe boundary — a
thrown `findUserByNormalizedEmail` now yields the same generic acceptance
(best-effort anonymous `lookup_failed` event), the failure matrix grew to
eight scenarios (incl. lookup failure, lookup + event-store failure, and
explicit soft-deleted coverage), and all "all internal failures" claims were
made literally true.

Canonical documents touched by Sprint 17, with each one's role:

| Document | Role |
| --- | --- |
| [credential-management.md](../credential-management.md) (new) | Canonical design + developer reference: flows, transactions/locking, attribution taxonomy, invariants, de-enumeration note, limitations, test commands |
| [security-model.md](../security-model.md) | Current security posture — credential-management + updated limiter sections |
| [email-and-verification.md](../email-and-verification.md) | Mail delivery-failure policies incl. the recovery persist-before-send ordering |
| [api-surface.md](../api-surface.md) | Route index — four new endpoints |
| [api-conventions.md](../api-conventions.md) | New error codes; the 400-vs-401 current-password convention; limiter list |
| [auth-foundation.md](../auth-foundation.md) | Historical Sprint 2 reference — Sprint 17 update banner + resolved items |
| [web-demo.md](../web-demo.md) | Frontend pages, token-hygiene invariants 12–14, endpoint map |
| [demo-walkthrough.md](../demo-walkthrough.md) | Reviewer flow — recovery/account-security step |
| [validation.md](../validation.md) | Validation matrix — drift-check contract, Sprint 17 integration proofs |
| [troubleshooting.md](../troubleshooting.md) | Drift-check failure guidance (content-comparison semantics) |
| [known-limitations.md](../known-limitations.md) | Honest scope boundary — de-enum residual, timing, event-linkage limitation |
| [roadmap.md](../roadmap.md) / [evaluation-guide.md](../evaluation-guide.md) / `README.md` / `.env.example` | Reviewer-facing status, feature list, config reference |
| [findings-register.md](findings-register.md) | Authoritative findings status (Sprint 17 update block + three entry resolutions) |
| [production-roadmap.md](production-roadmap.md) | Sprint 17 completion + ORG-PR-030-first sequencing note |
| [launch-checklist.md](launch-checklist.md) | LC-3.1 done; LC-3.2 advanced |
| [product-gap-analysis.md](product-gap-analysis.md) | Capability rows + divergence note |
| [production-scorecard.md](production-scorecard.md) | Sprint 17 status block (4 P1 remaining) |
| [README.md](README.md) (production-readiness) | Post-audit status + next-work recommendation |
| This artifact | Official Sprint 17 closing record |

## 17. Scope-control confirmation

No out-of-scope system was introduced: no MFA/passkeys/OAuth/SAML/SCIM, no
device management or account deletion/export, no support-admin recovery, no
notification framework, no deployment/IaC/Docker app images, no secrets
manager or JWT rotation, no backup/PITR, no observability or incident
tooling, no bounce/complaint/suppression automation, no STARTTLS or external
SMTP validation, no role-transition or quota-concurrency work, no global
rate-limit redesign, no security headers or `trustProxy`, no dependency
upgrades. ORG-PR-001/002/005/006 were not touched and remain open. The only
changes outside the sprint's nominal surface are two validation-integrity
fixes: the one-line test-infra fix in `fake-smtp-server.ts` (intermittent
ECONNRESET) and the schema-drift-check correction in `tooling/` (the check
now implements its documented before/after-generation contract; detection
strength unchanged, unit-tested, genuine drift verified to still fail).

## 18. Known limitations

- Rate limits still fail open when Redis is unavailable (system-wide
  policy, unchanged).
- External SMTP delivery remains unvalidated (ORG-PR-002); recovery emails
  are evidenced against the in-memory mailer and locally via Mailpit.
- Bounce/complaint/suppression automation remains absent.
- Recovery-request response TIMING is not fully equalized (existing accounts
  trigger a synchronous send); bounded by rate limits, documented in
  [credential-management.md](../credential-management.md).
- Registration de-enumeration is partial (§11).
- Broader edge security (headers, `trustProxy`, global limits) remains open
  (Sprint 18 scope).
- Orgistry remains **not staging-ready and not production-ready**.

## 19. Remaining P1 blockers

ORG-PR-001 (deployment automation), ORG-PR-002 (external production email
validation), ORG-PR-005 (backup/PITR/restore), ORG-PR-006 (secrets
management/rotation). All are production-envelope gaps; none is product
code.

## 20. Final readiness classification

**C — Ready to continue production implementation.**
**Not ready for staging. Not ready for production.**

## 21. Confidence assessment

Evidence-based confidence per dimension. "High" means directly proven by
automated tests against real infrastructure where applicable; it is NOT a
claim of operational production confidence — no staging environment, real
provider, or production traffic has exercised any of this.

| Dimension | Confidence | Basis |
| --- | --- | --- |
| Functional (request → email → reset → login) | **High** | Full-flow route tests + live-PostgreSQL integration suite; frontend flows tested against the real contracts |
| Token security (hash-only, single-use, expiry, invalidation) | **High** | Dedicated hygiene sweeps over responses/events/stores; SQL-level assertions on `used_at`/`invalidated_at`; unique-index lookup |
| Concurrency (issuance + completion) | **High** | Both races proven against live PostgreSQL (`FOR UPDATE` user-row and token-row locks), each independently runnable; in-memory models mirror the invariants for unit tests |
| Session/refresh revocation | **High** | Behavioral proofs (old access token 401, old cookie rejected, surviving session refreshes) + durable SQL assertions on revocation reasons |
| Enumeration safety (request endpoint) | **High** | Eight-scenario injected-failure matrix proves byte-identical acceptances across account states and internal failures; residual TIMING difference documented (Medium if timing attacks are in scope) |
| Frontend token hygiene | **High** | Tests pin fragment capture, history scrub, body-only transport, no storage/DOM/query-string persistence — under jsdom, not a real browser (no E2E harness exists in the repo) |
| Regression (auth, verification, invitations, orgs) | **High** | Full unit + integration suites green, incl. 38 invitation and 21 verification regression tests; no contract changed for existing flows |
| Validation integrity | **High** | All gates exit 0 directly (no pipelines); drift check now content-based and unit-tested; genuine-drift probe verified to fail |
| Operational/production behavior | **Low** | Deliberately unclaimed: external SMTP delivery, real-browser behavior, deployment, backup, and secrets management are all unvalidated (open P1 blockers) |

## 22. Readiness for next sprint

- **Sprint 17's implementation is complete** and its Definition of Done is
  met (validation evidence in §15).
- **ORG-PR-004 is closed. ORG-PR-039 is closed. ORG-PR-030 is materially
  advanced and still open.**
- **Recommended next work: a focused account-lifecycle sprint that closes
  ORG-PR-030 before Sprint 18 — Edge and Application Security Hardening.**
  The Sprint 17 specification requires the account-lifecycle delta to be
  closed before broad edge hardening, and full ORG-PR-030 closure needs the
  verification-first registration redesign (generic public response;
  existence signaled only via email) — a deliberate product-behavior change
  that deserves its own narrowly scoped sprint. Sprint 18 (security headers,
  `trustProxy`, global/edge rate limiting, `invitations/inspect` throttling,
  per-actor mutation limits, logger redaction —
  ORG-PR-010/011/012/013/032/033/052) follows once that follow-up lands.
  This artifact does not design the follow-up's implementation.
