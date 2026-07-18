# Security Model

A concise summary of Orgistry's security posture as currently implemented. It is
understandable on its own; the per-sprint references
([auth](./auth-foundation.md), [sessions](./session-lifecycle.md),
[RBAC](./rbac-permissions.md), [entitlements](./entitlements-plans-quotas.md),
[API keys](./api-keys-external-api.md), [invitations](./invitations.md),
[audit](./audit-log.md)) carry the design detail.

Orgistry is a **non-production reference**. The mechanisms below are
deliberately real and reviewable, but the system is not security-certified and
omits production concerns (see [known limitations](./known-limitations.md)).

## Credentials and tokens

- **Password hashing.** Passwords are hashed with **Argon2id** and stored
  hash-only. No response field ever carries a password or hash. Weak passwords
  are rejected at the request boundary before any hashing.
- **Access tokens.** Short-lived **JWTs** (default 15 min), signed with
  `JWT_SECRET`, presented as `Authorization: Bearer`. The web demo holds them in
  memory only — never `localStorage`/`sessionStorage`.
- **Refresh cookie.** The refresh credential is a high-entropy **opaque** string,
  stored **hash-only**, delivered exclusively through an **HttpOnly,
  SameSite=Lax** cookie scoped to the auth path. It never appears in a response
  body. `Secure` is controlled by `COOKIE_SECURE` (true in HTTPS environments).
  Under `NODE_ENV=production`, config loading refuses `COOKIE_SECURE=false` and
  dev-default/weak `JWT_SECRET` values, so an unsafe production process cannot
  boot — see [production-config-guard.md](production-config-guard.md). The
  cookie is intentionally **unsigned**: its integrity model is the hashed,
  rotated, high-entropy refresh token itself (the former `COOKIE_SECRET`
  variable was dead config and was removed in Sprint 15).
- **Refresh token rotation.** Refresh rotates **transactionally** — exactly one
  successor per token. The previous token is consumed on use.
- **Refresh reuse detection.** Presenting an already-rotated (stolen/replayed)
  refresh token revokes the **entire token family and its session**, forcing
  re-authentication.

## Request-level protections

- **CSRF posture.** Cookie-backed mutations (refresh, logout) require a custom
  header (`AUTH_CSRF_HEADER_NAME`, default `x-orgistry-csrf`). A cross-site
  attacker cannot set a custom header without a CORS preflight, which the strict
  origin allow-list denies. The CSRF defense is never on the auth-correctness
  path.
- **Rate limits.** Redis-backed fixed-window limiters protect auth surfaces
  (login per-IP/per-email, register per-IP, refresh per-session/per-IP,
  email-verification request per-user/per-IP and completion per-IP) and the
  external API (per-key, per-org). They **fail open**: if Redis is down, requests
  are allowed rather than blocked, so an outage never breaks authentication.
- **Session revocation.** Sessions can be listed and individually revoked;
  revoking the current session clears the refresh cookie. Reuse detection revokes
  sessions automatically.

## Authorization and tenancy

- **Organization tenant isolation.** Every organization-scoped query is keyed on
  the route **organization ID** (never the slug, which is display-only). Cross-
  tenant access returns an indistinguishable `404` so existence never leaks.
  Isolation is enforced in the application layer (no database RLS).
- **Permission-first authorization.** Organization routes compose
  `requireMembership → requirePermission(actor, "<permission.key>")` — authorization
  is keyed on **permission**, never a role-name check. The four fixed roles map to
  a code-defined permission catalog, seeded idempotently. The single place a role
  name is consulted is the Last Owner invariant.
- **Last Owner protection.** Every active organization keeps at least one active
  Owner. Role changes and member removals that would drop the last Owner are
  rejected **transactionally**.
- **Entitlement and quota separation.** Three orthogonal checks: **permission**
  (what the user may do), **entitlement** (what the plan unlocks, e.g.
  `api_keys_access`, `audit_log_access`), and **quota** (how much may be used,
  e.g. `max_projects`, `max_members`, `max_api_keys`). Permission is checked
  before entitlement before quota, so failures are attributed correctly
  (`FORBIDDEN` vs `ENTITLEMENT_REQUIRED` vs `QUOTA_EXCEEDED`).

## Machine access (API keys)

- **Hash-only storage.** A raw key (`orgistry_<displayId>_<secret>`) is shown
  **once** at creation. Only its display prefix and a unique SHA-256 `secret_hash`
  are persisted; the raw secret is unrecoverable afterward.
- **Scopes.** Keys carry typed scopes (v1 ships `projects:read`). The external API
  authorizes by scope, not by user role, and re-checks the `api_keys_access`
  entitlement on every request.
- **Not user sessions.** API keys are organization-scoped machine credentials —
  not user impersonation. The external route takes **no organization ID** (the
  tenant is derived from the key row) and accepts **no browser JWT**. Revoked or
  expired keys cannot authenticate; revocation is audited and idempotent.

## Email verification (Sprint 16)

- **Hash-only, expiring, single-use tokens.** Verification tokens are 32-byte
  CSPRNG values stored only as SHA-256 hashes; they expire (default 24 h) and
  are consumed transactionally. A `SELECT … FOR UPDATE` row lock makes
  completion race-safe — two concurrent completions of one token can never
  both succeed — and `users.email_verified_at` is set once, conditionally.
- **Fragment-only link transport.** The emailed verification link carries the
  raw token in the URL **fragment** (`/auth/verify-email#token=…`), which
  browsers never send in an HTTP request — so the token cannot reach the web
  server, a reverse proxy, an access log, or a `Referer` header. The frontend
  captures it once into transient memory, removes the fragment from the
  URL/history, and submits it in a POST body; it is never placed in a query
  string, browser storage, or the DOM.
- **Resend replacement.** The authenticated request endpoint doubles as
  resend; every issue invalidates all prior unused tokens in the same
  transaction, so at most one usable token generation exists per user. The
  previously delivered link stays usable until the mailer has accepted the
  replacement message, so a failed resend never strands the user with an
  undelivered sole token (SMTP and the database are not atomic; the residual
  window is documented in
  [email-and-verification.md](./email-and-verification.md)).
- **Header-injection protection.** Every value that reaches an email header
  (sender identity, recipient, subject — including feature-supplied content
  such as organization names) passes one central CR/LF/NUL guard before any
  transport sees it, so no input can forge additional headers or recipients.
- **Enumeration-safe by construction.** Request/resend accepts no email
  address — it operates only on the authenticated user's stored email.
  Completion (public; the token in the request **body**, never a URL) reveals
  token validity only: a token for a missing/disabled account is
  indistinguishable from an unknown token.
- **Advisory in Sprint 16.** The verified flag is exposed on the current-user
  contract and shown in the web demo, but nothing gates on it yet;
  enforcement is a future, deliberate server-side change.
- **Deterministic mailer selection.** Account email (invitations +
  verification) flows through one explicit driver (`MAIL_DRIVER`). Production
  config refuses the local Mailpit and in-memory drivers, placeholder SMTP
  credentials, non-routable senders, and non-HTTPS/localhost public web URLs
  — see [email-and-verification.md](./email-and-verification.md).

## Invitations

- **Hash-only token storage.** The raw invitation token is high-entropy and opaque,
  delivered **only** in the invitation email (via the shared account mailer;
  Mailpit locally) and carried in request **bodies**, never URLs — so it is
  never logged. Only its SHA-256 hash is stored.
- **Email-match enforcement.** Acceptance (including registration-with-invitation)
  requires the accepting account's email to match the invited email. Invitations
  are single-use and expiring (expiry derived on read; no worker).
- **No session escalation.** Accepting an invitation creates a **membership, never
  a session**. An invited new user still receives their own personal workspace.

## Audit

- **Defensive metadata sanitization.** The organization-scoped audit read API
  (`audit_events.read` permission + `audit_log_access` entitlement) sanitizes
  event metadata: safe opaque IDs (project/membership/API-key/invitation) survive,
  while secrets, hashes, tokens, headers, cookies, and IP/user-agent/session data
  are stripped. Authentication/session security events are kept out of the default
  stream.

## Known non-production limitations

This model omits, by design: OAuth/MFA/password reset, externally validated
production email delivery (the production SMTP adapter exists but has never
sent through a real provider), verification **enforcement** (the flag is
advisory), database RLS, audit retention enforcement/export, custom roles,
resource-level permissions, and hardened concurrency on quota checks. Rate limiting and quotas
accept fail-open and race-window trade-offs respectively. See
[known limitations](./known-limitations.md) for the full list. Do not treat
Orgistry as a hardened, certified system.
