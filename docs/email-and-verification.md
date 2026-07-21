# Email & Email Verification

Sprint 16 design reference: the account-mailer boundary, its drivers, the
email-verification lifecycle, and the security invariants both must uphold.
For the current honest scope boundary see
[known-limitations.md](known-limitations.md); for finding status see the
[findings register](production-readiness/findings-register.md) (ORG-PR-002,
ORG-PR-024, ORG-PR-048).

## The account-mailer boundary

One narrow seam delivers every account email (organization invitations, email
verification, password recovery — Sprint 17 — and the Sprint 18 registration
completion and existing-account guidance emails; future security notifications
belong here too). Feature modules own **what** is sent — they render a plain-text
`AccountEmail { to, subject, text }` — and the mailer owns **how**: sender
identity, transport, timeout.

| Concern | Where |
|---|---|
| `AccountEmail`, `AccountMailer`, sender identity, central header-injection guard | `apps/api/src/modules/mail/account-mailer.ts` |
| Shared nodemailer transport + policy (TLS, timeouts, CA seam, guard enforcement) | `apps/api/src/modules/mail/smtp-transport.ts` |
| Local Mailpit driver (plaintext, no auth, STARTTLS disabled) | `apps/api/src/modules/mail/mailpit-account-mailer.ts` |
| Production SMTP driver (implicit TLS + negotiated auth, validated construction) | `apps/api/src/modules/mail/smtp-account-mailer.ts` |
| Deterministic driver selection from config | `apps/api/src/modules/mail/account-mailer-factory.ts` |
| In-memory test driver (captures messages) | `apps/api/src/modules/mail/testing/in-memory-account-mailer.ts` |
| Invitation rendering (migrated onto the boundary) | `apps/api/src/modules/invitations/invitation.mailer.ts` |
| Verification rendering + link construction | `apps/api/src/modules/auth/email-verification.email.ts` |
| Registration completion + existing-account guidance rendering (Sprint 18) | `apps/api/src/modules/auth/registration.email.ts` |

### Driver selection

`MAIL_DRIVER` selects exactly one driver — `mailpit` (local default), `smtp`
(production), or `memory` (tests). Selection is configuration-driven and
deterministic: there is no environment sniffing and no fallback chain.
Under `NODE_ENV=production` the config guard
([production-config-guard.md](production-config-guard.md)) **refuses to load**
anything except `smtp`, refuses missing/placeholder SMTP credentials, refuses
the local-only/reserved-domain sender defaults, and refuses a localhost or
plain-HTTP `WEB_DEMO_URL` (emailed links embed that origin). The factory
independently re-checks the production/driver pairing as a second line of
defense. **Production can never silently deliver to Mailpit or a fake.**

Driver-conditional validation lives in `packages/config/src/mail-policy.ts`:
selecting `smtp` requires `SMTP_HOST`/`SMTP_USERNAME`/`SMTP_PASSWORD` in every
runtime mode; the `mailpit` and `memory` drivers never require provider
credentials, so local development works with only `.env.example` values.

### Transport: nodemailer (the Sprint 16 refinement decision)

Sprint 16 initially shipped a hand-rolled SMTP step-table client (extending
the Sprint 9 zero-dependency Mailpit transport with TLS + AUTH PLAIN). The
refinement iteration **replaced that protocol implementation with
nodemailer**, one narrowly scoped, mature SMTP library — a production SMTP
client must correctly handle multiline replies, EHLO capability parsing, AUTH
mechanism negotiation, TLS certificate + hostname verification, per-phase
timeouts, socket teardown on every path, dot stuffing, and RFC 2047 encoding
of non-ASCII headers, and re-proving all of that for a bespoke client is
strictly more risk and review load than one well-exercised dependency. The
Orgistry-owned policy around it stays small (`smtp-transport.ts`): the
central header-injection guard, implicit-TLS-only posture, unified timeouts,
an append-only extra-CA seam, and a no-logging rule.

**Capabilities, stated precisely:**

- Transport: SMTP over **implicit TLS** (SMTPS, conventionally port 465),
  certificate and hostname verification always on. The driver offers **no
  STARTTLS upgrade**, so the chosen provider endpoint must accept
  TLS-from-the-first-byte connections. The Mailpit driver is plaintext with
  STARTTLS negotiation disabled (Mailpit advertises it with a self-signed
  certificate an opportunistic upgrade would fail to verify).
- Authentication: the mechanism nodemailer negotiates from the server's
  advertised capabilities. AUTH PLAIN is the one mechanism with direct
  automated test evidence (the in-process fake server advertises only PLAIN);
  other mechanisms nodemailer supports are not separately validated in this
  repository.
- Automated evidence: fake-server interop tests including a real TLS
  handshake and authentication, 5xx refusals, credential-redacted failures,
  untrusted-certificate rejection, plaintext-server refusal, non-ASCII
  encoded-word subjects; plus live delivery to the local Mailpit container.
- **No live external-provider evidence** — real-provider compatibility is
  asserted from the above, not proven; ORG-PR-002 stays open until a real
  external send is performed.

Still rejected: provider SDKs (vendor lock-in), a plugin architecture, and
multiple providers (all out of scope).

### Delivery-failure policy

`deliver` rejects on any failure; the **caller** owns the policy:

- **Invitation create** — fail-closed: send before persist; a failure aborts
  creation (unchanged from Sprint 9).
- **Explicit verification request/resend** — fail-closed: a delivery failure
  surfaces as an error and the previous token generation stays usable.
- **Post-registration verification email — RETIRED in Sprint 18.**
  Registration no longer sends a verification email at all: registration is
  verification-first, completing the emailed registration token IS the
  mailbox proof, and users are created email-verified. The registration
  request instead sends a **completion** email under the persist-then-send
  convention (the pending registration commits before the mailer sees the
  message), and — for existing active accounts — a throttled, neutral
  **guidance** email. A mail failure never alters the generic public
  response. The full design lives in
  [auth-foundation.md](auth-foundation.md).
- **Post-email-change verification email (Sprint 17)** — **best-effort**
  (`trigger: 'email_change'`): the email change has already committed
  (verification cleared, old tokens invalidated inside that transaction), so
  a failed send only means the user resends later. Since Sprint 18 this is
  the only flow that triggers a verification email. See
  [credential-management.md](credential-management.md).
- **Password-recovery request email (Sprint 17)** — the OPPOSITE ordering:
  **persist-and-commit before send**. Every emailed reset token was durably
  committed (sibling invalidation + insert, under the per-user issuance
  lock) before the mailer saw the message; if persistence fails, no email is
  sent. This does NOT mean a sent link stays usable: a concurrent or later
  recovery request supersedes it (exactly one generation survives issuance;
  older emails then carry an invalidated token — expected single-generation
  behavior). Internal failures — persistence, delivery, even the
  security-event write — are **swallowed** behind the generic
  `{ accepted: true }` (recorded best-effort as
  `auth.password_reset_requested` with
  `outcome: persist_failed | send_failed`, `delivered: false`) — surfacing an
  error on an unauthenticated, email-keyed endpoint would disclose account
  existence. An undelivered persisted token is harmless: unknown to anyone,
  expiring, retired by the next successful generation. The orderings differ
  because verification issue/resend is authenticated and surfaces failures
  (a dead emailed link would strand nobody), while the public recovery
  endpoint cannot surface anything.

## Email verification lifecycle

> **Sprint 18 note.** New accounts are created **email-verified**: completing
> the emailed registration token is the mailbox proof, so registration never
> issues a verification token or email. This lifecycle is therefore reached
> mainly after an authenticated **email change** (which clears verification
> for the new address) — the mechanics below are unchanged.

### Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/email-verification/request` | Bearer | Issue/re-issue a token for the CURRENT user and email the link. Also the resend endpoint — there is deliberately no separate resend route. No request body: the endpoint operates only on the authenticated user's stored email, so **no arbitrary address can ever be probed**. Already-verified users get safe success (`{ sent: false, alreadyVerified: true }`) without a send. |
| `POST /v1/auth/email-verification/complete` | Public | Complete verification. The raw token arrives in the request **body** (never a backend URL path, so it cannot reach access logs). Possession of the emailed token IS the proof — requiring login here would break the common "opened the link in a fresh browser" case without adding security: the token is already a single-use, expiring, account-bound secret. |

Errors (`packages/contracts/src/error-codes.ts`):
`EMAIL_VERIFICATION_TOKEN_INVALID` (404), `EMAIL_VERIFICATION_TOKEN_EXPIRED`
(410), `EMAIL_VERIFICATION_TOKEN_USED` (409). They describe **token validity
only**: a token whose account is missing/disabled/soft-deleted reports the
same 404 as an unknown token, so completion never discloses account state.

### Issuance (request/resend)

`email-verification.service.ts → requestVerificationEmail`:

1. rate limit (per user, per IP);
2. re-read the authoritative user row (stored email is the only recipient);
3. already verified → safe success, nothing sent;
4. mint a 32-byte CSPRNG token (`email-verification.token.ts`, the same
   `generateOpaqueToken`/`hashOpaqueToken` primitives as refresh and
   invitation tokens — no second, weaker token model);
5. render and deliver the email (fail-closed, before persistence);
6. in ONE transaction: invalidate every previous unused token for the user,
   insert the new hash (`email-verification.repo.ts → issueVerificationToken`).

After any request/resend, **at most one usable token generation exists**.

**Consistency contract (SMTP and PostgreSQL cannot share a transaction).**
The previous usable generation is untouched until the mailer has ACCEPTED the
replacement message — so a delivery failure aborts the operation with an
error, the old delivered link keeps working, and an undelivered token can
never become the sole usable one. The unavoidable non-atomic window sits
between mailer acceptance and the issue transaction: if persistence fails
there, the endpoint errors (no misleading success), the just-emailed
candidate link is permanently dead (its hash was never stored), and the old
generation remains the only usable one — recoverable by resend. Email
delivery is **not** atomic with the database and this document does not claim
it is; the window is accepted, tested (delivery-failure, persistence-failure,
and successful-replacement cases), and preferred over a queue/outbox, which
is out of scope.

### The emailed link

`<WEB_DEMO_URL>/auth/verify-email#token=<raw-token>` — built by
`buildEmailVerificationUrl` from the configured public web URL (never
hardcoded), covered by tests. The token travels in the **URL fragment**
(hardened in the Sprint 16 refinement): browsers never send the fragment in
the HTTP request, so the raw token cannot reach the web server, a reverse
proxy, an access log, or a `Referer` header. The frontend captures it from
the fragment after component initialization, removes the fragment from the
URL/history, and POSTs it to the API in a body; it is never copied into a
query string. The raw token therefore exists only in the email, transiently
in browser memory before completion, and in the completion POST body. The
full URL is never logged (the mail module never logs at all).

**Scope of this protection, honestly:** the fragment design eliminates
URL-based leakage through HTTP requests and server-side logs. It does NOT —
and cannot — prevent observation of the emailed URL by the recipient's email
client or provider, browser extensions, screenshots/shoulder-surfing, or a
compromised browser. Those are inherent to delivering any secret link over
email; the compensating controls are expiry, single-use consumption, and
resend invalidation.

### Completion

`email-verification.repo.ts → completeVerification`, one transaction:

1. `SELECT … FOR UPDATE` on the token row by hash — concurrent completions of
   the same token serialize at the database; the loser observes the consumed
   row and classifies as `already_used`. **Two concurrent requests can never
   both succeed** (proven by an integration test firing both in parallel).
2. Classify: unknown → `not_found`; consumed/invalidated → `already_used`;
   past expiry → `expired`.
3. Lock and check the user: missing/disabled/soft-deleted →
   `user_not_verifiable` (mapped to the same 404 as unknown; token left
   untouched).
4. Consume the token (`used_at`), invalidate unused siblings
   (`invalidated_at`), and set `users.email_verified_at` **conditionally**
   (`WHERE email_verified_at IS NULL` — set once, ever).

Security events (`auth.email_verification_succeeded` / `…_failed`) are
written after commit, per the module convention that events are best-effort
audit records and never part of the domain transaction.

### Token model (`email_verification_tokens`)

Two terminal timestamps with distinct, never-overloaded meanings:

- `used_at` — consumed by a successful verification;
- `invalidated_at` — retired unused (superseded by a resend, or a sibling
  completed). Added by migration `0008`.

Usable ⇔ `used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`.
Lookup is by the unique `token_hash` index; TTL comes from
`EMAIL_VERIFICATION_TTL_SECONDS` (default 24 h).

### Stable invariants

- Raw verification tokens are **never persisted** — only SHA-256 hashes.
- Token hashes never appear in API responses, DTOs, logs, security events,
  frontend state, or committed fixtures.
- Tokens expire and are single-use; resend invalidates all prior unused
  tokens; completion + user update are transactional and race-safe.
- Production cannot silently use Mailpit or the in-memory fake.
- Request/resend operates only on the authenticated current user.
- The frontend never persists the token (transient component memory only; the
  token-bearing fragment is removed from the URL/history after capture and is
  never copied into a query string).
- No caller-supplied value can inject an email header: CR/LF/NUL are rejected
  centrally (`assertSafeAccountEmail`/`assertSafeSenderIdentity` in
  `account-mailer.ts`) before any transport sees the message.
- **Email verification is advisory in Sprint 16**: no login, organization,
  invitation, project, API-key, or demo surface is gated on it. The extension
  point for future enforcement is the backend-derived `emailVerified` field
  on the current-user contract (plus `users.email_verified_at`); any gate
  must be added server-side as a deliberate, documented change.

### Registration integration (rewritten for Sprint 18)

- **Normal registration** — verification-first: `POST /v1/auth/register`
  stages a pending registration and emails a completion link; the account is
  created at `POST /v1/auth/registration/complete` with `email_verified_at`
  set — completing the emailed token IS the mailbox proof. Registration never
  sends a verification email (the `sendInitialVerificationEmail` port no
  longer exists; the auth service's email-verification port covers only the
  post-email-change send). See [auth-foundation.md](auth-foundation.md).
- **Invited new-user registration / invitation acceptance** — the invitation
  is validated internally at the registration request (private failures
  return the generic acceptance and send nothing) and accepted at
  registration completion (re-checked inside a savepoint; see
  [invitations.md](invitations.md)). The completed invited account is
  verified like any other completed account.
- **Existing invited users** — invitation accept never touches verification
  state.
- **Seeded demo users** — the demo seed drives the real registration API
  (including reading the completion link from the Mailpit API), so demo users
  are created verified like any completed registration.
- **Email change (Sprint 17)** — an authenticated email change clears
  `email_verified_at` and invalidates all outstanding verification tokens in
  the SAME transaction that swaps the address, then best-effort issues a fresh
  generation to the NEW address. The previous address's verification can never
  survive an address change.

### Rate limiting

Redis-backed fixed-window buckets (shared auth window length), values in
`config.rateLimit.emailVerification` (`RATE_LIMIT_EMAIL_VERIFICATION_*`):
request per user (default 3/min), request per IP (10/min), completion per IP
(10/min — this is also the guard against repeated invalid submissions).
Limiter keys never contain the submitted token. Exceedance emits the standard
`auth.rate_limit_exceeded` event (bucket name only) and the standard
`RATE_LIMITED` envelope.

### Security events

`auth.email_verification_requested` (`{ delivered, trigger? }`),
`auth.email_verification_succeeded` (attributed to the user),
`auth.email_verification_failed` (`{ reason }`, attributed to no user — the
token proved nothing). Metadata passes `sanitizeSecurityMetadata`; it never
contains the raw token, the hash, the verification URL, or provider data.

## Web demo

- `EmailVerificationBanner` (in the app shell) — shows while the
  backend-reported `user.emailVerified` is false: resend action with pending
  / sent / rate-limited / failure states. Purely informational (advisory
  policy); state is always backend-derived.
- `/auth/verify-email` (`VerifyEmailPage`) — captures the token once from the
  URL fragment into transient component memory, immediately removes the
  fragment via history replacement (it never lingers in the address bar or
  history, and is never copied into a query string), POSTs the token in a
  body (exactly once — guarded against StrictMode double-effects), renders
  loading / success / invalid / expired / used / missing-token /
  generic-failure states from the backend response, and refreshes the cached
  current user after success. Never touches localStorage/sessionStorage;
  never renders the token.

## Testing

- Driver tests (`modules/mail/*.test.ts`): the central header-injection guard
  (sender name/email, recipient, subject, feature-supplied organization
  names), driver selection, production rejections, plaintext Mailpit
  conversation, non-ASCII encoded-word subjects, and the production driver
  over a REAL TLS handshake + authentication against an in-process fake
  server (committed test-only certificate in `mail/testing/tls-fixtures.ts`
  — public by design, certifies only localhost, imported only by tests, not a
  credential; a secret-scanner hit on it is a false positive).
- Route tests (`email-verification.routes.test.ts`) + integration tests
  (`email-verification.integration.test.ts`, live PostgreSQL) cover the whole
  lifecycle, including the concurrent double-completion race.
- Tests inspect delivery via the in-memory driver and recover raw tokens from
  the captured email link — the recipient's channel. No production HTTP
  contract exposes tokens for tests' convenience.
- Local manual flow: `pnpm infra:up`, register in the web demo and complete
  via the Mailpit completion link (the account is created verified), then
  change your email on the Account security page: a verification email for
  the new address lands in the Mailpit UI (http://localhost:8025) — follow
  the link.

## External provider validation

**Status: NOT performed.** No provider credentials or sandbox inbox exist in
this repository's environments, so no claim of external delivery is made and
ORG-PR-002 remains open (materially advanced). The safe procedure once an
operator has credentials:

1. In a throwaway shell (never committed): `NODE_ENV=production` plus real
   `JWT_SECRET`, `COOKIE_SECURE=true`, `MAIL_DRIVER=smtp`, the provider's
   `SMTP_HOST`/`SMTP_PORT=465`/`SMTP_USERNAME`/`SMTP_PASSWORD`, a real
   `MAIL_FROM_EMAIL` on a domain with SPF/DKIM configured at the provider,
   and an https `WEB_DEMO_URL`.
2. Start the API, register with a test-inbox address you control, and confirm
   the registration-completion email arrives externally and its link
   completes (creating the account).
3. Record the provider name, timestamp, and message-id as evidence in the
   findings register — then, and only then, close ORG-PR-002.
