# Sprint 18 Artifact Package — Verification-First Registration and Enumeration Closure

Closing artifact for **Sprint 18 — Verification-First Registration and
Enumeration Closure**, executed 2026-07-20 with a surgical **refinement pass
on 2026-07-21** (see the refinement record below). Companion to the
[findings register](findings-register.md) (ORG-PR-030 resolution), the
[production roadmap](production-roadmap.md), and the authoritative design
documentation in [docs/auth-foundation.md](../auth-foundation.md).

## Official completion areas

The five official Sprint 18 completion areas map to these sections:

| Official area | Section(s) |
| --- | --- |
| Implementation Summary | [§1](#1-implementation-summary) (detail: §3–§16) |
| Documentation Index | [§19](#19-documentation-index) |
| Confidence Assessment | [§23](#23-confidence-assessment) |
| Remaining Risks | [§21](#21-remaining-limitations-honest) + [§22](#22-remaining-p1-blockers) |
| Readiness for Next Sprint | [§24](#24-final-readiness-classification) + [§25](#25-recommended-next-sprint) |

Test/concurrency evidence: §17; demo-seed runtime evidence and exact final
validation results: §18; ORG-PR-030 closure justification: §2 (and the
finding's Resolution + Refinement notes in the
[findings register](findings-register.md)); scope control: §20.

## Refinement pass record (2026-07-21)

The accepted core architecture was left intact. The pass corrected two
remaining Sprint 18 contract gaps and completed the missing runtime
validation:

1. **Invitation-bearing public registration made generic.** As first
   shipped, `POST /v1/auth/register` surfaced explicit invitation errors
   (`INVITATION_INVALID`, `INVITATION_EMAIL_MISMATCH`, `QUOTA_EXCEEDED`, …).
   Now every private invitation-validation failure returns the same generic
   `200 { accepted: true }` as every other registration — staging nothing,
   creating nothing, mutating no invitation, sending no email — with the
   translation centralized in one resolver (`resolveRequestInvitation`) and
   only a coarse anonymous internal outcome recorded. The dedicated
   invitation-INSPECT endpoint (contract unchanged) remains the invitation
   feedback channel. Proven by a ten-row public equality matrix (section 17).
2. **Invitation context preserved through the web demo.** A public
   invitation landing page (`/invitations/accept`) now inspects the emailed
   token, accepts directly for signed-in users, and hands transient
   invitation context to the register page for signed-out users, whose
   registration request carries `invitationToken` — with full raw-token
   hygiene (transient memory only, immediate URL/history scrubbing,
   body-only transport, dropped after the request is accepted).
3. **Demo seed runtime-validated** end to end against the real API +
   PostgreSQL + Redis + Mailpit (both the fresh registration-completion path
   and the idempotent login-first re-run), with explicit newest-first Mailpit
   message ordering for determinism. Sections 13, 17, 18, and 21 reflect the
   corrected state; the ORG-PR-030 closure evidence in section 2 was already
   account-existence-focused and is unaffected.

## 1. Implementation summary

Public registration was redesigned from a synchronous account-creating
endpoint into a **verification-first** flow. `POST /v1/auth/register` now
stages a *pending registration* and (where policy permits) emails a
single-use completion link; it answers one generic, contract-identical
acceptance for every post-validation account state and creates **no** user,
session, access token, refresh cookie, organization, or membership. The
account — user (created email-verified), personal workspace, founding Owner
membership, session, and first refresh token — is created exclusively by
`POST /v1/auth/registration/complete` in one database transaction, after the
raw emailed token has proven mailbox control. Invitation-based registration
is preserved under the same model with a documented completion-time
invitation-unavailable policy. Contracts, backend, database, frontend,
tooling, tests, and documentation were updated in the same execution.

## 2. Finding closure summary

- **ORG-PR-030 — User enumeration on registration: CLOSED.** The public
  account-existence oracle is removed, not merely bounded: no duplicate-email
  error remains on any public surface, and the register response (status,
  envelope, body, headers, cookies) is byte-identical across eligible new
  emails, existing active accounts, existing unverified accounts, disabled
  accounts, soft-deleted accounts, and internal mailer failures — proven by a
  direct equality-matrix test. A residual **timing** side channel is
  documented and accepted (section 21); it is not a response-contract oracle
  and does not reopen the finding.
- No other findings were closed. **ORG-PR-001, ORG-PR-002, ORG-PR-005, and
  ORG-PR-006 (all P1) remain open**, together with every other unresolved
  finding in the register.

## 3. Old registration behavior (retired)

- `POST /v1/auth/register` synchronously created user + personal workspace +
  Owner membership + session + refresh token, returned `201 { user, tokens }`
  and set the refresh cookie.
- A duplicate normalized email returned `409 EMAIL_ALREADY_REGISTERED` — the
  enumeration oracle (throttled and evented since Sprint 17, but
  distinguishable).
- New users started **unverified**; a best-effort verification email followed
  registration.

## 4. New registration behavior

```text
POST /v1/auth/register
→ validate payload (explicit VALIDATION_ERROR)
→ rate limits BEFORE any account lookup (per IP + per normalized-email digest)
→ hash the password (Argon2id) BEFORE anything state-dependent (timing)
→ ENUMERATION-SAFE BOUNDARY — from here every outcome answers identically
→ validate optional invitation INTERNALLY: any private failure (unknown/
  expired/revoked/accepted token, email mismatch, quota, resolver outage)
  → stage nothing, mutate nothing, send nothing, answer generically
→ eligible new email: invalidate prior generations, stage pending
  registration (hash-only token), send completion email (persist-then-send)
→ existing active account: no staging; rate-limited neutral guidance email
→ disabled / soft-deleted account: no staging; nothing sent
→ 200 { ok: true, data: { accepted: true } } — always

POST /v1/auth/registration/complete   body: { token }
→ rate limits (per IP + per token second-order digest)
→ hash token; lock pending row FOR UPDATE; classify (unknown/expired/used)
→ re-check no user exists for the email; re-check invitation where present
→ ONE transaction: user (email-verified) + personal workspace + Owner
  membership + default plan state + session + refresh token + invitation
  acceptance (savepoint) + pending consumption + sibling invalidation
→ set refresh cookie ONLY after commit
→ 201 { user, tokens, invitation: null | {status:'accepted'|'unavailable'} }
```

## 5. API surfaces changed

| Surface | Change |
| --- | --- |
| `POST /v1/auth/register` | Response is now `200 { accepted: true }`; no auth state; no duplicate-email error; moved to `registration.routes.ts` |
| `POST /v1/auth/registration/complete` | **New** public endpoint; returns the authenticated registration result |
| `POST /v1/auth/login`, refresh, logout, `/me`, sessions, change-password, change-email | Unchanged |
| Error codes | **New:** `REGISTRATION_TOKEN_INVALID` (404), `REGISTRATION_TOKEN_EXPIRED` (410), `REGISTRATION_TOKEN_USED` (409). `EMAIL_ALREADY_REGISTERED` now appears ONLY on the authenticated email-change flow. A superseded token deliberately reports `REGISTRATION_TOKEN_USED` (the established used/replaced mapping of the other token families) rather than a new code. |
| Contracts | `registerAcceptedResponseSchema`, `registrationCompleteRequestSchema`, `registrationInvitationOutcomeSchema`, `registrationCompleteResponseSchema` added in `@orgistry/contracts` |

## 6. Database and migration changes

- **New table `pending_registrations`** (migration
  `packages/db/migrations/0010_tiresome_thunderbird.sql`, purely additive):
  prefixed id (`preg_`), email, normalized_email, Argon2id `password_hash`,
  display_name, SHA-256 `token_hash`, nullable stable `invitation_id`
  (deliberately no FK — the invitations schema module already imports this
  one; a dangling reference settles as invitation-unavailable), expires_at,
  used_at, invalidated_at, created_at.
- **Indexes:** unique `uq_pending_registrations_token_hash` (completion
  lookup); `ix_pending_registrations_normalized_email` (replacement/sibling
  scans); partial unique `uq_pending_registrations_usable_email` on
  normalized_email `WHERE used_at IS NULL AND invalidated_at IS NULL`
  (structural one-usable-generation guard that never blocks historical rows);
  `ix_pending_registrations_expires_at` (future cleanup sweeps — **no cleanup
  scheduler was added this sprint**, by design).
- Migration applies from a clean database (proven by
  `migrate.integration.test.ts`, 13/13) and touches no existing rows — all
  existing users and seed/demo users are preserved.

## 7. Pending-registration lifecycle

A generation is usable only while `used_at IS NULL AND invalidated_at IS
NULL AND expires_at > now()`. The two terminal timestamps are never
overloaded: `used_at` = consumed by a successful completion; `invalidated_at`
= retired unused (superseded by a newer request for the same normalized
email, or retired as a sibling at completion). Issuance invalidates **all**
prior unused generations (expired or not) in the same transaction that
inserts the replacement, so exactly one generation is ever usable per
normalized email and older emailed links fail safely as
`REGISTRATION_TOKEN_USED`. Consumed/expired rows are retained; the expiry
index supports a later retention sweep without schema change.

## 8. Token lifecycle

The completion token reuses the shared opaque-token primitives
(`registration.token.ts`, mirroring password recovery): 32 bytes CSPRNG,
opaque, persisted **only** as a SHA-256 hash, 24 h TTL
(`REGISTRATION_COMPLETION_TTL_SECONDS`), single-use, invalidatable,
superseded by any newer request, never logged, never returned by any API,
never in event metadata. Delivery is exclusively the emailed fragment link
`/auth/complete-registration#token=<raw>` — never `?token=`, never a backend
URL path. Rate limiting keys on a second-order digest (hash of the storage
hash), never the raw token or the storage hash.

## 9. Transaction and concurrency design

- **Issuance** is serialized per normalized email by a PostgreSQL
  **transaction-level advisory lock** (`pg_advisory_xact_lock` over a hash of
  the normalized email — there is no user row to lock, which is the point of
  the flow). Invalidate-then-insert alone is not race-safe under READ
  COMMITTED; the lock makes concurrent requests queue, and the partial unique
  index is the structural backstop. DB-proven: 6 concurrent requests → 6
  rows, exactly 1 usable.
- **Completion** locks the pending row `SELECT … FOR UPDATE`; concurrent
  completions serialize and the losers observe `used_at` and classify as
  `already_used`. DB-proven: 6 concurrent completions → exactly one 201,
  five 409s, and exactly one user/org/membership/session/refresh-token row.
- **Atomicity:** user, workspace, membership, plan state, session, refresh
  token, invitation acceptance, pending consumption, and sibling
  invalidation commit or roll back together. The `users` unique index is the
  authoritative guard for the email-taken race (a violation rolls the whole
  transaction back and reports the non-disclosing invalid-token outcome).
  The refresh cookie is set only after commit. Provisioning reuses the shared
  seam (`resolveUniqueSlug`, `insertOrganizationWithOwnerMembership`) and the
  shared invitation acceptance seam — no duplicated policy.

## 10. Existing-account handling

Existing **active** account (verified or unverified): the same generic
acceptance; no pending registration, no duplicate user; a rate-limited
(default 1/window, silently skipped when throttled) neutral guidance email —
"someone attempted to register with this address; sign in or use password
recovery; if this wasn't you, no action required". The notice carries **no
token of any kind** and never creates a recovery or verification token.
Verification state is never disclosed and no verification token is minted
for an unverified account through this surface.

## 11. Disabled and soft-deleted account policy

Same generic acceptance; no pending registration, no duplicate user, and
**nothing is sent** — there is no documented reactivation policy to honor,
and no reactivation functionality was added. The internal security event
records the coarse `ineligible_account` outcome anonymously.

## 12. Invitation preservation and selected invalidation policy

The invitation UX is preserved end-to-end: invitation landing page →
inspect → register with `invitationToken` → generic acceptance → completion
email to the invited address → completion creates the account + personal
workspace, accepts the invited membership atomically, and issues the
session. Invitation context is validated at request time (lifecycle, email
match, quota) INSIDE the enumeration-safe boundary and never surfaces
publicly (refinement pass): a rejected invitation answers the same generic
acceptance, stages no pending registration, creates no user, mutates no
invitation, and sends no email — invitation feedback belongs exclusively to
the dedicated inspect endpoint, whose contract is unchanged. Only the
**stable invitation row ID** is persisted on the pending registration (never
the invitation token or its hash); the shared acceptance seam gained a
selector (`tokenHash` | `invitationId`) so both paths run the identical
validation/mutation sequence.

**Selected policy (the spec's preferred option):** at completion the
invitation is re-validated under a row lock **inside a savepoint**; if it
became unavailable (expired, revoked, accepted, quota reached, membership
conflict), only the acceptance rolls back — the account, personal workspace,
and session are still created and the response reports
`invitation: { status: 'unavailable' }`, never a silent drop. Rationale: the
user has proven the mailbox and set a password; destroying the proven
account because a third party revoked an invitation would punish the wrong
party, and fail-together was a property of the retired synchronous model,
not a product invariant. Tradeoff: the user may land in a personal workspace
without the expected organization — surfaced in the API contract, the
frontend copy, and the completion security event.

## 13. Frontend changes

- `/auth/register` shows one **generic check-email state** after submission
  (identical for every account state; explains a link will arrive *if the
  address can be used*; links to sign-in and password recovery; never
  initializes auth state, expects no user or token).
- **New `/auth/complete-registration`** page: fragment-only token capture
  into transient component memory, immediate history scrub, body-only
  submission, no localStorage/sessionStorage, never rendered, never in an
  API URL; handles missing/invalid/expired/used tokens and the
  invitation-unavailable outcome; on success adopts the authenticated
  session and navigates into the app. It waits for the boot-time session
  restore to settle before submitting so the (failing) restore can never
  clobber the freshly adopted session.
- `AuthProvider.register` no longer adopts a session (and accepts an
  optional `invitationToken` since the refinement pass); new
  `completeRegistration(token)` does. `tooling/demo-seed.mjs` drives the
  two-step flow reading the NEWEST completion link from the Mailpit API
  (explicit newest-first ordering for determinism).
- **Invitation onboarding UI (refinement pass):** the public
  `/invitations/accept` landing page (`InvitationPage`) — target of the
  invitation email — captures the raw invitation token once from the query
  string into transient memory, immediately scrubs the token-bearing URL
  from history, inspects it via the body-only inspect call, and either
  accepts directly (signed in) or hands `{ token, organizationName,
  invitedEmail }` to `/auth/register` in transient router state. The
  register page captures that state once, scrubs the history entry,
  prefills the invited address, sends the token only in the registration
  request body, and drops it from memory the moment the request is accepted
  (keeping only the organization name — context the inspect endpoint had
  already disclosed). The check-email copy is identical for valid and
  invalid invitations and never claims an invitation was applied or an
  email delivered.

## 14. Email templates and mailer integration

Two new `AccountMailer` messages (`registration.email.ts`, plain text, same
driver selection — mailpit/smtp/memory — no new mail subsystem):

1. **Completion email** — product identity, purpose, the fragment completion
   link, expiry context, ignore-if-not-requested guidance; optionally names
   the inviting organization (already public via invitation inspect). No
   passwords, hashes, internal IDs, or private organization data.
2. **Existing-account guidance email** — sign-in and forgot-password page
   links only; explicitly not a password-reset email; creates no token of
   any kind; no account/session/membership/organization details.

Ordering is persist-then-send (the password-recovery convention): every
emailed token was durably staged first; a mail failure is swallowed
(recorded internally) and never alters the public response.

## 15. Security-event changes

New catalog entries (old `auth.registration_succeeded` /
`auth.registration_duplicate_email` retired; historical rows keep their
names):

- `auth.registration_requested` — always **anonymous**, null user id (a
  probe against an existing account never references the victim's user id);
  metadata is a coarse `{ outcome, delivered }` only — no email, no digest,
  no token material, no URL.
- `auth.registration_completion_succeeded` — attributed to the newly proven
  user; metadata `{ invitation: 'none' | 'accepted' | 'unavailable' }`.
- `auth.registration_completion_rejected` — anonymous, coarse `reason`.

Sanitization is test-proven (no raw/hashed tokens, passwords, hashes,
emails, or URLs in any event, unit + DB-backed).

## 16. Rate-limit changes

Registration buckets moved from `config.rateLimit.auth` to a dedicated
`config.rateLimit.registration` group (same fixed window; digest-keyed —
no raw email or token in Redis keys):

| Bucket | Env | Default | Notes |
| --- | --- | --- | --- |
| Request per IP | `RATE_LIMIT_REGISTER_PER_IP_MAX` | 5 | before account lookup |
| Request per email digest | `RATE_LIMIT_REGISTER_PER_EMAIL_MAX` | 3 | before account lookup; bounds probing + mailbox flooding |
| Complete per IP | `RATE_LIMIT_REGISTRATION_COMPLETE_PER_IP_MAX` | 10 | new |
| Complete per token digest | `RATE_LIMIT_REGISTRATION_COMPLETE_PER_TOKEN_MAX` | 5 | new; second-order digest |
| Existing-account notice per email digest | `RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX` | 1 | new; INTERNAL — exceeding silently skips the email, never an error |

Rate limits execute **before** the account lookup (test-proven with a
lookup spy), and 429 is identical for all account states. The system-wide
Redis fail-open limitation remains (ORG-PR-009) and is documented, not
redesigned. Invitation registration requests are covered by the request
buckets, which run before invitation validation.

## 17. Tests added and updated

**New suites (authored this sprint):**

- `registration.routes.test.ts` (30 tests) — request behavior (no account
  state, hash-only staging, fragment link, no `?token=`, secret hygiene,
  anonymous events, mailer-failure acceptance), existing/unverified/
  disabled/soft-deleted policy, guidance email (no recovery token), the
  **public response-equality matrix** (direct `toEqual` across six states
  incl. mailer failure: status, body, set-cookie, auth header),
  rate-limits-before-lookup (lookup spy), digest-keyed limiter keys, bounded
  email generation, replacement semantics (exactly one usable generation;
  superseded fails / newest works), concurrent issuance, and completion
  (atomic provisioning, verified user, cookie-after-commit, body-only token,
  unknown/expired/used, one-of-N concurrent success, email-taken window,
  throttling).
- `registration.integration.test.ts` (7 tests, live PostgreSQL) — hash-only
  staging with no account state; **advisory-lock issuance concurrency**
  (6 concurrent → 1 usable); **`FOR UPDATE` completion race** (6 concurrent
  → exactly one 201 and exactly one of every resource); verified-account
  provisioning; DB-level supersession; no-orphan email-taken handling;
  anonymous vs user-attributed events.
- `apps/web-demo/src/test/registration.test.tsx` (12 tests) — generic
  check-email state, no premature auth, identical copy for all states,
  navigation, fragment capture/scrub, body-only transport, no storage, no
  DOM rendering, no token in URLs, success adoption + navigation,
  invitation-unavailable, missing/invalid/expired/used states.

**Updated suites (contract migration + new coverage):** every suite that
previously created users via the old synchronous register — 11 consumer
route suites (organization, org-rbac, dto-shape, member, rbac, project,
project-quota, plan, api-key, external-projects, audit), 6 auth-module route
suites (session-lifecycle, credential-change, email-verification,
password-recovery, rate-limit, security-events), 9 DB integration suites
(auth, session-lifecycle, email-verification, password-recovery,
organization, member, project, entitlement, invitation),
`invitation.routes.test.ts` (rewritten registration-with-invitation block:
two-step flow; revoked/expired/quota-at-completion → unavailable policy;
refinement pass: all request-time invitation rejections — unknown token,
mismatch with and without an existing account, quota — now assert the
generic acceptance with zero side effects, plus a **ten-row public equality
matrix** comparing status/body/set-cookie/auth headers across plain new
email, existing account, unknown token, mismatch±existing account, expired,
revoked, already-accepted, request-time quota, and an internal
resolver-failure row, with per-row no-side-effect and event-hygiene
assertions), and `auth.routes.test.ts` / `auth.integration.test.ts`. The
web demo adds `invitation-registration.test.tsx` (7 tests): landing-page
inspection → registration with safe context, `invitationToken` in the
register body (and absent from plain registration), generic check-email
state without authentication, raw-token hygiene (no DOM, no storage, no
URLs, dropped after acceptance), signed-in direct acceptance, and
generic-acceptance copy for dead invitations. All backend suites flow
through the shared helper `registerTestUser` (request → captured email →
completion), so the real contract is exercised everywhere. The
retired-event names are guarded absent; `config.test.ts` covers the new
config group.

## 18. Validation commands and exact results

Executed 2026-07-20 (initial) and re-executed 2026-07-21 after the
refinement pass (numbers below are the final refinement-pass results):

| Command | Result |
| --- | --- |
| `pnpm validate` (typecheck → lint → unit tests → web tests → web build → schema drift → whitespace) | **PASS** (exit 0) — unit: 60 files / 664 tests; web: 10 files / 78 tests; build OK; drift in sync; `git diff --check` clean |
| `pnpm validate:integration` (db reset + migrate-from-scratch + all integration suites) | **PASS** (exit 0) — `@orgistry/db` 13/13; `@orgistry/api` 11 files / 62 tests, incl. the registration concurrency suite |
| Targeted: `registration.routes.test.ts` | PASS 30/30 (incl. rejected-invitation generic acceptance) |
| Targeted: `registration.integration.test.ts` | PASS 7/7 (live PostgreSQL) |
| Targeted: `invitation.routes.test.ts` | PASS 34/34 (incl. the ten-row public equality matrix) |
| Targeted: web `registration.test.tsx` | PASS 12/12 |
| Targeted: web `invitation-registration.test.tsx` | PASS 7/7 |
| **Demo seed, case 1 (owner absent)** — `node tooling/demo-seed.mjs` against the running API + PostgreSQL + Redis + Mailpit | **PASS** — registration accepted → completion email read from Mailpit (newest-first) → completion → owner created email-verified with personal workspace (DB-verified: 1 user, 1 personal org, 1 consumed pending row) → team org + Pro plan + 3 projects + invitation + API key all created through the authenticated API |
| **Demo seed, case 2 (owner exists)** — immediate re-run | **PASS** — login-first succeeds, no re-registration; org/projects/invitation reused idempotently; API key correctly reported as existing |

**Environment note:** local port 5432 is held by a foreign PostgreSQL, so
all database-backed validation ran against a dedicated
`postgres:16-alpine` container on port 55432 with
`DATABASE_URL`/`TEST_DATABASE_URL` overridden accordingly (the documented
workaround for this workstation). This is an environment substitution, not
a code deviation; the same commands run unmodified where 5432 is free. The
demo-seed rows above ran against the real local stack: the API started with
the same `DATABASE_URL` override, Redis on 6379, and the long-running
Mailpit container on 1025/8025 as the configured mail driver.

## 19. Documentation index

Authoritative updates in this execution:

- [docs/auth-foundation.md](../auth-foundation.md) — the authoritative
  verification-first design (flows, transaction boundaries, locking,
  replacement semantics, account-state policy, invariants, timing tradeoff).
- [docs/api-surface.md](../api-surface.md), [docs/api-conventions.md](../api-conventions.md) — endpoint + error-code surface.
- [docs/email-and-verification.md](../email-and-verification.md) — registration no longer sends verification email; new templates.
- [docs/credential-management.md](../credential-management.md) — ORG-PR-030 design note updated to record closure.
- [docs/invitations.md](../invitations.md) — two-step invitation registration + unavailable policy + acceptance selector.
- [docs/web-demo.md](../web-demo.md), [docs/demo-walkthrough.md](../demo-walkthrough.md) — routes, flows, Mailpit steps, demo seed.
- [docs/security-model.md](../security-model.md), [docs/known-limitations.md](../known-limitations.md), [docs/session-lifecycle.md](../session-lifecycle.md), [docs/database-foundation.md](../database-foundation.md), [docs/validation.md](../validation.md), [docs/evaluation-guide.md](../evaluation-guide.md), README.md and related pages — consistency sweep.
- Production-readiness records: [findings-register.md](findings-register.md)
  (ORG-PR-030 Resolution), [README.md](README.md),
  [production-scorecard.md](production-scorecard.md),
  [production-roadmap.md](production-roadmap.md),
  [launch-checklist.md](launch-checklist.md) (LC-3.2),
  [product-gap-analysis.md](product-gap-analysis.md), and this artifact.

## 20. Scope-control confirmation

Explicitly **not** implemented (unchanged from before this sprint): security
headers; `trustProxy`; global/edge rate-limit architecture; Redis
fail-closed redesign; logger-redaction infrastructure; invitation-inspect
hardening beyond this flow's needs; role-transition enforcement; unrelated
quota-concurrency work; deployment automation, Dockerfiles, IaC, staging
infrastructure; secrets-manager integration; JWT key rotation; backup/PITR/
restore; production SMTP-provider validation; bounce/complaint/suppression
processing; MFA; passkeys; OAuth/social login; SAML; SCIM; account deletion;
data export; support-admin tooling; pending-registration cleanup scheduler.
No staging- or production-readiness claim is made anywhere in this sprint's
changes.

## 21. Remaining limitations (honest)

- **Timing side channel (residual, accepted):** the Argon2id cost is now
  spent identically on every request path (hash before lookup), but the
  eligible-new-email path still performs one insert and one synchronous
  mailer hand-off that other paths do not. No artificial delay was added
  (deliberate). Closing it needs out-of-band delivery (a queue); the
  pre-lookup rate limits bound sampling speed.
- **Redis rate limiting fails open** during a Redis outage (ORG-PR-009,
  unchanged, documented).
- **No cleanup scheduler** for consumed/expired `pending_registrations`
  rows; the expiry index makes a future sweep additive-only.
- **Email delivery is best-effort observability:** a user whose completion
  email is lost simply re-registers; internal outcomes are event-recorded
  but not alerted (ORG-PR-007 open).
- **Production SMTP provider remains unvalidated** (ORG-PR-002 open);
  bounce/complaint handling absent.
- ~~Demo seed E2E run not exercised~~ — resolved in the refinement pass: the
  seed was executed end to end against the real API + PostgreSQL + Redis +
  Mailpit for both the fresh-owner and existing-owner cases (section 18).

## 22. Remaining P1 blockers

ORG-PR-001 (deployment automation), ORG-PR-002 (production email provider
evidence), ORG-PR-005 (backup/PITR/restore), ORG-PR-006 (secrets
management) — all open, all in the production envelope.

## 23. Confidence assessment

High for the closed finding: the closure is proven by direct
response-equality tests, DB-backed concurrency tests over the real locking
paths, and secret-hygiene assertions — not by inspection alone. High for
regression safety: the entire pre-existing suite (unit + integration + web)
passes with the new contract exercised through every consumer suite via the
shared two-step helper, and the demo seed has now run end to end over the
real local stack (Mailpit driver). Medium for operational behavior under a
real external mail provider (delivery remains unvalidated — ORG-PR-002).

## 24. Final readiness classification

```text
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

ORG-PR-030 is closed **only because** the public registration oracle has
actually been removed and test-proven; this does not advance the P1
production envelope, and no staging or production readiness is claimed.

## 25. Recommended next sprint

**Sprint 19 — Edge and Application Security Hardening** (the roadmap's
edge-hardening sprint, renumbered after this inserted account-lifecycle
sprint): security headers, `trustProxy`, global/edge rate limiting,
invitation-inspect throttling, per-actor mutation limits, logger redaction.
The repository is ready to proceed: the account-lifecycle delta the
Sprint 17 sequencing note required is now closed, `pnpm validate` and
`pnpm validate:integration` both exit 0, and no registration follow-up
blocks edge hardening.
