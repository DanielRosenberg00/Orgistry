# Secure Session Lifecycle (Sprint 3)

The secure browser session lifecycle built on top of the Sprint 2 auth
foundation: refresh-token issuance + rotation, an HttpOnly refresh cookie,
refresh-token reuse detection with family revocation, logout, current-user
session listing and revocation, a CSRF header requirement on cookie-backed
mutations, and Redis-backed auth rate limiting. Together these complete a
coherent browser authentication lifecycle.

This sprint adds **behavior** to schema that already existed. The
`refresh_tokens` family columns (`family_id`, `parent_token_id`,
`replacement_token_id`, `used_at`, `revoked_*`) and the `sessions.revoked_*`
columns shipped as scaffolding in Sprint 2, so Sprint 3 required **no new
migration**.

See [`auth-foundation.md`](auth-foundation.md) for the register/login/me
foundation this extends, and [`api-conventions.md`](api-conventions.md) for the
shared envelope/error/pagination conventions.

## A. Developer Documentation

### What was implemented

| Capability | Where |
| --- | --- |
| Refresh issuance during register/login (1 family per login) | `apps/api/src/modules/auth/auth.service.ts` (`issueSession`) |
| Centralized HttpOnly refresh cookie (set/clear/read) | `apps/api/src/lib/cookies.ts` |
| Refresh endpoint + transactional rotation | `auth.routes.ts`, `auth.service.ts`, `auth.repo.ts` (`rotateRefreshToken`) |
| Refresh reuse detection + family/session revocation | `auth.service.ts` (`refresh`), `auth.repo.ts` (`revokeRefreshTokenFamily`, `revokeSession`) |
| Logout (server-side revoke) | `auth.service.ts` (`logout`) |
| Session list (cursor-paginated, user-scoped) | `auth.service.ts` (`listSessions`), `auth.repo.ts` (`listActiveSessionsForUser`) |
| Session revocation (owner-scoped) | `auth.service.ts` (`revokeSession`) |
| CSRF header guard on cookie-backed mutations | `auth.routes.ts` (`requireCsrfHeader`) |
| Redis-backed auth rate limiting | `apps/api/src/lib/rate-limit.ts`, `auth.service.ts` (`enforceRateLimit`) |
| Session lifecycle security events | `auth.service.ts`, `security-events.ts` |
| Session/refresh contracts + error codes | `packages/contracts/src/auth.ts`, `error-codes.ts` |
| Refresh TTL, cookie attributes, CSRF header, rate-limit buckets | `packages/config` |

### Endpoints

```
POST   /v1/auth/refresh             -> 200 { tokens }       cookie + CSRF header
POST   /v1/auth/logout              -> 200 { success }      cookie + CSRF header
GET    /v1/auth/sessions            -> 200 { items, nextCursor, hasMore }   Bearer
DELETE /v1/auth/sessions/:sessionId -> 200 { success }      Bearer
```

Register and login are unchanged in JSON shape (`201/200 { user, tokens }`) but
now **also** emit a `Set-Cookie` for the refresh credential.

### How it works

**Access token vs refresh token.** The access token is a short-lived,
stateless JWT (15 min) presented as `Authorization: Bearer`. It authorizes API
calls. The refresh token is a long-lived (30 day) opaque, high-entropy random
string stored hash-only, delivered **only** through the HttpOnly cookie. It
authorizes minting a *new* access token and nothing else. The two never share a
channel: the access token is never in a cookie; the refresh token is never in a
JSON body, log, or security event.

**Issuance.** `register`/`login` create the user (register only), a session, an
access token, and the first refresh token of a new family
(`parent_token_id = null`). The raw refresh token is returned out of the service
as `rawRefreshToken` and set as the cookie by the route; the database stores
only its SHA-256 hash.

**Refresh + rotation.** `POST /v1/auth/refresh` requires the CSRF header, reads
the cookie, and rotates: the presented token is hashed, looked up, validated
(exists / not used / not revoked / not replaced / not expired; session exists /
not revoked / not expired), marked used and linked to a single new successor in
the same family, and the cookie is rotated to the successor. A fresh access
token is returned.

**Transactional rotation invariant.** Rotation runs inside a single PostgreSQL
transaction that locks the presented token row `FOR UPDATE`. Two concurrent
refreshes of the same token therefore serialize: the first marks the row used
and inserts a successor; the second, once it acquires the lock, sees a used row
and is classified as **reuse**. *Exactly one successor can ever be minted per
presented token* — concurrency cannot fork a family. PostgreSQL/token state is
the sole source of authentication truth; Redis is never consulted for
correctness.

**Reuse detection.** A presented refresh token that is already used, replaced,
revoked, expired-by-session, or whose session is revoked/expired is treated as
compromised. Detection covers: token used, token replaced, token revoked, token
belongs to a revoked session, family already revoked, and a stale token
presented after a newer one exists (all collapse to the "already consumed" or
"session invalid" checks).

**Reuse / revocation invariant (explicit).** On reuse detection the service
revokes **the entire token family AND its session** — every refresh token minted
from that login, plus the session itself — then clears the cookie and returns a
generic `TOKEN_REUSE_DETECTED`. No new access token is issued. This is the
strongest safe response: once any token in a family is presented after it should
have been retired, the family must be assumed stolen, so nothing derived from
that login is allowed to survive.

**Logout.** `POST /v1/auth/logout` requires the CSRF header, reads the cookie,
revokes the session and all its refresh tokens server-side, clears the cookie,
and returns success. It is idempotent: with no cookie (e.g. a repeat call) it
still clears and returns success. A subsequent refresh with the old cookie fails
(the token is now revoked → reuse).

**Session list.** `GET /v1/auth/sessions` requires a Bearer token and returns a
cursor page of the caller's **active** (non-revoked, non-expired) sessions,
newest first, each marked `current` if it is the session the access token is
bound to. Only non-sensitive metadata is exposed (id, timestamps, expiry,
user-agent, IP) — never token hashes or family ids.

**Session revocation.** `DELETE /v1/auth/sessions/:sessionId` requires a Bearer
token, revokes one of the caller's own sessions and that session's refresh
tokens, and is idempotent on an already-revoked session. Revoking another user's
(or a non-existent) session returns an identical `404` so session ids cannot be
probed. Revoking the *current* session clears the refresh cookie.

**CSRF model.** Cookie-backed mutations (`refresh`, `logout`) require a custom
header (`x-orgistry-csrf` by default); its mere presence is sufficient. The
defense is the combination of three things: `SameSite=Lax` on the cookie, the
strict CORS allow-list in API config, and the required custom header — a
cross-site page cannot attach a custom header without a CORS preflight that the
allow-list denies. No double-submit token value is implemented at this stage
(see §B).

**Rate limiting.** Redis-backed fixed-window buckets, all values from typed
config: login-per-IP, login-per-email (email hashed into the key), register-per-IP,
refresh-per-session, refresh-per-IP. Exceeding a bucket returns `RATE_LIMITED`
with the standard envelope and request id. The limiter **fails open**: a Redis
outage disables limiting but never affects auth correctness.

### How to extend it safely

- **New cookie-backed mutation**: read/clear via `apps/api/src/lib/cookies.ts`
  (never hand-serialize a `Set-Cookie`), and call `requireCsrfHeader` in the
  route. Cookie attributes come only from `config.auth.refreshCookie`.
- **New rate-limit bucket**: add a typed value in `packages/config`, then call
  `enforceRateLimit(key, limit, bucketName, ctx)` in the service. Keys are
  namespaced `rl:<surface>:<dimension>:<value>`; hash any PII (e.g. email) into
  the key.
- **New refresh/session state transition**: keep the atomic compare-and-swap in
  `auth.repo.ts` (it is the only place that can guarantee atomicity); keep the
  *policy* (what to revoke, what to log) in `auth.service.ts`.
- **New security event**: add the dotted name to `SECURITY_EVENT_TYPES` and
  write it through `writeSecurityEvent` so it is sanitized; never put a raw
  token, hash, cookie, or authorization header in metadata.

## B. Architectural Notes

### Key design decisions

- **Refresh credential travels only via an HttpOnly cookie.** Keeping it out of
  every JSON body (and thus out of JS-readable storage and logs) is the single
  biggest XSS/exfiltration mitigation. The access-token response shape is
  therefore unchanged from Sprint 2 — the cookie is a strictly out-of-band
  channel.
- **Transactional, lock-based rotation.** Atomicity is enforced where it can
  actually be guaranteed — a `FOR UPDATE` row lock in PostgreSQL — not in
  application code. The repository owns the atomic swap; the service owns the
  security policy. The in-memory test repository reproduces the same guarantee
  by performing its classify-and-swap with no intervening `await`.
- **Family-and-session revocation on reuse.** Revoking the whole family plus the
  session (rather than only the presented token) is the conservative, standard
  response to refresh-token reuse — it assumes theft and kills every derived
  credential.
- **Header-presence CSRF, not double-submit.** With `SameSite=Lax` + a strict
  CORS allow-list, requiring a custom header is sufficient to block cross-site
  forgery for this sprint. A signed double-submit token adds moving parts
  (token minting, storage, rotation) without changing the threat model at this
  stage; it is deliberately deferred.
- **Redis is advisory, never authoritative.** Rate limiting is explicitly
  outside the auth-correctness boundary and fails open. This preserves the
  Sprint 2 invariant that a Redis outage can never reject a valid credential or
  accept an invalid one.

### Tradeoffs

- **Concurrent double-submit can revoke a family.** Two truly-simultaneous
  refreshes of the same token (e.g. a double-clicked tab) produce one success;
  the loser is indistinguishable from theft and triggers family revocation, so
  the user is signed out. This is the accepted, secure-by-default cost of
  reuse detection — favoring safety over tolerating accidental concurrency.
- **Per-email login bucket as a (non-)oracle.** The per-email limit is checked
  before any user lookup and returns the identical `RATE_LIMITED` regardless of
  whether the email exists, so it does not leak account existence; the email is
  also hashed into the Redis key so no raw address is stored.
- **Revoked-token presentation always reads as reuse.** A token revoked by a
  clean logout, when presented again, is classified as reuse rather than a
  benign "already logged out". The family is already dead, so this is harmless,
  and it keeps the classification logic simple and conservative.

### Constraints respected

- No new migration — Sprint 2 scaffolding already modeled the columns/indexes.
- Access-token claim shape unchanged: `{ sub, sessionId, type: 'access', iat, exp }`.
- `packages/auth-core` stays primitives-only (it gained no workflow code; the
  cookie helper lives in `apps/api`, the repository owns rotation SQL).
- `packages/db` stays workflow-free (atomic primitive only; policy in service).
- No DB rows returned directly; only DTOs cross the boundary.
- Request ids flow through every error envelope and every security event.

### Rejected alternatives

- **Storing refresh tokens as JWTs** — would make them stateless and
  un-revocable, defeating rotation/reuse detection; rejected.
- **Returning the refresh token in JSON** — exposes it to JS/logs; rejected in
  favor of the HttpOnly cookie.
- **Revoking only the presented token on reuse** — leaves sibling tokens in a
  compromised family usable; rejected for family+session revocation.
- **Double-submit CSRF token this sprint** — unnecessary given SameSite + CORS +
  custom header; deferred.
- **`@fastify/cookie` plugin** — the needed behavior is one HttpOnly cookie with
  fixed attributes; a small dependency-free helper keeps the security-sensitive
  serialization in plain sight and avoids a new dependency.
- **Redis-tracked sessions/tokens** — would put Redis on the auth-correctness
  path; rejected to keep PostgreSQL authoritative.

## C. Contracts & Invariants

These must not change without a deliberate redesign:

- **Refresh credential is cookie-only.** It never appears in a JSON body, log,
  or security event. Persistence stores only its SHA-256 hash
  (`refresh_tokens.token_hash`); the raw token is never stored.
- **Cookie attributes are centralized.** `HttpOnly`, `SameSite=Lax`, path-scoped,
  `Secure` driven by config, `Max-Age` = refresh TTL. Set and clear read the same
  attributes from `config.auth.refreshCookie`, so they cannot drift.
- **Rotation is atomic and single-successor.** Exactly one successor per
  presented token; concurrent refreshes cannot fork a family.
- **Reuse revokes family + session.** On reuse, every token in the family and
  the session are revoked; no access token is issued; the cookie is cleared;
  `TOKEN_REUSE_DETECTED` is returned.
- **Logout is server-side and idempotent.** It revokes the session and its
  tokens, not just the client cookie, and is safe to call repeatedly.
- **Session endpoints are owner-scoped.** A user can only list/revoke their own
  sessions; cross-user access returns `404`.
- **Session DTO exposes no internals.** `{ id, current, createdAt, updatedAt,
  expiresAt, userAgent, ipAddress }` only — never token hashes, token family
  ids, user ids, cookies, authorization headers, or other persistence internals.
  `ipAddress`/`userAgent` are deliberately included: they are the session's own
  client metadata, returned only to that session's authenticated owner (the
  endpoints are Bearer-authenticated and user-scoped), enabling the standard
  "recognize and revoke your devices" UX. It is the owner's own data, so it is
  acceptable non-secret session metadata.
- **CSRF on cookie-backed mutations.** `refresh` and `logout` require the custom
  header; missing → `403 CSRF_REQUIRED` with a request id.
- **Rate limits are Redis-backed, config-driven, fail-open.** Exceeding →
  `429 RATE_LIMITED` with a request id; a Redis outage never affects auth
  correctness.
- **Generic, non-disclosing errors.** `INVALID_REFRESH_TOKEN` is identical for
  missing/unknown/expired tokens; the per-email rate limit does not reveal
  account existence.

### Error codes added

`INVALID_REFRESH_TOKEN` (401), `TOKEN_REUSE_DETECTED` (401), `CSRF_REQUIRED`
(403). `RATE_LIMITED` (429) already existed and is now exercised.

## D. Integration Notes

- **config →** all TTLs, cookie attributes, the CSRF header name, and per-bucket
  rate limits are typed in `@orgistry/config` and injected into the service/
  routes. Nothing reads `process.env` directly.
- **contracts →** routes shape responses to `refreshResponseSchema`,
  `logoutResponseSchema`, `sessionListResponseSchema`,
  `sessionRevocationResponseSchema`, and `sessionSummarySchema`; clients branch
  on the stable error codes.
- **db →** `auth.repo.ts` is the only place that touches Drizzle; the
  transactional `rotateRefreshToken` and the revoke/list helpers are exposed
  through the `AuthRepository` interface used by the service and the in-memory
  fake.
- **Redis →** wired in `server.ts` as `createRedisRateLimiter(redis)`; the same
  client backs the `redis` readiness probe. Two distinct concerns that must not
  be conflated:
  - *Runtime readiness:* Redis remains a required dependency of `GET /ready` —
    a Redis outage makes the service report `503` (unchanged from Sprint 1/2).
    "The rate limiter fails open" does **not** mean "Redis is optional for
    readiness."
  - *Auth-handler correctness:* inside `refresh`/`login`/`register`, a Redis
    error makes `consume()` return "allowed" (fail-open), so a Redis outage
    disables rate limiting but never rejects a valid credential or accepts an
    invalid one. Redis is never consulted for authentication/session
    correctness — that is exclusively PostgreSQL + the token tables.
- **security events →** `auth.refresh_token_rotated`,
  `auth.refresh_token_reuse_detected`, `auth.refresh_failed`,
  `auth.logout_succeeded`, `auth.session_revoked`, `auth.rate_limit_exceeded`
  join the Sprint 2 set, all written through the same sanitizing writer and
  carrying the request id. They remain distinct from (future) organization
  audit logs.
- **Sprint 2 foundation →** sessions and the refresh-token family columns this
  sprint exercises were issued/scaffolded in Sprint 2; the `/v1/auth/me`
  boundary logic is now shared (`requireAuthenticatedSession`) by `me`, session
  listing, and revocation.

## E. Known Limitations

- **Concurrent double-submit signs the user out** (see §B tradeoffs).
- **Fixed-window rate limiting** (not sliding-window/token-bucket); a burst at a
  window boundary can briefly exceed the nominal rate. Adequate for v1 abuse
  control; the bucket maxima are conservative.
- **In-memory limiter is per-process** and exists only for tests/fallback; the
  Redis limiter is the production store.
- **CSRF is header-presence only** — no signed double-submit token this sprint.
- **No session/refresh-token background pruning.** Expired/revoked rows
  accumulate; the existing `expires_at`/`created_at` indexes support a future
  sweep.
- **No email-verification, password-reset, MFA, OAuth, or passkeys** — out of
  scope.
- **No web demo auth UI / authenticated shell** — out of scope; the contracts
  are built to be consumed by one later.
- **Out of scope for Sprint 3 (the session lifecycle):** organizations, personal
  workspaces, memberships, roles, permissions, entitlements, quotas, invitations,
  projects, API keys, external API, organization audit logs. As of Sprint 3,
  registration created only a user + session. **Sprint 4 has since added the
  organization foundation** — registration now also provisions a personal
  workspace (organization + active Owner membership) and team org
  create/list/read exist; see
  [`organization-foundation.md`](organization-foundation.md). Permissions, member
  management, invitations, entitlements, quotas, projects, API keys, and audit
  logs remain out of scope.
- The system is **not** production-certified.

## F. Sprint Changelog

### Iteration summary

Completed the secure browser session lifecycle on top of the Sprint 2 auth
foundation, with no regression to existing behavior and no schema migration.

### Implementation changes

- `packages/config`: `AUTH_REFRESH_TOKEN_TTL_SECONDS`, refresh-cookie
  name/path, `AUTH_CSRF_HEADER_NAME`, and five auth rate-limit buckets with a
  shared window; structured `auth.refreshCookie` and `rateLimit.auth`.
- `packages/contracts`: refresh/logout/session-list/session-revocation DTOs and
  the session summary; `INVALID_REFRESH_TOKEN`, `TOKEN_REUSE_DETECTED`,
  `CSRF_REQUIRED` error codes.
- `apps/api/src/lib`: `cookies.ts` (centralized HttpOnly cookie set/clear/read)
  and `rate-limit.ts` (Redis / in-memory / noop limiters, fail-open).
- `apps/api/src/modules/auth`: refresh issuance in register/login; `refresh`,
  `logout`, `listSessions`, `revokeSession` service workflows; transactional
  `rotateRefreshToken` + revoke/list repository methods (DB + in-memory);
  refresh/logout/sessions routes with CSRF + cookie wiring; six new security
  event types.
- `server.ts`/`app.ts`: wired the Redis rate limiter and cookie/CSRF config.

### Test additions

- `cookies.test.ts`, `rate-limit.test.ts` (limiter unit tests incl. fail-open).
- `session-lifecycle.routes.test.ts` (23 cases: cookie attributes, rotation,
  reuse, logout, listing, revocation, CSRF, concurrency).
- `rate-limit.routes.test.ts` (per-IP/email/session buckets, no existence leak).
- `session-lifecycle.integration.test.ts` (DB-backed: hash-only persistence,
  transactional rotation, reuse revocation, concurrency) — runs with infra up.
- Extended config, contracts, and security-event unit tests.

### Documentation additions

- This document; `sprint-3-artifact-package.md`; updates to
  `auth-foundation.md`, `api-conventions.md`, `README.md`, and `.env.example`.
