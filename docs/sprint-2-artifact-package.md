# Sprint 2 Artifact Package

Official completion artifact for Orgistry Sprint 2 — **Auth Persistence and
Register/Login Foundation**. This is the authoritative record of what the sprint
delivered, how it was validated, the security properties and contracts it
establishes, what was deliberately left out, and what the next sprint builds on.
It summarizes and indexes; the full engineering reference lives in
[`auth-foundation.md`](auth-foundation.md).

Sprint 2 delivers the **authentication foundation**, not the full auth
lifecycle. Register, login, and current-user work end to end; refresh rotation,
logout, session management, email verification, and rate limiting are explicitly
out of scope and deferred to the secure session-lifecycle sprint.

---

## 1. Implementation Summary

Sprint 2 adds the first domain capability on top of the Sprint 1 foundation, with
no regression to existing behavior.

**Auth persistence (`packages/db/src/schema/auth.ts`, migration `0001_*.sql`).**
Five tables following the platform model (prefixed opaque IDs, `snake_case`
columns, `timestamptz` audit columns, hash-only secrets, explicit lifecycle):

- `users` — accounts; unique index on `normalized_email`; `password_hash` only;
  `status`, `email_verified_at`, soft-delete `deleted_at`.
- `sessions` — login sessions that anchor access tokens; indexed by `user_id`
  and `expires_at`; `revoked_at`/`revoked_reason` ready for later revocation.
- `refresh_tokens` — **persistence scaffolding only** (no behavior): unique
  `token_hash`, `family_id`/`parent_token_id`/`replacement_token_id`,
  `used_at`, `revoked_*` for future rotation + reuse detection.
- `email_verification_tokens` — **persistence scaffolding only** (no behavior):
  unique `token_hash`, `expires_at`, `used_at`.
- `security_events` — durable, sanitized auth/security records; nullable
  `user_id`/`session_id`/`organization_id` (the org column is future-compat with
  no FK); indexed by `event_type` and `created_at`.

**`packages/auth-core`** — reusable, dependency-light security primitives with no
HTTP/DB/config knowledge (secrets and TTLs are injected by callers):

- Argon2id `hashPassword` / `verifyPassword` (`@node-rs/argon2`).
- `normalizeEmail` (trim + lowercase; does not strip dots or `+tags`).
- JWT `signAccessToken` / `verifyAccessToken` (`jose`, HS256) with a stable
  claim shape `{ sub, sessionId, type: 'access', iat, exp }` and an
  `AccessTokenError` for all verification failures.
- `generateOpaqueToken` / `hashOpaqueToken` (SHA-256) for the future opaque
  tokens.
- `redactSecret` / `redactAuthorizationHeader`.

**API auth module (`apps/api/src/modules/auth/`).** Domain-first module behind an
`AuthRepository` interface (Drizzle impl + in-memory test fake):

- `POST /v1/auth/register` → `201 { user, tokens }`. Validates body (Zod),
  normalizes email, rejects duplicates, Argon2id-hashes, creates a user **and a
  session**, signs a short-lived access token, writes
  `auth.registration_succeeded`. Creates no organization/workspace/membership.
- `POST /v1/auth/login` → `200 { user, tokens }`, or a generic
  `401 INVALID_CREDENTIALS`. Creates a session on success; writes
  `auth.login_succeeded` / `auth.login_failed`.
- `GET /v1/auth/me` → `200 { user }`; requires `Authorization: Bearer <token>`;
  session-bound, session-owner-checked resolution; writes
  `auth.access_token_rejected` for present-but-invalid tokens.
- Security-event writer + recursive metadata sanitizer; auth error factories;
  central error handler extended to map `ZodError` → `VALIDATION_ERROR`.

**Contracts (`packages/contracts`).** Register/login request schemas (12-char
minimum password), the public `AuthUser` DTO, token + session-response +
current-user response schemas, and two new error codes (`INVALID_CREDENTIALS`,
`EMAIL_ALREADY_REGISTERED`).

**Config (`packages/config`).** `AUTH_ACCESS_TOKEN_TTL_SECONDS` (default 900) and
`AUTH_SESSION_TTL_SECONDS` (default 2,592,000), surfaced under `config.auth`.

**Tests & docs.** Auth-core unit tests, contract tests, offline route/service
tests via the in-memory repository, sanitizer tests, DB-backed integration tests,
and migration-from-scratch auth assertions; new `auth-foundation.md` plus updates
to `README.md`, `api-conventions.md`, `database-foundation.md`, `.env.example`.

---

## 2. Documentation Index

| Document | Covers |
| --- | --- |
| [`auth-foundation.md`](auth-foundation.md) | **Primary auth reference.** Developer docs, architecture & tradeoffs, contracts/invariants, integration notes, known limitations, full changelog incl. the hardening pass. |
| [`api-conventions.md`](api-conventions.md) | Envelopes, central error handling (incl. `ZodError` mapping), error codes (incl. auth codes), request IDs, and the `/v1/auth/*` endpoint summary. |
| [`database-foundation.md`](database-foundation.md) | Schema registry, the auth tables/invariants, migrations, guarded test reset, and the integration suites. |
| [`README.md`](../README.md) | Top-level overview, the Sprint 2 auth summary, scope boundary, command list, and docs index. |
| `.env.example` | Every environment variable incl. the auth TTLs; maps 1:1 to `packages/config`. |
| This document | Sprint 2 completion artifact: summary, validation evidence, security review, invariants, scope control, confidence, risks, handoff. |

Future engineers should go to:

- **Auth architecture / design** → `auth-foundation.md` §A–B.
- **Persistence model** → `database-foundation.md` + `packages/db/src/schema/auth.ts`.
- **API contracts** → `packages/contracts/src/auth.ts`, `auth-foundation.md` §C, `api-conventions.md`.
- **Validation commands** → `README.md` command table; `local-development.md`.
- **Known limitations** → `auth-foundation.md` §E and §6 below.
- **Next-sprint constraints** → `auth-foundation.md` §E and §9 below.

---

## 3. Validation Evidence

Offline gates were run in this session immediately before writing this artifact.
DB-backed gates were run during the hardening pass against **ephemeral Postgres
(Postgres.app) and Redis** started in the scratchpad; **no production code has
changed since**, so those results remain valid and are summarized here rather
than re-run.

| Validation | Command | Result | Notes |
| --- | --- | --- | --- |
| Root typecheck | `pnpm typecheck` | ✅ Pass | All 7 workspace projects, strict `tsc` |
| Unit tests (incl. auth-core + API/auth route tests) | `pnpm test` | ✅ Pass | 19 files, **91 tests** |
| Web demo build | `pnpm --filter @orgistry/web-demo run build` | ✅ Pass | `vite build` |
| Lint | `pnpm lint` | ✅ Pass | Sprint-1 placeholder (exits 0; `tsc` is the active gate) |
| Migration-from-scratch | `pnpm db:migrate` | ✅ Pass¹ | Applied cleanly to an empty database |
| Test DB reset | `pnpm db:reset:test` | ✅ Pass¹ | Drop + recreate + migrate test DB |
| DB integration (migration/tables/indexes/uniqueness) | `pnpm test:integration` | ✅ Pass¹ | 5 tests |
| API integration (auth + readiness regression) | `pnpm test:integration` | ✅ Pass¹ | 8 tests (6 auth, 2 readiness) |

¹ Run during the hardening pass against ephemeral Postgres + Redis; not re-run
here because no code changed. Integration/migration suites **skip with a printed
warning** (never a silent pass) when no database is configured.

**CI was NOT observed on a real GitHub Actions runner in this session.** The
workflow (`.github/workflows/ci.yml`) runs install → typecheck → lint → unit →
migrate → integration against Postgres/Redis service containers and required no
changes for Sprint 2, but its execution on GitHub has not been observed here.
This remains an open verification item (see §8).

---

## 4. Security Review

Established and tested in Sprint 2:

- **No raw password storage.** Passwords are Argon2id-hashed; only the encoded
  hash is persisted (asserted by integration test).
- **No raw token storage.** Refresh and email-verification tokens (scaffolding)
  are designed for SHA-256 hash-only persistence; access tokens are never
  persisted at all.
- **No password hash in responses.** Routes return only the `AuthUser` DTO;
  tests assert no `passwordHash`/`normalizedEmail`/persistence-only field leaks.
- **Generic login failure.** Unknown email and wrong password return the same
  HTTP status, error code, message, and shape, with no account-existence
  `details`. Unknown-email logins still run a dummy Argon2 verify to equalize
  timing. (Responses are not byte-identical — the envelope's `requestId` differs
  by design; tests compare the security-relevant fields.)
- **Normalized-email uniqueness.** Enforced by a unique index; the API pre-check
  plus the DB constraint cover the concurrent case.
- **Access-token verification.** Signature, expiry, and `type: 'access'`
  discriminator are all enforced; invalid/malformed/expired/wrong-type tokens are
  rejected.
- **Session-bound, session-owner-checked current user.** `/me` resolves a user
  only when the token is valid and unexpired, the user is active and not
  soft-deleted, and the bound session exists, **belongs to the same user**, and
  is neither revoked nor expired.
- **Rejected-token security events.** Present-but-invalid tokens write a durable
  `auth.access_token_rejected` event; a **missing** token is rejected before the
  service and writes no event (intentional). Events attribute a `userId`/
  `sessionId` only when that identifier is trusted (otherwise null).
- **Metadata sanitization.** Event metadata is recursively stripped of
  password/token/secret/authorization/cookie/hash/credential-like keys and
  oversized strings (tested at unit, route, and DB level).
- **Request-ID propagation.** The request id flows into every error envelope and
  every security event for end-to-end correlation.
- **Rate limiting intentionally deferred** (see §6, §8, §9).

This is the auth **foundation**. The system is **not production-certified**.

---

## 5. Contracts & Invariants

Stable as of Sprint 2; changing any requires a deliberate contract review.

- **`AuthUser` public DTO** — exactly `{ id, email, displayName, emailVerified,
  createdAt }`. Never exposes `passwordHash`, `normalizedEmail`, `status`, or
  soft-delete fields.
- **Register response** — `201 { user: AuthUser, tokens }`, where `tokens` is
  `{ accessToken, tokenType: 'Bearer', expiresIn }`. No refresh token is issued.
- **Login response** — `200 { user, tokens }` with the same shape; failures are
  generic `401 INVALID_CREDENTIALS`.
- **Current-user response** — `200 { user: AuthUser }`; requires a valid Bearer
  access token.
- **Access-token claim shape** — `{ sub: userId, sessionId, type: 'access',
  iat, exp }`, HS256, secret from config.
- **Normalized-email uniqueness** — one account per `normalized_email` (trim +
  lowercase; no dot/`+tag` stripping).
- **Password hash-only persistence** — raw passwords are never stored.
- **Token hash-only persistence** — raw refresh/email-verification tokens are
  never stored; access tokens are never persisted.
- **Session-bound access tokens** — each access token carries a `sessionId` and
  is honored only against that user's live session.
- **DB rows are never public DTOs** — persistence rows are mapped to contracts
  before crossing the API boundary.
- **Security-event metadata must remain sanitized** — no secrets, tokens,
  authorization headers, cookies, or raw request bodies.
- **Registration creates no org/membership** — only a user and a session.

---

## 6. Scope Control Confirmation

Explicitly **not** implemented in Sprint 2:

- No refresh endpoint, refresh token rotation, or refresh cookie lifecycle.
- No logout; no session listing or session revocation endpoints.
- No email verification request/completion behavior.
- No password reset; no OAuth, MFA, or passkeys.
- No organizations, personal workspace creation, or memberships.
- No roles, permissions, entitlements, or quotas.
- No invitations, projects, or API keys.
- No web demo auth UI.
- No worker/queue changes; no production deployment automation.
- No rate limiting (documented deferral; mandatory next sprint).

`refresh_tokens` and `email_verification_tokens` exist as **schema-only
scaffolding** — columns and indexes are present, but no code mints, reads, or
redeems them.

---

## 7. Confidence Assessment

| Area | Confidence | Justification |
| --- | --- | --- |
| Persistence model | **High** | Migration applies from scratch; tables/indexes/uniqueness verified by DB integration tests; hash-only and explicit-lifecycle conventions followed. |
| auth-core primitives | **High** | Small pure functions, dependency-injected secrets/TTLs, unit-tested incl. expiry, wrong secret, malformed, and wrong-`type`. |
| Register / login flows | **High** | End-to-end tested (offline + DB); generic login errors, hash-only persistence, and security events all asserted. |
| Current-user boundary | **High** | Full validation chain incl. the session-owner check; route-level tests for missing/revoked/expired/cross-user sessions and expired/malformed/missing tokens. |
| Security events | **High** | Durable, sanitized, trust-attributed; verified at unit, route, and DB level. |
| Contracts | **High** | Explicit Zod DTOs, no DB rows exposed, frozen `AuthUser`/claim shapes. |
| Tests | **Medium-High** | 91 unit + 13 integration, covering the security-relevant paths. Caveat: DB validation ran on ephemeral local services, not an observed CI runner. |
| Documentation | **High** | `auth-foundation.md` plus aligned README/api/db docs; wording corrected for byte-identical/requestId, rate-limit deferral, and production-readiness. |
| Readiness for next sprint | **High** | Stable user/session models and scaffolding let the session-lifecycle sprint build additively (see §9). |

Overall: **High**, with the single caveat that GitHub Actions CI has not been
observed in this session.

---

## 8. Remaining Risks

- **Rate limiting not implemented** — register/login and the present-but-invalid
  `/me` rejection path are abusable until the next sprint adds it.
- **Refresh / session lifecycle incomplete** — no refresh, rotation, reuse
  detection, logout, or session management yet.
- **Email verification incomplete** — token table is scaffolding;
  `email_verified_at` is always null at registration.
- **Organization-linked registration incomplete** — registration creates no
  organization/workspace/membership (by design for this sprint).
- **Security-event retention/pruning not implemented** — event volume is
  unbounded; the `created_at` index supports future pruning.
- **System not production-certified.**
- **CI not yet observed on a real GitHub runner** — the workflow exists and
  passes locally via the same commands, but its GitHub Actions execution should
  be confirmed.

---

## 9. Readiness for Next Sprint

**Sprint 2 is ready to hand off to the secure session-lifecycle sprint.** The
foundation is stable enough to build on additively, without redesign.

The next sprint can build on:

- a **stable user model** (active/soft-delete lifecycle, normalized-email
  uniqueness, hash-only password);
- a **stable session model** (`sessions` with `expires_at`,
  `revoked_at`/`revoked_reason`, user-scoped indexes);
- **refresh token schema scaffolding** (`family_id`, `parent_token_id`,
  `replacement_token_id`, `used_at`, `revoked_*`, unique `token_hash`);
- **email verification token schema scaffolding** (`token_hash`, `expires_at`,
  `used_at`);
- **auth-core primitives** (hashing, JWT sign/verify, opaque-token
  generate/hash, redaction);
- the **stable access-token claim shape** (`{ sub, sessionId, type, iat, exp }`);
- **register/login/current-user contracts** and the `AuthUser` DTO;
- the **security-event model** (durable, sanitized, trust-attributed);
- the **auth test pattern** (repository interface + in-memory fake for offline
  HTTP tests; DB-backed integration for persistence invariants).

Mandatory next-sprint priorities:

- refresh endpoint;
- HttpOnly refresh cookie;
- refresh token rotation;
- refresh token reuse detection;
- session family revocation;
- logout;
- session listing;
- session revocation;
- CSRF protection where the refresh cookie makes it relevant;
- **auth rate limiting** — login per IP, login per normalized email, register per
  IP, returning the standard `RATE_LIMITED` envelope, with the hard constraint
  that **Redis must not be part of authentication correctness** (a Redis outage
  may disable rate limiting but must never accept an invalid credential or reject
  a valid one).
