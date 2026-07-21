# Auth Foundation (Sprint 2)

Orgistry's initial authentication foundation: durable auth persistence, Argon2id
password handling, JWT access tokens, and `register` / `login` / `me` endpoints,
plus durable security events. It is built so the next sprint could add secure
session lifecycle behavior without redesigning the user model, session model,
token primitives, claim shape, auth contracts, password hashing, email
normalization, or security-event persistence.

> **Sprint 3 update.** The secure session lifecycle that Sprint 2 prepared for —
> refresh-token issuance + rotation, the HttpOnly refresh cookie, reuse
> detection, logout, session listing/revocation, CSRF enforcement, and
> Redis-backed rate limiting — is now implemented. See
> [`session-lifecycle.md`](session-lifecycle.md). The "deferred" notes below
> describe the Sprint 2 state and are annotated where Sprint 3 changed them.

> **Sprint 4 update.** Registration now also provisions the registering user's
> **personal workspace** — an `organization` (`type=personal`) plus an active
> **Owner** `membership` — in the SAME transaction as the user, session, and
> first refresh token. The current behavior and design live in
> [`organization-foundation.md`](organization-foundation.md).

> **Sprint 17 update.** The credential lifecycle is now complete: password
> recovery (public request + reset completion over a dedicated hash-only
> `password_reset_tokens` table), authenticated password change and email
> change (both requiring the current password), registration duplicate-email
> throttling + probe events, and the shared `newPasswordSchema` password
> policy used by every password-setting surface. See
> [`credential-management.md`](credential-management.md).

> **Sprint 18 update.** Registration is no longer part of the auth service at
> all. The synchronous flow this document originally described — create user +
> workspace + session in one `POST /v1/auth/register` call, with a
> `409 EMAIL_ALREADY_REGISTERED` for duplicates — is **retired**, replaced by a
> verification-first, two-step flow in its own module. The authoritative
> current design is the
> [Verification-first registration (Sprint 18)](#verification-first-registration-sprint-18)
> section below. Login/refresh/logout/me/sessions/change-password/change-email
> are unchanged.

Sections A–F of this document are the **historical Sprint 2 reference**. They
describe the auth foundation as it was first shipped: register/login/
current-user with no refresh endpoint, logout, session listing/revocation, or
email-verification flow, and where registration created **only** a user and a
session. Later sprints extended this — the session lifecycle (Sprint 3),
personal-workspace provisioning (Sprint 4), the email-verification lifecycle
(Sprint 16; see [email-and-verification.md](email-and-verification.md)) — and
Sprint 18 replaced registration outright. Where the historical sections
describe the original state, §E records what has since been resolved and
points to the current authoritative docs. The Sprint 18 section that follows
is **current and authoritative**, not historical.

## Verification-first registration (Sprint 18)

This section is the authoritative, current registration design. `register()`
no longer exists on the auth service, and `POST /v1/auth/register` no longer
creates anything. Registration lives in its own module —
`apps/api/src/modules/auth/registration.{routes,service,repo,types,errors,email,token}.ts`
— and reuses the platform's existing primitives (opaque-token generate/hash,
Argon2id, the shared `AccountMailer`, the shared organization-provisioning and
invitation-acceptance seams, the sanitized security-event writer) rather than
inventing parallel ones.

### Why

The retired flow answered a duplicate email with `409
EMAIL_ALREADY_REGISTERED` — a public account-existence oracle that could not
be closed while registration synchronously returned a live session (the
tradeoff documented in
[credential-management.md](credential-management.md)). Verification-first
registration inverts the order: prove the mailbox first, create the account
second. That closes the oracle (the public response is identical for every
account state) and yields a second property for free: a completed user is
**email-verified at creation**, so registration no longer sends a
verification email at all.

### Endpoints

```
POST /v1/auth/register              -> 200 { accepted: true }        (always)
POST /v1/auth/registration/complete -> 201 { user, tokens, invitation }
```

Both are public. The first creates NO user, session, access token, refresh
cookie, organization, or membership — it only (for an eligible new email)
stages a pending registration and emails a completion link. Only the second
creates the account.

### The request flow (`POST /v1/auth/register`)

1. **Validate** the body through the shared contracts (`VALIDATION_ERROR` is
   explicit — malformed input is not masked; the password parses through the
   shared `newPasswordSchema`).
2. **Rate-limit before any account lookup**: per IP
   (`RATE_LIMIT_REGISTER_PER_IP_MAX`) and per normalized-email **digest**
   (`RATE_LIMIT_REGISTER_PER_EMAIL_MAX` — the email is hashed into the Redis
   key). Exceeding either is an explicit `429 RATE_LIMITED`.
3. **Hash the password (Argon2id) BEFORE anything state-dependent**, so the
   dominant CPU cost is identical on every path — including rejected-
   invitation paths — regardless of whether the email is registered.
4. **Validate an optional `invitationToken` INSIDE the enumeration-safe
   boundary, without ever surfacing the result.** Every private
   invitation-validation failure — unknown or malformed token, expired,
   revoked, or already-accepted invitation, email mismatch, request-time
   quota exhaustion, even a failing invitation resolver — collapses to the
   SAME generic acceptance: no pending registration is staged, no user is
   created, no invitation state is mutated, and **no email of any kind is
   sent** (not even the existing-account guidance — a failed invitation must
   not become a probe vehicle). Only a coarse anonymous event
   (`invitation_rejected` / `invitation_lookup_failed`, no token material, no
   email, no organization or invitation ids, no quota values) records the
   outcome internally. The dedicated **invitation-INSPECT endpoint remains
   the intended feedback channel** for a token holder — registration
   deliberately adds no second invitation-state oracle and no
   invitation-existence or email-match disclosure. The translation is
   centralized in one place (`resolveRequestInvitation` in
   `registration.service.ts`).
5. **Branch on account state — without ever changing the response** (see the
   staging and existing-account subsections below).
6. **Always return `200 { ok: true, data: { accepted: true } }`** — for
   eligible new emails, existing active accounts (verified or not), disabled
   accounts, soft-deleted accounts, and every internal failure (lookup,
   persist, mail). After validation and rate limiting succeed, nothing
   downstream can alter the public response (the password-recovery
   convention). The endpoint never returns `EMAIL_ALREADY_REGISTERED`; that
   code now exists ONLY on the authenticated change-email flow.

### Staging: the `pending_registrations` table

For an eligible new email the request stages a row (id prefix `preg_`;
migration `0010_tiresome_thunderbird.sql`): `email`, `normalized_email`, the
Argon2id `password_hash` (computed before the lookup, as above),
`display_name`, the SHA-256 `token_hash` of a fresh completion token, an
optional **stable `invitation_id`** (NEVER the invitation token or its hash),
`expires_at` (`REGISTRATION_COMPLETION_TTL_SECONDS`, default 24 h), and the
standard `used_at` / `invalidated_at` / `created_at` lifecycle columns.

**Issuance concurrency and replacement.** Issuance runs in ONE transaction
serialized per normalized email by a PostgreSQL transaction-level advisory
lock, and invalidates ALL prior unused generations before inserting the new
one — so after any set of concurrent requests settles, exactly one usable
generation exists per email. The structural backstop is the partial unique
index `uq_pending_registrations_usable_email` on `normalized_email WHERE
used_at IS NULL AND invalidated_at IS NULL`. Supporting indexes: unique
`uq_pending_registrations_token_hash`, `ix_pending_registrations_normalized_email`,
and `ix_pending_registrations_expires_at` (for a future cleanup sweep — no
cleanup scheduler exists yet).

**Persist-then-send.** The pending row commits before the completion email is
handed to the mailer (the password-recovery convention); a mail failure never
alters the public response — the user simply submits again and the fresh
generation supersedes the old.

**The completion email** ("Complete your Orgistry registration") links to
`<WEB_DEMO_URL>/auth/complete-registration#token=<raw>` — the token rides in
the URL **fragment**, never a `?token=` query string, so browsers never
transmit it in an HTTP request. The email states the expiry and
ignore-if-not-requested guidance, and — for invitation registrations — may
name the inviting organization (already public to the token holder via
invitation inspect).

### Existing, disabled, and soft-deleted accounts

- **Existing ACTIVE account (verified or not):** no pending row is staged and
  no duplicate user can arise. A neutral **guidance email** is sent to the
  address — "Someone attempted to register… sign in or use password recovery;
  if this wasn't you, no action is required" — under an internal throttle
  (`RATE_LIMIT_REGISTRATION_NOTICE_PER_EMAIL_MAX`, default 1 per window;
  exceeding it silently skips the email). It is NOT a password-reset email
  and never creates a recovery or verification token.
- **Disabled or soft-deleted account:** nothing is sent — no reactivation
  policy exists.
- None of this alters the public response.

### The completion flow (`POST /v1/auth/registration/complete`)

Accepts `{ token }` in the request **body only** (never a URL); throttled per
IP (`RATE_LIMIT_REGISTRATION_COMPLETE_PER_IP_MAX`, default 10) and per token
second-order digest (`RATE_LIMIT_REGISTRATION_COMPLETE_PER_TOKEN_MAX`,
default 5). Then, in ONE transaction:

1. `SELECT … FOR UPDATE` the pending row by token hash — concurrent
   completions serialize at the database; **exactly one of any set of
   concurrent completions succeeds**.
2. Re-check expiry, consumption, and that no user exists for the email.
3. Create the **user, email-verified at creation** — completing the emailed
   token IS the mailbox proof.
4. Provision the **personal workspace + founding Owner membership + default
   plan state** through the shared provisioning seam (the same seam the
   retired synchronous flow used).
5. Issue the **session and first refresh token** (hash-only) — session
   issuance happens only here, never at the initial request.
6. **Accept the stored invitation** where applicable (policy below).
7. Consume the pending row (`used_at`) and invalidate siblings.

The refresh cookie is set only AFTER the transaction commits. Response:
`201 { user, tokens, invitation }`, where `invitation` is `null` (no
invitation), `{ status: 'accepted' }`, or `{ status: 'unavailable' }`.

Errors describe token validity only: `REGISTRATION_TOKEN_INVALID` (404 —
unknown token OR the email was taken during the pending window, deliberately
indistinguishable), `REGISTRATION_TOKEN_EXPIRED` (410), and
`REGISTRATION_TOKEN_USED` (409 — consumed earlier or superseded by a newer
generation).

### Invitation policy at completion (a documented product choice)

At completion the invitation lifecycle, email match, duplicate membership,
and quota are re-checked by the shared acceptance seam under a row lock
INSIDE A SAVEPOINT. If the invitation has become unavailable
(expired/revoked/accepted/quota/…), ONLY the acceptance rolls back: the
account, personal workspace, and session still commit, and the response
reports `invitation: { status: 'unavailable' }` — the outcome is never
silently dropped. Rationale: the user has proven the mailbox and set a
password; destroying the account because a third party revoked an invitation
would punish the proven user. The alternative — fail together — was the OLD
synchronous model's behavior and is no longer a documented product
invariant. See [invitations.md](invitations.md).

### Security events

- `auth.registration_requested` — always ANONYMOUS with a null user id: an
  attempt against an existing account NEVER references the victim's user id.
  Metadata is coarse strings only — `{ outcome, delivered }` — never an
  email, digest, token, or URL.
- `auth.registration_completion_succeeded` — attributed to the newly proven
  user; metadata `{ invitation: 'none' | 'accepted' | 'unavailable' }`.
- `auth.registration_completion_rejected` — anonymous, coarse `reason` only.
- Retired: `auth.registration_succeeded` and
  `auth.registration_duplicate_email` (historical rows keep the old names).

### Config

`config.registration.completionTtlSeconds`
(`REGISTRATION_COMPLETION_TTL_SECONDS`, default 24 h) and
`config.rateLimit.registration.{requestPerIpMax, requestPerEmailMax,
completePerIpMax, completePerTokenMax, existingAccountNoticePerEmailMax}`.
The register limits MOVED out of `config.rateLimit.auth`.

### Frontend

`/auth/register` shows a generic check-email state after submission —
identical copy for every account state (and for valid and invalid
invitations alike; the page cannot know the difference and never claims an
invitation was applied or an email delivered); it links to login and
forgot-password and never authenticates. The new
`/auth/complete-registration` page (`CompleteRegistrationPage`) follows the
established token hygiene: fragment capture into transient memory, immediate
history scrub, body-only submission, no storage, never rendered; on success
it adopts the authenticated session and navigates into the app;
invitation-unavailable shows an explanation with a continue link;
missing/invalid/expired/used states are handled.

Invitation-aware registration flows through the invitation landing page
(`/invitations/accept`, `InvitationPage` — the target of the invitation
email): it captures the raw invitation token ONCE from the query string into
transient memory, immediately scrubs the token-bearing URL from history,
inspects it via the body-only `POST /v1/invitations/inspect` call (the
invitation-state feedback channel), and then either accepts directly (signed
in) or hands the token to `/auth/register` in TRANSIENT router state. The
register page captures that state once, scrubs it from the history entry,
prefills the invited address, sends the token ONLY in the registration
request body, and drops it from memory the moment the request is accepted —
keeping only the safe display context (organization name) the inspect
endpoint had already disclosed. The raw invitation token is never rendered,
stored, logged, or placed in any URL, and is never confused with the
registration-completion token.

### Invariants (must not change without a deliberate redesign)

- Initial registration (`POST /v1/auth/register`) never creates auth state —
  no user, session, access token, refresh cookie, organization, or
  membership.
- Initial registration never reveals duplicate-email state: one status, one
  body, for every account state and every internal failure.
  `EMAIL_ALREADY_REGISTERED` exists only on the authenticated change-email
  flow.
- Initial registration never reveals invitation state either: every private
  invitation-validation failure returns the same generic acceptance, stages
  nothing, mutates nothing, and sends nothing. Invitation feedback lives
  exclusively on the invitation-inspect endpoint.
- Only a valid completion token creates an account.
- Passwords are persisted only as Argon2id hashes; completion tokens only as
  SHA-256 hashes; the pending row never stores the invitation token or its
  hash (only the stable invitation id).
- At most one usable pending generation per normalized email
  (advisory-lock-serialized issuance + partial unique index); completion
  tokens are single-use.
- Completed users are email-verified at creation; registration sends no
  verification email.
- Session issuance happens only at completion, only after the transaction
  commits.
- The invitation lifecycle is re-checked at completion; an unavailable
  invitation never blocks account creation and is always reported in the
  response.
- Raw tokens, passwords, and hashes never appear in logs, responses,
  security-event metadata, or Redis keys (limiter buckets are digest-keyed).

### Known limitations (honest)

- Response TIMING on the register request is not fully equalized: the
  Argon2id cost is equalized by pre-lookup hashing, but the new-email path
  still performs one insert and one mailer hand-off. The pre-lookup per-IP
  and per-email-digest rate limits bound how fast the residual can be
  sampled.
- Redis rate limiting still fails open (system-wide policy).
- No cleanup scheduler for consumed/expired `pending_registrations` rows (the
  `expires_at` index exists for a future sweep).
- Production SMTP delivery remains externally unvalidated; there is no
  bounce/complaint handling.
- The project remains NOT staging-ready and NOT production-ready.

### Testing

`registration.routes.test.ts` (route-level, in-memory),
`invitation.routes.test.ts` (including a ten-row public equality matrix over
invitation states), and `registration.integration.test.ts` (live PostgreSQL:
advisory-lock issuance, `FOR UPDATE` completion race, savepoint invitation
semantics), plus the web demo's `registration.test.tsx` and
`invitation-registration.test.tsx`. The demo seed (`tooling/demo-seed.mjs`)
exercises the flow end to end over the public HTTP API by reading the
completion link from the Mailpit API — runtime-validated for both the fresh
registration-completion path and the idempotent login-first re-run.

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Argon2id hashing, JWT sign/verify, opaque-token generate/hash, email normalize, redaction | `packages/auth-core` |
| `users`, `sessions`, `refresh_tokens`, `email_verification_tokens`, `security_events` tables | `packages/db/src/schema/auth.ts` |
| Auth request/response DTOs, auth error codes | `packages/contracts/src/auth.ts`, `error-codes.ts` |
| Register / login / current-user workflows | `apps/api/src/modules/auth/auth.service.ts` |
| Drizzle persistence for auth | `apps/api/src/modules/auth/auth.repo.ts` |
| HTTP routes + request-context/Bearer parsing | `apps/api/src/modules/auth/auth.routes.ts` |
| Security event types + metadata sanitization | `apps/api/src/modules/auth/security-events.ts` |
| Access-token TTL + session TTL config | `packages/config` (`AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_SESSION_TTL_SECONDS`) |

### Endpoints

```
POST /v1/auth/register   -> 201 { user, tokens }   (RETIRED in Sprint 18 — see above)
POST /v1/auth/login      -> 200 { user, tokens }
GET  /v1/auth/me         -> 200 { user }     (requires Authorization: Bearer <token>)
```

All responses use the standard success/error envelopes and carry a request id.

### How it works

**Register (as shipped in Sprint 2; RETIRED in Sprint 18).** The original flow
validated the body (Zod) → normalized the email → rejected a duplicate
normalized email with `409 EMAIL_ALREADY_REGISTERED` → Argon2id-hashed the
password → **atomically** provisioned the account (user + personal workspace
organization + active Owner membership + session + first refresh token, in one
transaction, as of Sprint 4) → signed a short-lived access token → wrote
`auth.registration_succeeded` → returned `{ user, tokens }`. The
normalized-email unique index was the authoritative guard for the concurrent
case. **None of this is current behavior**: Sprint 18 replaced it with the
verification-first flow described in
[Verification-first registration (Sprint 18)](#verification-first-registration-sprint-18).
`POST /v1/auth/register` no longer creates a user, workspace, session, or
cookie, and never returns `EMAIL_ALREADY_REGISTERED` (that code survives only
on the authenticated change-email flow); the atomic provisioning now happens
at registration completion.

**Login.** Validate body → normalize email → look up user. On any failure
(unknown email, inactive account, wrong password) the response is the **same**
generic `401 INVALID_CREDENTIALS`. For an unknown email the service still runs a
password verification against a dummy hash so response timing does not betray
account existence. Success creates a session, signs an access token, and writes
`auth.login_succeeded`; failures write `auth.login_failed`.

**Current user.** Parse the `Bearer` token → verify it with `auth-core`
(signature, expiry, and `type: 'access'`) → load the user and confirm it is
active and not soft-deleted → load the bound session and confirm it belongs to
that same user and is neither revoked nor expired → return the public
`AuthUser`. Any failure is a generic `401 UNAUTHORIZED`. A present-but-invalid
token writes `auth.access_token_rejected`; the event records a `userId`/
`sessionId` only when that identifier is trusted (both null for an unverifiable
token; `userId` set but `sessionId` null when the user is valid but the session
is not). A **missing** token is rejected before the service runs and writes no
event (see §B tradeoffs).

### How to extend it safely

- **New primitive** (e.g. a new token kind): add it to `packages/auth-core` as a
  small pure function with tests. Keep secrets/TTLs as parameters — the package
  never reads config.
- **New persisted auth state**: add columns/tables in
  `packages/db/src/schema/auth.ts`, run `pnpm db:generate`, extend the
  `AuthRepository` interface and its two implementations (DB + in-memory fake).
- **New workflow**: add a method to `auth.service.ts` behind the repository
  interface so it stays unit-testable without a database.
- **New public field**: change the `AuthUser`/response schema in
  `packages/contracts` deliberately (it is a frozen contract — see §C).

## B. Architectural Notes

### Key decisions

- **`auth-core` is primitives-only.** It holds hashing, token signing/verifying,
  opaque-token helpers, email normalization, and redaction — no HTTP, no
  database, no workflow. Secrets and TTLs are injected by the caller. This keeps
  the security-critical code small, dependency-light, and trivially testable.
- **Workflows live in `apps/api`, behind a repository interface.** The service
  depends on `AuthRepository`, not on Drizzle. That makes register/login/me
  exercisable end-to-end through the HTTP layer with an in-memory repository (no
  PostgreSQL), and confines all SQL to `auth.repo.ts`.
- **Argon2id via `@node-rs/argon2`.** Argon2id is the OWASP-recommended choice
  for password storage; the napi-rs binding ships prebuilt binaries, so there is
  no node-gyp compile step. bcrypt and SHA-for-passwords are explicitly rejected.
- **JWT access tokens via `jose` (HS256).** Symmetric signing keyed on the
  existing `JWT_SECRET` config. `jose` is ESM-native and validates `exp` for us.
- **Two token strategies on purpose.** Access tokens are JWTs (stateless,
  self-describing, short-lived). Refresh / email-verification tokens are *opaque*
  random strings stored as SHA-256 hashes — their threat model is database
  exfiltration + lookup, not offline brute force, so a fast one-way hash is
  correct and Argon2 would be wrong.
- **Sessions are issued now, exercised later.** A session row anchors each access
  token (`sessionId` claim) and is the object a future refresh-token family hangs
  off. `refresh_tokens` and `email_verification_tokens` ship as schema-complete
  scaffolding so the next sprint adds behavior without a migration redesign.

### Tradeoffs

- **Generic login error vs. debuggability.** Public failures are intentionally
  indistinguishable; the *internal* `auth.login_failed` security event carries a
  `reason` (`unknown_email` / `inactive_account` / `bad_password`) so operators
  retain signal without leaking it to clients.
- **Security event on token rejection.** `/me` writes a durable
  `auth.access_token_rejected` event when a token is *present but invalid*
  (bad signature/expiry/type, untrusted user, or untrusted session). A
  *missing* token is rejected at the route boundary before the service runs and
  writes **no** event — this is intentional: an unauthenticated caller with no
  header carries no signal worth persisting, and skipping it avoids trivial
  write amplification from header-less probes. The present-but-invalid write is
  still unauthenticated, which is one reason auth rate limiting is mandatory in
  the next sprint (see §E). The event only attributes a `userId`/`sessionId`
  that has been verified as trustworthy; otherwise that field is null.
- **Dummy-hash timing equalization** adds one Argon2 verify to unknown-email
  logins. Cheap relative to the security benefit of closing the enumeration
  timing channel.

### Constraints respected

- Public IDs only (prefixed, opaque); no numeric IDs exposed.
- Secrets persisted hash-only; raw passwords/tokens never stored.
- Central error handler remains the single public error boundary.
- Request IDs flow through every error envelope and every security event.
- `packages/shared` stays auth-policy-free; `packages/db` stays workflow-free.

### Rejected alternatives

- **bcrypt / SHA for passwords** — weaker than Argon2id; rejected.
- **`jsonwebtoken`** — CJS-first and heavier than `jose`; rejected.
- **Stateless-only access tokens with no session row** — would force a redesign
  when refresh/logout arrives; rejected in favor of issuing sessions now.
- **A generic rate-limit bucket system** — out of scope for Sprint 2 (see §E).

## C. Contracts & Invariants

These must not change without a deliberate redesign:

- **Password hash-only persistence.** `users.password_hash` stores an Argon2id
  hash. Raw passwords are never stored, logged, or returned.
- **Token hash-only persistence.** `refresh_tokens.token_hash` and
  `email_verification_tokens.token_hash` store SHA-256 hashes. Raw opaque tokens
  are never persisted. Access tokens are never persisted at all.
- **Normalized-email uniqueness.** `users.normalized_email` (trim + lowercase)
  has a unique index; it is the "one account per email" invariant. Normalization
  does not strip dots or `+tags`.
- **Generic credential failure.** Failed login returns `401 INVALID_CREDENTIALS`
  with the same HTTP status, error code, message, and response shape whether the
  email is unknown or the password is wrong, and with no `details` that reveal
  account existence. Responses are not byte-identical: the standard error
  envelope carries a per-request `requestId`, which differs by design. Tests
  assert equality of the security-relevant fields, not the whole body.
- **Current-user boundary.** `/v1/auth/me` returns a user only when ALL hold: a
  Bearer token is present, valid, unexpired, and of `type: 'access'`; its `sub`
  resolves to a user that is active and not soft-deleted; its `sessionId`
  resolves to a session that belongs to that same user and is neither revoked
  nor expired. Any failure is a generic `401 UNAUTHORIZED` with no internal
  reason disclosed.
- **Access-token claim shape (stable):**
  ```ts
  { sub: userId, sessionId, type: 'access', iat, exp }
  ```
- **No DB rows returned directly.** Routes return the `AuthUser` DTO
  (`id`, `email`, `displayName`, `emailVerified`, `createdAt`) only. Never
  `passwordHash`, `normalizedEmail`, `status`, or soft-delete fields.
- **Security-event sanitization.** Event metadata is recursively stripped of
  password/token/secret/authorization/cookie/hash/credential-like keys before
  persistence.
- **Registration workspace provisioning (Sprint 4 → Sprint 18).** As of
  Sprint 4, register created the user's personal workspace (organization +
  active Owner membership) in the same transaction as the user, session, and
  first refresh token. As of Sprint 18 that atomic provisioning happens at
  **registration completion** (`POST /v1/auth/registration/complete`), through
  the same shared provisioning seam — the invariant that a created user always
  has a personal workspace is unchanged; the moment it applies moved. See the
  Sprint 18 section above and
  [`organization-foundation.md`](organization-foundation.md).

### Error codes added

`INVALID_CREDENTIALS` (401) and `EMAIL_ALREADY_REGISTERED` (409) extend the
catalog in `@orgistry/contracts`. Missing/invalid access tokens map to the
existing `UNAUTHORIZED`; validation failures to `VALIDATION_ERROR`. (As of
Sprint 18, `EMAIL_ALREADY_REGISTERED` is returned only by the authenticated
change-email flow — public registration never returns it.)

## D. Integration Notes

- **auth-core → API workflows.** `auth.service.ts` imports pure functions from
  `@orgistry/auth-core` and passes config-sourced secrets/TTLs into them. The
  service owns orchestration; the package owns cryptography.
- **contracts → routes.** Route handlers `parse` request bodies with the Zod
  schemas from `@orgistry/contracts`. A `ZodError` is mapped to
  `400 VALIDATION_ERROR` by the central error handler (extended this sprint).
  Responses are shaped to the contract DTOs and sent via `sendSuccess`.
- **schema → repositories.** `auth.repo.ts` is the only place that touches the
  Drizzle tables; everything else depends on the `AuthRepository` interface.
- **request IDs → errors/events.** `request.id` becomes both the error
  envelope's `requestId` and each security event's `request_id`, so a single id
  correlates an HTTP response, the logs, and the durable security record.
- **Preparation for refresh/session lifecycle.** Sessions and the
  `refresh_tokens` family columns (`family_id`, `parent_token_id`,
  `replacement_token_id`, `used_at`, `revoked_*`) already exist; the next sprint
  adds minting/rotation/reuse-detection and the refresh cookie on top, plus
  logout and session revocation using `sessions.revoked_at`.

## E. Known Limitations

This is the **historical Sprint 2 reference**, so the list below is the Sprint 2
snapshot annotated with each item's current status. For the authoritative current
state see [`session-lifecycle.md`](session-lifecycle.md) (Sprint 3) and
[`organization-foundation.md`](organization-foundation.md) (Sprint 4).

**Resolved since Sprint 2:**

- Refresh token rotation — **resolved in Sprint 3** (transactional rotation +
  reuse detection).
- Refresh cookie lifecycle — **resolved in Sprint 3** (centralized HttpOnly
  cookie).
- Logout — **resolved in Sprint 3** (server-side revoke, idempotent).
- Session listing / revocation — **resolved in Sprint 3** (owner-scoped,
  cursor-paginated).
- Auth rate limiting — **resolved in Sprint 3** (Redis-backed login-per-IP,
  login-per-email, register-per-IP, refresh-per-session, and refresh-per-IP
  buckets returning `RATE_LIMITED`; the limiter fails open, so a Redis outage
  disables limiting but never affects auth correctness).
- Organization-linked registration — **resolved in Sprint 4**: registration
  provisions the user's personal workspace (organization + active Owner
  membership) atomically, and authenticated team-organization create/list/read
  exist. See [`organization-foundation.md`](organization-foundation.md).

**Still out of scope after Sprint 4:**

- Email verification (the token table is scaffolding; `users.email_verified_at`
  is always null on registration) — **resolved in Sprint 16**; see
  [`email-and-verification.md`](email-and-verification.md). Since Sprint 18,
  registered users are email-verified at creation (completion of the emailed
  registration token is the mailbox proof).
- Password recovery and password/email change — **resolved in Sprint 17**; see
  [`credential-management.md`](credential-management.md).
- The registration duplicate-email disclosure (the `409` account-existence
  oracle) — **resolved in Sprint 18** by the verification-first registration
  redesign; see the Sprint 18 section above (a bounded timing residual on the
  request path remains and is documented there).
- Permissions, member management, invitations, entitlements, quotas, projects,
  API keys, organization audit logs, and any auth/organization web UI —
  resolved by Sprints 5–11.
- The system is **not** production-certified (still true).

## F. Sprint Changelog

### Iteration summary

Added the authentication foundation on top of the Sprint 1 technical
foundation, with no regression to existing behavior.

### Implementation changes

- New package `@orgistry/auth-core` (Argon2id, JWT, opaque tokens, email
  normalization, redaction).
- New auth schema + migration `0001_*.sql`: `users`, `sessions`,
  `refresh_tokens`, `email_verification_tokens`, `security_events` with lookup,
  uniqueness, and cleanup indexes. Added the `evtok` ID prefix.
- Auth DTOs and two new error codes in `@orgistry/contracts`.
- `apps/api/src/modules/auth/*`: repository (interface + Drizzle impl), service
  (register/login/authenticate), routes, error factories, security-event
  writer + sanitization. Wired an optional `authService` into `buildApp` and the
  real service into `server.ts`.
- Central error handler extended to map `ZodError` → `VALIDATION_ERROR`.
- Config: `AUTH_ACCESS_TOKEN_TTL_SECONDS` (default 900) and
  `AUTH_SESSION_TTL_SECONDS` (default 2,592,000).

### Test additions

- `auth-core`: password, access-token (incl. expiry/invalid), opaque-token,
  email, redaction unit tests.
- `contracts`: auth DTO validation tests.
- `apps/api`: full register/login/me behavior through `app.inject` with an
  in-memory repository (generic credential errors, no-secret-leak, security
  events) and metadata-sanitization tests.
- DB-backed integration: `auth.integration.test.ts` (hash-only persistence,
  durable sanitized events, DB-level uniqueness) and auth assertions added to the
  migration-from-scratch suite (tables, indexes, uniqueness constraint).

### Documentation additions

- This document; updates to `README.md`, `docs/api-conventions.md`,
  `docs/database-foundation.md`, and `.env.example`.

### Hardening pass

Surgical follow-up to close current-user confidence gaps; no architecture,
library, or route changes.

- **Current-user boundary.** Added the missing check that the token's
  `sessionId` resolves to a session **owned by the token's subject user** (a
  token can no longer be honored against another user's session). The other
  boundary checks (presence, validity, expiry, `type`, active/non-deleted user,
  session revoked/expired) were already present and are now covered by explicit
  route-level tests.
- **Token-rejection event attribution.** The `auth.access_token_rejected` event
  now records `userId`/`sessionId` only when that identifier is trusted (both
  null for an unverifiable token; `userId` set, `sessionId` null when the user
  is valid but the session is not).
- **Tests.** Added route-level `/me` tests for expired token (envelope +
  request id + no leakage), missing/revoked/expired session, cross-user session,
  the rejection security event (null attribution + sanitized metadata), and the
  intentional no-event-on-missing-token case; a DB-backed integration assertion
  for the persisted rejection event; and an `auth-core` test for the wrong token
  `type`.
- **Docs.** Clarified that generic login failures match on security-relevant
  fields (not byte-identical — `requestId` differs by design), the rate-limit
  deferral and the "Redis must not be part of auth correctness" constraint, and
  the not-production-certified wording.

### Known remaining risks

- Absence of rate limiting makes register/login and the present-but-invalid
  `/me` rejection path abusable until the next sprint adds it.
- Security-event volume is unbounded; retention/pruning is future work (the
  `created_at` index supports it).
