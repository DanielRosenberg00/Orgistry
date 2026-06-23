# Auth Foundation (Sprint 2)

Orgistry's initial authentication foundation: durable auth persistence, Argon2id
password handling, JWT access tokens, and `register` / `login` / `me` endpoints,
plus durable security events. It is built so the next sprint can add secure
session lifecycle behavior (refresh rotation, logout, session management) without
redesigning the user model, session model, token primitives, claim shape, auth
contracts, password hashing, email normalization, or security-event persistence.

This sprint deliberately stops short of sessions-as-a-feature: there is no
refresh endpoint, logout, session listing/revocation, or email-verification
flow. Registration creates **only** a user and a session — no organization,
workspace, membership, role, or permission.

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
POST /v1/auth/register   -> 201 { user, tokens }
POST /v1/auth/login      -> 200 { user, tokens }
GET  /v1/auth/me         -> 200 { user }     (requires Authorization: Bearer <token>)
```

All responses use the standard success/error envelopes and carry a request id.

### How it works

**Register.** Validate body (Zod) → normalize email → reject if the normalized
email exists → Argon2id-hash the password → insert user → create a session →
sign a short-lived access token → write `auth.registration_succeeded` → return
`{ user, tokens }`. The normalized-email unique index is the authoritative guard
for the concurrent case; the repository maps a unique violation to the same
`EMAIL_ALREADY_REGISTERED` conflict.

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
- **Registration creates no workspace.** Register creates a user and a session —
  never an organization, workspace, membership, role, or permission.

### Error codes added

`INVALID_CREDENTIALS` (401) and `EMAIL_ALREADY_REGISTERED` (409) extend the
catalog in `@orgistry/contracts`. Missing/invalid access tokens map to the
existing `UNAUTHORIZED`; validation failures to `VALIDATION_ERROR`.

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

- Refresh token rotation is **not** implemented (schema scaffolding only).
- The refresh cookie lifecycle is **not** implemented.
- Logout is **not** implemented.
- Session listing / revocation is **not** implemented.
- Email verification behavior is **not** implemented (token table is scaffolding;
  `users.email_verified_at` is always null on registration).
- Organizations and memberships are **not** implemented; registration does **not**
  create a personal workspace.
- The web demo has **no** auth UI.
- **Rate limiting is deferred — an accepted Sprint 2 limitation.** Registration
  and login are not rate limited in this sprint. The Redis client and
  `RATE_LIMIT_*` config foundations from Sprint 1 exist, but enforcement is
  deliberately not wired in. The next auth/session-lifecycle sprint must add:
  - login per IP,
  - login per normalized email,
  - register per IP,
  - returning the standard `RATE_LIMITED` error envelope.

  Constraint for that work: **Redis must not become part of authentication
  correctness** — a Redis outage may disable rate limiting but must never cause
  a valid credential to be rejected or an invalid one to be accepted. Do not
  build a broad generic rate-limit bucket system beyond these needs.
- The system is **not** production-certified. The auth foundation is implemented
  and validated, but refresh lifecycle, logout, email verification, rate
  limiting, and organization-linked registration are not complete.

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
