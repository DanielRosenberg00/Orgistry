# Credential Management (Sprint 17)

Password recovery, authenticated password change, authenticated email change,
and the registration de-enumeration posture. This document is the canonical
design + developer reference for those flows; the API index lives in
[api-surface.md](api-surface.md), error-code conventions in
[api-conventions.md](api-conventions.md), and the verification lifecycle the
email-change flow reuses in
[email-and-verification.md](email-and-verification.md).

## What was implemented, and where

| Concern | Location |
| --- | --- |
| Reset-token persistence | `packages/db/src/schema/auth.ts — password_reset_tokens` (migration `0009_lovely_karnak.sql`) |
| Reset-token generation/hashing | `apps/api/src/modules/auth/password-recovery.token.ts` |
| Recovery email rendering | `apps/api/src/modules/auth/password-recovery.email.ts` |
| Recovery workflows | `apps/api/src/modules/auth/password-recovery.service.ts` |
| Recovery persistence (SQL) | `apps/api/src/modules/auth/password-recovery.repo.ts` |
| Recovery routes | `apps/api/src/modules/auth/password-recovery.routes.ts` |
| Reset-token error codes | `apps/api/src/modules/auth/password-recovery.errors.ts` |
| Password/email change | `auth.service.ts — changePassword / changeEmail`, `auth.repo.ts — changePasswordKeepingCurrentSession / changeEmail`, routes in `auth.routes.ts` |
| Contracts | `packages/contracts/src/auth.ts` (Sprint 17 section), `error-codes.ts` |
| Frontend | `apps/web-demo/src/pages/ForgotPasswordPage.tsx`, `ResetPasswordPage.tsx`, `AccountSecurityPage.tsx` |
| Config knobs | `PASSWORD_RESET_TTL_SECONDS`, `RATE_LIMIT_PASSWORD_RECOVERY_*`, `RATE_LIMIT_REGISTER_PER_EMAIL_MAX`, `RATE_LIMIT_CHANGE_{PASSWORD,EMAIL}_PER_USER_MAX` |

## Password recovery

### Request (`POST /v1/auth/password-recovery/request`, public)

1. Validate `{ email }` through the shared contract; normalize with the shared
   `normalizeEmail`.
2. Rate-limit per IP and per normalized-email **digest** (the email is hashed
   into the Redis key; both buckets behave identically for known and unknown
   addresses, so neither is an existence oracle).
3. Resolve the user. For an unknown, disabled, or soft-deleted account: record
   an internal security event (coarse outcome only — never the submitted
   email) and return the SAME `{ accepted: true }`. A lookup that THROWS
   (e.g. a database outage) is handled inside the same boundary: best-effort
   anonymous `lookup_failed` event, same generic response — availability of
   the account store is never disclosed.
4. For an active account: mint a 32-byte CSPRNG token and
   **persist-and-commit before send** — one transaction locks the user row
   (`SELECT … FOR UPDATE`, serializing concurrent issuance), invalidates
   every prior unused reset token, and inserts the new SHA-256 hash; only
   after commit is the recovery email handed to `AccountMailer`. The
   guarantee is exactly this: **every emailed reset token was durably
   persisted before it was handed to the mailer**. It is NOT a guarantee
   that a sent link stays usable — a concurrent or subsequent recovery
   request invalidates it (exactly one generation survives issuance, so
   concurrent requests may produce multiple emails of which only the most
   recent surviving generation is authoritative; an older email then carries
   a superseded token). That is expected single-generation behavior, not
   token leakage or a transaction failure.
5. Every internal failure is **swallowed** behind the same
   `{ accepted: true }`: a thrown account lookup (`outcome: lookup_failed`);
   a persistence failure that sends no email (`outcome: persist_failed`); a
   mail failure that leaves a harmless persisted token — unknown to anyone,
   expiring, retired by the next successful generation
   (`outcome: send_failed`, `delivered: false`); and a security-event write
   failure, swallowed by the no-throw recorder. **After schema validation
   and rate limiting succeed, account lookup, token persistence, mail
   delivery, and recovery-request event recording cannot change the generic
   public response.** On this public endpoint, surfacing any of them would
   disclose account existence or store availability. (This ordering deliberately differs from verification
   issue/resend, which is authenticated, surfaces mail failures, and
   therefore delivers before persisting.)

The emailed link is `<web>/auth/reset-password#token=<raw>` — the token rides
in the URL **fragment**, which browsers never transmit, so it cannot reach the
web server, a proxy, an access log, or a `Referer` header.

### Completion (`POST /v1/auth/password-recovery/complete`, public)

Body: `{ token, newPassword }` — both only ever in the request body. The new
password parses through the SAME shared `newPasswordSchema` as registration.
The new hash is computed (Argon2id) **before** the transaction so CPU-bound
hashing never runs under a row lock. Then, in ONE transaction
(`password-recovery.repo.ts — completeReset`):

1. `SELECT … FOR UPDATE` the token row by hash — concurrent completions of the
   same token serialize here; exactly one can ever succeed.
2. Classify: unknown → 404 `PASSWORD_RESET_TOKEN_INVALID`; consumed or
   invalidated → 409 `PASSWORD_RESET_TOKEN_USED`; expired → 410
   `PASSWORD_RESET_TOKEN_EXPIRED`; account not recoverable → the same 404 as
   unknown (account state never leaks).
3. Replace `users.password_hash`; mark the token `used_at`; invalidate every
   sibling reset token; revoke **every** session of the user (reason
   `password_reset`) and **every** refresh token hanging off any of the user's
   sessions.

After completion the response is `{ reset: true }` and nothing else: **no
tokens, no session, no cookie**. The user signs in with the new password. Old
access tokens die at the existing server-side session revalidation
(`requireAuthenticatedSession` rejects revoked sessions); old refresh cookies
classify as reuse and cannot mint access tokens.

Sanitized security events are written after the transaction commits
(repository convention). Attribution follows a deliberate taxonomy:

- **Anonymous public request** — every `auth.password_reset_requested` event:
  submitting an email to a public endpoint authenticates nobody, so the
  event always carries `actorType: 'anonymous'`, `userId: null`,
  `sessionId: null`, and coarse outcome metadata only
  (`sent | send_failed | persist_failed | lookup_failed | inactive_account |
  unknown_email` plus `delivered`) — never the email, an email digest, or
  the resolved account id. The event schema has no separate subject/target field, so
  request events are deliberately **not account-linked**; operational
  correlation uses the row's sanitized IP/UA/request-id context. These
  writes are **best-effort through one no-throw recorder**: an event-store
  failure is swallowed and can never alter the enumeration-safe response.
- **Token-authorized credential action** — `auth.password_reset_completed`:
  a successful completion has proven possession of a single-use,
  account-bound credential, so it is attributed to the resolved user
  (`actorType: 'user'` + user id) — the same identity basis the
  email-verification completion event already uses. Not a Bearer session.
- **Anonymous rejection** — `auth.password_reset_rejected`: an invalid,
  expired, or used token proves nothing; `userId: null`,
  `actorType: 'anonymous'`, coarse token-free `reason` only — never a
  token-derived account reference.
- (For contrast: `auth.password_changed` / `auth.email_changed` are
  **authenticated user actions** — Bearer session + current-password proof —
  and `auth.refresh_token_reuse_detected` family revocation is a
  **system-side consequence**.)

### Reset-token lifecycle

`password_reset_tokens` is deliberately a **separate table** from
`email_verification_tokens`. The families answer different questions ("may
this address be marked verified?" vs. "may this caller replace the account
password?"), carry different blast radii and TTLs (24 h vs. 1 h default), and
will get different retention policies. Overloading one table would make row
meaning ambiguous. The lifecycle columns mirror the verification model exactly
— `used_at` = consumed by a successful reset; `invalidated_at` = retired
unused (superseded or sibling-retired); usable only while both are NULL and
`expires_at > now()`.

**Issuance concurrency:** invalidate-then-insert alone is not race-safe under
`READ COMMITTED` — two concurrent requests could each miss the other's
uncommitted insert and both leave a usable token. The issuance transaction
therefore first locks the **user row** (`SELECT … FOR UPDATE`), so concurrent
requests serialize: the second waits for the first's commit and then retires
its generation. Invariant: concurrent recovery requests may send more than
one email, but after all issuance operations settle, exactly ONE reset
generation is usable; every other generation is invalidated and cannot reset
the password. Proven against live PostgreSQL by the concurrent-generation
integration test. Unique index on `token_hash`; index on `user_id`. The row
stores no IP, user agent, or link — request context lives on the
security-events seam.

## Authenticated password change (`POST /v1/auth/change-password`, Bearer)

Policy: **the session that proved the current password survives; everything
else dies.**

1. Resolve the trusted user + session from the access token
   (`requireAuthenticatedSession`) — the surviving session id comes from
   server-side auth context, never from the client.
2. Rate-limit per user.
3. Verify `currentPassword` against the stored Argon2id hash. Wrong →
   `INVALID_CREDENTIALS` at **400** (not 401 — the session is valid; a 401
   would make clients treat a typo as an expired session and, in the web demo,
   silently log the user out).
4. Reject a new password identical to the current one (verified against the
   existing hash; nothing is persisted for the check).
5. In ONE transaction (`changePasswordKeepingCurrentSession`): swap the hash,
   revoke every OTHER session (reason `password_changed`), and revoke every
   refresh token not belonging to the surviving session.

## Authenticated email change (`POST /v1/auth/change-email`, Bearer)

Policy: **direct change** — no pending-email architecture (none exists in the
repository, and verification is advisory, so building one would be scope
expansion for no enforcement benefit).

1. Resolve trusted user + session; rate-limit per user.
2. Normalize the new email; same-as-current → 400 `VALIDATION_ERROR`.
3. Verify the current password (before any duplicate lookup, so a stolen
   access token alone cannot probe other accounts' emails here).
4. In ONE transaction (`auth.repo.ts — changeEmail`): update `email` +
   `normalized_email`, clear `email_verified_at`, and invalidate every unused
   email-verification token. A duplicate normalized email surfaces the same
   409 `EMAIL_ALREADY_REGISTERED` as registration — an intentionally accepted
   disclosure for this authenticated, password-re-proved flow.
5. After commit: best-effort send of the standard verification email to the
   NEW address (`sendEmailChangeVerificationEmail` — the same never-throw
   contract as the post-registration email). The account remains fully usable
   under the advisory-verification policy.

**Mail-failure consistency:** the email change commits before the verification
send is attempted. If the send fails, the change stands, the failure is
recorded (`auth.email_verification_requested` with `delivered: false`,
`trigger: 'email_change'`), and the user resends from the authenticated
endpoint. This reuses the Sprint 16 semantics rather than inventing a
distributed transaction; the invariant that matters — old-address verification
state and tokens are dead the moment the change commits — is enforced inside
the transaction, not by the mail path.

## Shared password policy

`newPasswordSchema` in `packages/contracts/src/auth.ts` is the ONE policy
(min 12 / max 200 chars). Registration, reset completion, and password change
all parse through it; none restates the rule. Passwords submitted for
*verification* (login, current-password confirmation) are only shape-checked,
so accounts predating a future policy tightening can still authenticate and
re-prove themselves. Contract tests pin all three surfaces to the shared
schema.

## Registration de-enumeration (ORG-PR-030) — design note

**Selected behavior:** public registration KEEPS its `409
EMAIL_ALREADY_REGISTERED` conflict, now wrapped in two new controls:

- a per-normalized-email-digest rate limit (`RATE_LIMIT_REGISTER_PER_EMAIL_MAX`,
  counted before the lookup, identical for known and unknown addresses), which
  bounds how fast any address can be probed regardless of the attacker's IP
  pool;
- a durable `auth.registration_duplicate_email` security event making
  enumeration attempts visible. Attribution is honest: the caller is
  unauthenticated and unproven, so the event carries an **anonymous actor, a
  null user id, and coarse `{ reason: 'duplicate_email' }` metadata** — never
  the email, an email digest, or the existing account's id (a probe must not
  read as an action by, or a reference to, the victim). Request context rides
  on the event row's standard sanitized IP/UA/request-id fields.

**What was removed:** unthrottled, unobserved probing. **What remains:** a
patient attacker within the rate limit still learns from the 409 that an
address is registered.

**Why full closure was not implemented:** the registration contract returns a
live session (`201 { user, tokens }` + refresh cookie) synchronously. A
duplicate cannot be answered indistinguishably without either fabricating
credentials (forbidden, and absurd) or converting registration into a
verification-required, email-first architecture — a product redesign the
sprint explicitly rules out. The strongest safe posture inside the current
architecture is throttle + observe, which is what shipped.

**Status: ORG-PR-030 is materially advanced, not closed.** The residual
disclosure is recorded in the findings register; full closure is tied to a
future deliberate registration redesign. The public password-recovery flow, by
contrast, is fully enumeration-safe (identical response for every input), and
login hardening is unchanged. Invitation email-match enforcement and
invitation-token registration are unchanged and re-covered by tests.

## Contracts and invariants (must not change without deliberate review)

- Raw reset tokens are never persisted — SHA-256 hash only.
- Raw tokens and token hashes never appear in API responses, route paths,
  query strings, logs, security events, or error metadata.
- Reset tokens are single-use, short-lived (1 h default), and invalidated by
  any newer generation or sibling completion.
- Reset issuance serializes per user (user-row `FOR UPDATE`): after any set
  of concurrent recovery requests settles, exactly one generation is usable.
  Concurrent requests may each send an email; older emails then carry a
  superseded token by design.
- A recovery email is sent only AFTER its token hash has durably committed
  (persist-and-commit before send); a persistence failure sends no email.
  This is not a liveness guarantee — a sent link may be superseded before
  it is opened.
- Recovery-request security events are anonymous (`userId`/`sessionId` null),
  never account-linked, and best-effort: an event-store failure can never
  change the public response.
- After schema validation and rate limiting succeed, account lookup, token
  persistence, mail delivery, and recovery-request event recording cannot
  change the generic public response.
- Exactly one concurrent completion of a token can succeed (`FOR UPDATE`).
- A completed reset revokes ALL prior sessions and refresh tokens in the same
  transaction that swaps the hash, and never signs the caller in.
- Password change and email change both REQUIRE the current password.
- Password change keeps only the caller's session.
- A changed email is unverified until the new address completes verification;
  old verification tokens die with the change transaction.
- Public recovery request is enumeration-safe: one response shape, one status,
  for every input — including internal mail failures.
- Tokens reach completion endpoints only through request bodies.
- Frontend token handling is transient: fragment capture → history scrub →
  component memory → POST body; never storage, never DOM, never a query
  string.
- All three password-setting surfaces share `newPasswordSchema`.

## Frontend integration

- `/auth/forgot-password` — email form → recovery request; one generic
  confirmation regardless of account existence.
- `/auth/reset-password` — mirrors the Sprint 16 verification page's token
  hygiene (fragment capture + immediate `history.replaceState` scrub +
  transient state); collects new password + confirmation; submits
  `{ token, newPassword }`; maps the three token-error codes to distinct
  states; links to login on success (the reset revoked every session, so there
  is nothing to restore).
- `/app/account` — authenticated account-security surface: current email +
  backend-derived verification state, verification resend while unverified,
  password change, and email change (both demanding the current password);
  password fields are cleared after every submission; the current user is
  re-fetched after an email change so displayed state always comes from the
  backend.

## Extending safely

- New credential flows should reuse `generateOpaqueToken`/`hashOpaqueToken`
  via a named seam (as `password-recovery.token.ts` does), the shared
  `AccountMailer`, the shared password schema, and the security-event
  sanitizer — never parallel implementations.
- Anything that invalidates authentication must revoke sessions AND refresh
  tokens inside the same transaction as the credential mutation; copy the
  `completeReset` / `changePasswordKeepingCurrentSession` shape.
- Keep public account-adjacent endpoints response-uniform; put the truth in
  security events, not in the HTTP surface.

## Known limitations

- The recovery request path does measurably more work for an existing account
  (one SMTP delivery + one insert) than for an unknown email, so response
  TIMING is not fully equalized. Closing this requires queued/out-of-band
  delivery, deliberately out of scope this sprint. The per-IP and per-email
  limits bound how fast the signal can be sampled.
- Rate limits still fail open when Redis is unavailable (system-wide policy;
  see [security-model.md](security-model.md)).
- Registration retains the throttled, evented 409 disclosure described above.
- External SMTP delivery remains unvalidated (ORG-PR-002); locally, recovery
  emails are observable in Mailpit.

## Running the tests

```bash
# Route-level unit suites (in-memory repos + memory mailer)
npx vitest run apps/api/src/modules/auth/password-recovery.routes.test.ts
npx vitest run apps/api/src/modules/auth/credential-change.routes.test.ts

# DB-backed lifecycle + FOR-UPDATE concurrency (needs live PostgreSQL)
pnpm validate:integration   # includes password-recovery.integration.test.ts

# Frontend flows (token hygiene, forms, account security)
pnpm --filter @orgistry/web-demo run test -- src/test/password-recovery.test.tsx
pnpm --filter @orgistry/web-demo run test -- src/test/account-security.test.tsx

# Contract pinning (shared password policy across all three surfaces)
npx vitest run packages/contracts/src/auth.test.ts
```
