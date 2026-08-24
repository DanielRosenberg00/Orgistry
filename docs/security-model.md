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
- **Access-token key rotation (Sprint 24).** An optional `JWT_PREVIOUS_SECRET`
  is accepted **at verification only** — tokens are always signed with the
  current key alone — so a signing-secret rotation does not interrupt tokens
  already in flight. The two keys must differ, both are held to the same
  production strength rules, a token signed with any other key is rejected, and
  expiry/claim/session/authorization semantics are unchanged. Removing the
  previous key immediately invalidates every token signed with it: that is the
  emergency path, deliberately distinct from graceful rotation. See
  [runtime-secrets.md](runtime-secrets.md#access-token-secret-rotation) and
  [rotation-runbook.md](rotation-runbook.md).
- **Runtime secret sources (Sprint 24).** Secrets are read once at process
  start from a direct environment value or a mounted `<NAME>_FILE` secret.
  Resolution happens *before* validation and normalizes onto the canonical
  variable name, so a file-backed secret cannot bypass the production guard;
  setting both forms of one variable fails closed. No secret is read at image
  build time or embedded in the frontend bundle.
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
  (login per-IP/per-email, registration request per-IP/per-email-digest and
  completion per-IP/per-token-digest, refresh
  per-session/per-IP, email-verification request per-user/per-IP and
  completion per-IP, password-recovery request per-IP/per-email-digest and
  completion per-IP/per-token-digest, password/email change per-user) and the
  external API (per-key, per-org). No raw email or token material enters a
  limiter key — emails and tokens are digested first. Since Sprint 19 the
  failure mode is configurable: sensitive limiters **fail closed in
  production** (a Redis outage → `503 SERVICE_UNAVAILABLE`) and fail open in
  development/test — see the edge-hardening section below.
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
  a code-defined permission catalog, seeded idempotently. Role identity is
  consulted only for the two structural invariants below (Last Owner, DG-2).
  The organization read route enforces `org.read` like every other surface;
  the ONE intentional membership-only read is
  `…/permissions/effective` — a member reading their OWN effective
  permissions, which cannot be permission-gated without circularity (a stable,
  documented contract — Sprint 20, ORG-PR-053).
- **Owner role-transition policy (DG-2, enforced Sprint 20).** Only an active
  Owner may grant the Owner role, and only an active Owner may remove it —
  including by removing an Owner member. An Admin holds `members.change_role`
  but may not confer or strip Owner (self or others). Permission to change
  roles and AUTHORITY over the Owner role are distinct: the permission gate
  runs first (403 for Member/Viewer), then, inside the mutation transaction,
  any Owner-touching change requires the actor's membership to be in the
  LOCKED active-owner set — so a concurrently demoted actor cannot still
  confer Owner. Violations return the standard safe 403 after target
  resolution (cross-tenant probes keep the uniform 404).
- **Last Owner protection.** Every active organization keeps at least one active
  Owner. Role changes and member removals that would drop the last Owner are
  rejected **transactionally** (`LAST_OWNER_REQUIRED` is unchanged and checked
  after the DG-2 authority rule).
- **Entitlement and quota separation.** Three orthogonal checks: **permission**
  (what the user may do), **entitlement** (what the plan unlocks, e.g.
  `api_keys_access`, `audit_log_access`), and **quota** (how much may be used,
  e.g. `max_projects`, `max_members`, `max_api_keys`). Permission is checked
  before entitlement before quota, so failures are attributed correctly
  (`FORBIDDEN` vs `ENTITLEMENT_REQUIRED` vs `QUOTA_EXCEEDED`). Since Sprint 20
  every quota-protected creation serializes its ENTIRE quota decision in one
  transaction under a per-(organization, quota kind) advisory lock
  (`quota-lock.ts`): the CURRENT plan ceiling is resolved through the same
  transaction (plan row `FOR SHARE`, serialized against concurrent plan
  changes — no pre-resolved limit crosses into the transaction), then the
  count, comparison, and insert follow, so neither concurrent requests nor a
  concurrent plan change can overrun a ceiling. A plan DOWNGRADE never
  revokes existing rows (creation-time enforcement only — documented product
  policy); the lock order and deadlock rationale are documented in
  [sprint-20-quota-race-audit.md](production-readiness/sprint-20-quota-race-audit.md).

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

## Credential management (Sprint 17)

- **Password recovery.** A dedicated `password_reset_tokens` table (hash-only,
  1 h default TTL, single-use, sibling-invalidated) backs the public
  request/complete pair. Issuance serializes per user (user-row
  `SELECT … FOR UPDATE`), so concurrent requests leave exactly one usable
  generation (older emails then carry a superseded token by design), and
  follows **persist-and-commit before send**: every emailed token was
  durably committed before the mailer saw it — a persistence failure sends
  no email; an undelivered or superseded persisted token is harmless and
  retired by the next generation. The request endpoint is
  **enumeration-safe by contract**: identical `{ accepted: true }` for
  existing, unknown, disabled, and soft-deleted accounts — even when the
  account lookup, token persistence, the mail send, or the security-event
  write fails internally. Request events
  are always **anonymous** (null user/session, coarse outcomes, no email or
  account reference — submitting an email authenticates nobody); a
  successful completion is attributed to the resolved user by token proof
  (the verification-completion convention), and rejections are anonymous.
  Reset links use the same fragment-only transport as verification
  (`/auth/reset-password#token=…`).
- **Reset completion revokes everything.** One `FOR UPDATE` transaction
  replaces the password hash, consumes the token, invalidates siblings, and
  revokes EVERY session and refresh token of the user. No session is issued —
  the user signs in again; old access tokens die at session revalidation and
  old refresh cookies classify as reuse.
- **Password change.** Requires the current password; the session that proved
  it survives, every other session and its refresh tokens are revoked in the
  same transaction as the hash swap. A wrong current password returns
  `INVALID_CREDENTIALS` at 400 (the session is valid; 401 would mimic expiry).
  Reusing the current password as the new one is rejected.
- **Email change.** Requires the current password (direct-change policy). The
  transaction swaps the address, clears `email_verified_at`, and invalidates
  all outstanding verification tokens; a fresh verification email goes to the
  new address best-effort. Duplicate emails surface the registration 409 —
  an accepted disclosure on this password-re-proved authenticated surface.
- **Shared password policy.** One `newPasswordSchema` (contracts) is parsed by
  registration, reset completion, and password change; the policy cannot
  drift between routes.
- **Registration de-enumeration — closed by Sprint 18.** The Sprint 17
  posture (throttled, evented `409`) was an accepted interim; the
  verification-first registration redesign it pointed to has since shipped —
  see the next section.

## Verification-first registration (Sprint 18)

- **Enumeration-safe request, like recovery.** `POST /v1/auth/register`
  always returns the same `200 { accepted: true }` — for eligible new emails,
  existing active accounts (verified or not), disabled accounts, soft-deleted
  accounts, EVERY private invitation-validation failure (unknown token,
  expired/revoked/accepted lifecycle, email mismatch, quota — a rejected
  invitation stages nothing, mutates nothing, and sends nothing; the
  invitation-INSPECT endpoint is the sole invitation-feedback channel), and
  every internal failure (lookup/persist/mail) — and never returns
  `EMAIL_ALREADY_REGISTERED` or any `INVITATION_*` error (the former survives
  only on the authenticated change-email flow). Rate limits (per IP, per
  email digest) are applied BEFORE any account lookup, and the Argon2id hash
  is computed before anything state-dependent so the CPU cost is identical on
  all paths.
- **No auth state before mailbox proof.** The request creates no user,
  session, access token, refresh cookie, organization, or membership. An
  eligible new email stages a hash-only `pending_registrations` row (Argon2id
  password hash, SHA-256 completion-token hash, optional stable invitation id
  — never the invitation token) with issuance serialized per email by an
  advisory lock, so exactly one usable generation exists per email (partial
  unique index as the structural backstop).
- **Completion creates everything, transactionally.**
  `POST /v1/auth/registration/complete` (token in the body; per-IP and
  per-token-digest throttles) locks the pending row `FOR UPDATE` and, in one
  transaction, creates the user **email-verified at creation** (the emailed
  token is the mailbox proof — registration sends no verification email), the
  personal workspace + Owner membership, and the session + first refresh
  token (hash-only), and accepts a stored invitation where applicable
  (re-checked inside a savepoint; an unavailable invitation is reported, not
  fatal). The refresh cookie is set only after commit; exactly one of any set
  of concurrent completions succeeds.
- **Existing accounts get guidance, not tokens.** An attempt against an
  existing active address sends a throttled, neutral guidance email (sign in
  / use recovery; ignore if not you) — never a reset or verification token.
  Disabled/soft-deleted accounts get nothing. Registration security events
  are always anonymous and never reference the victim's user id.
- **Residual timing channel, honestly.** Response timing on the register
  request is not fully equalized: the new-email path still performs one
  insert and one mailer hand-off. This is bounded by the pre-lookup per-IP
  and per-email-digest limits and documented in
  [auth-foundation.md](auth-foundation.md), the authoritative design
  reference for this flow.

## Edge and application hardening (Sprint 19)

The full design and evidence live in
[production-readiness/sprint-19-artifact-package.md](production-readiness/sprint-19-artifact-package.md).

- **Trust boundary: typed proxy trust.** `TRUST_PROXY` (in `packages/config`)
  controls whether forwarded headers are believed, applied at Fastify
  construction (`apps/api/src/app.ts`). `'false'` (the default) means direct
  exposure — forwarded headers are ignored and `request.ip` is the socket
  peer; a positive integer is a trusted reverse-proxy hop count, accepted range
  1–16 (use `1` for
  one TLS-terminating proxy); a comma-separated proxy IP/CIDR list is also
  accepted and validated semantically (real IPv4/IPv6 addresses via
  `node:net`, CIDR prefixes 0–32/0–128; hostnames, malformed entries, and
  empty list entries fail boot); the literal `'true'` is **rejected at boot**
  (it would trust arbitrary client-supplied headers). `request.ip` is the single source of
  client identity for rate-limit keys, request logs, audit IPs, and
  security-event IPs. Misconfiguration risk: a too-high hop count lets clients
  spoof their IP; a too-low one collapses everyone into the proxy IP.
- **Security headers on every response.** Every API response (success, error
  envelope, 404, CORS preflight) carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, and a restrictive
  `Permissions-Policy`; `Strict-Transport-Security` only under
  `NODE_ENV=production` AND a proxy-aware HTTPS request protocol (a forged
  `X-Forwarded-Proto` on an untrusted connection never mints HSTS); `Cache-Control: no-store` on `/v1/auth/*` and
  `/v1/invitations/*`. This is an API response policy, not a frontend CSP (SPA
  CSP hardening remains a known limitation). CORS and CSRF are unchanged.
- **Rate-limit architecture: global + route-specific.** One **global**
  fixed-window bucket per trusted client IP (`RATE_LIMIT_MAX`, default 300 per
  `RATE_LIMIT_WINDOW_SECONDS`, default 60) is evaluated before route-specific
  work on every route except `/health`, `/ready`, and `OPTIONS` preflight; it
  fails open by design (readiness takes the instance out of rotation).
  Route-specific buckets key on the right dimension per surface: per trusted
  IP, per user, per org, per key, or per digest. **No raw email, token, or key
  material ever enters a Redis key** — invitation-inspect throttling, for
  example, keys on `sha256(sha256(rawToken))`. Mutation buckets (org create,
  project create, project update/delete, API-key create, demo plan change,
  invitation create, member role change/removal) run **after** permission
  checks; permission-first authorization, the uniform cross-tenant 404,
  quotas, and entitlements are unchanged. Revokes (invitation, API key,
  session) stay deliberately unthrottled: a revoked resource cannot be
  revoked twice, so their durable writes are capped by creation — which is
  itself throttled.
- **Read buckets: one exception, deliberately (Sprint 22, ORG-PR-055).** Reads
  are otherwise covered by the global bucket alone, because each costs at most
  one indexed page with a capped page size. `GET
  /v1/organizations/:id/audit-events` is the exception: its `targetId` filter
  compares against JSONB metadata keys that carry no index, so a filter
  matching nothing scans the organization's whole slice of `security_events`
  — a table with no retention policy yet (ORG-PR-015). It therefore carries
  its own ceilings, `rl:audit:read:user:<userId>`
  (`RATE_LIMIT_AUDIT_READ_PER_USER_MAX`, default 60/60s) and
  `rl:audit:read:org:<organizationId>`
  (`RATE_LIMIT_AUDIT_READ_PER_ORG_MAX`, default 240/60s), enforced after the
  membership, permission, AND entitlement gates. The rule this encodes: a
  read needs its own bucket when its cost is not bounded by its page size.
- **Redis failure policy.** `RATE_LIMIT_FAILURE_MODE` (`open`|`closed`; unset
  derives production→`closed`, development/test→`open`; production **refuses**
  an explicit `open` at boot). In `closed` mode a Redis outage makes sensitive
  rate-limited endpoints (login, refresh, registration, password recovery,
  email verification, invitation inspect/accept/create, the external API
  buckets, the mutation buckets, the audit-read buckets) reject with a generic
  `503 SERVICE_UNAVAILABLE` (request id included, no Redis details). Store
  failures are logged (sanitized). Alerting/monitoring on this state does not
  exist yet.
- **Bounded failed-auth event writes.** Failed external API-key
  authentication (the uniform 401 family) writes durable `security_events`
  rows only within an allowance per source IP
  (`RATE_LIMIT_EXTERNAL_AUTH_FAIL_EVENTS_PER_IP_MAX`, default 10 per window);
  beyond it — or if Redis is down — the durable write is skipped and a
  sanitized log line retains visibility. The 401 response contract is
  unchanged; valid keys are unaffected.
- **Logger redaction backstop.** All process loggers are built by
  `apps/api/src/lib/logging.ts` (`buildLoggerOptions`) with pino redact paths
  covering authorization/cookie headers, the configured CSRF header,
  passwords, tokens, hashes, API-key and SMTP/JWT secrets across
  header/body/config/error shapes (censor `[REDACTED]`). It is
  defense-in-depth behind the standing policy of never logging request
  bodies/credentials; being path-based, deeply nested or novel keys are not
  caught.
- **Request-id sanitization.** An inbound `x-request-id` is accepted only if
  it matches `[A-Za-z0-9._-]{1,128}`; anything else is replaced by a
  server-generated `req_<uuid>` before any logging. See
  [api-conventions.md](api-conventions.md).
- **Coarse production readiness.** `/ready` in production returns
  `200 {status:'ready'}` or a generic 503 with no dependency names/details;
  development/test keep per-dependency output. Redis is a required readiness
  dependency, consistent with the fail-closed limiters.

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
- **Bounded history (Sprint 25).** `security_events` is no longer unbounded: the
  retention cleanup deletes rows older than `RETENTION_SECURITY_EVENT_DAYS`
  (default 180) on an index-backed `created_at` predicate. The window is a
  security decision, not just a storage one — it is the period over which an
  investigation can reconstruct authentication and authorization activity. The
  default sits above every plan's advertised `audit_retention_days`, and the
  configured floor (30 days) prevents an operator from accidentally reducing
  the forensic window to nothing. See [retention.md](retention.md).

## Data durability and backups (Sprint 25)

- **One durable store.** PostgreSQL holds every piece of state whose loss is
  unrecoverable. Redis holds only TTL-bounded rate-limit counters; images and
  bundles are rebuildable from source; logs are evidence, not a restore source;
  there is no object storage. The inventory and the evidence behind each
  classification are in
  [backup-and-restore.md](backup-and-restore.md#1-persistent-data-inventory).
- **A backup is a credential-grade artifact.** A logical backup contains every
  user and organization record, the full security-event history, Argon2id
  password hashes, and the SHA-256 hashes behind every refresh token,
  verification/reset/registration token, invitation, and API key. Repository
  controls: `backups/`, `*.dump`, and `*.dump.sha256` are git-ignored; the
  backup tool refuses to write inside `.git`; artifacts are created under
  `umask 077` and `chmod 600`; the connection URL is passed by environment
  variable and never reaches a filename, a log line, or the metadata sidecar;
  the drills delete their artifacts on exit.
- **The checksum is integrity, not confidentiality.** Nothing in this
  repository encrypts a backup, and the metadata sidecar records
  `"encrypted": false` explicitly. Encryption at rest and least-privilege
  backup/restore identities are deployment responsibilities (ORG-PR-001,
  ORG-PR-006 — both open).
- **Recovery is proven, not asserted.** The restore drill recovers into a fresh
  database and drives the packaged API artifact against it, including an
  API-key-authenticated read whose credential hash came out of the restored
  database — and asserts that an unknown key is still rejected, so a restore
  cannot silently widen authentication. PITR is verified separately
  ([pitr.md](pitr.md)).

## Known non-production limitations

This model omits, by design: OAuth/MFA/passkeys, externally validated
production email delivery (the production SMTP adapter exists but has never
sent through a real provider, and no sender domain or SPF/DKIM/DMARC posture
has been validated), any secrets manager or automated secret rotation (Sprint
24 delivered runtime secret sources plus manual rotation procedures — not a
manager), a platform-wide session-invalidation API (operator SQL only),
verification **enforcement** (the flag is
advisory), any SCHEDULER for the retention and backup commands (both are
real, tested, one-shot commands since Sprint 25 — nothing invokes them
periodically, and nothing alerts on a failed run), scheduled or encrypted
remote backup storage, continuous WAL archiving on any long-lived database,
database RLS, per-plan audit retention enforcement, audit export, custom
roles, and resource-level permissions. Quota checks are serialized
in-transaction since Sprint 20 (no race-window trade-off remains — see
[entitlements](./entitlements-plans-quotas.md)); non-sensitive rate limiting
fails open on a Redis outage (sensitive endpoints fail closed in production,
with no alerting on that state yet). See
[known limitations](./known-limitations.md) for the full list. Do not treat
Orgistry as a hardened, certified system.
