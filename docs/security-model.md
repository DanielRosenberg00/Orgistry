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
  (login per-IP/per-email, register per-IP, refresh per-session/per-IP) and the
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

## Invitations

- **Hash-only token storage.** The raw invitation token is high-entropy and opaque,
  delivered **only** in the invitation email (SMTP → Mailpit) and carried in
  request **bodies**, never URLs — so it is never logged. Only its SHA-256 hash is
  stored.
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

This model omits, by design: OAuth/MFA/password reset, production email, database
RLS, audit retention enforcement/export, custom roles, resource-level
permissions, and hardened concurrency on quota checks. Rate limiting and quotas
accept fail-open and race-window trade-offs respectively. See
[known limitations](./known-limitations.md) for the full list. Do not treat
Orgistry as a hardened, certified system.
