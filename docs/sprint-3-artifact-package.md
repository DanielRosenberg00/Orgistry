# Sprint 3 Artifact Package

Official completion artifact for Orgistry Sprint 3 — **Secure Session
Lifecycle**. This is the authoritative record of what the sprint delivered, how
it was validated, the security properties and contracts it establishes, what was
deliberately left out, and what the next sprint may rely on. It summarizes and
indexes; the full engineering reference lives in
[`session-lifecycle.md`](session-lifecycle.md).

Sprint 3 completes the **secure browser authentication lifecycle** on top of the
Sprint 2 register/login/current-user foundation. Organizations, memberships,
permissions, entitlements, projects, API keys, email verification, and any web
demo auth UI remain explicitly out of scope.

**Status: ready for closure.** Every validation command in §5 was run
independently and completed successfully in the refinement pass; the only
non-passing entry is `pnpm lint`, which is a no-op placeholder (not a real lint
gate) and is reported as such. No blocking issues remain.

---

## 1. Implementation Summary

**Refresh issuance & cookie lifecycle.** Register and login mint the first
refresh token of a new family alongside the existing user/session/access token,
and deliver it through a centralized HttpOnly, `SameSite=Lax`, path-scoped
cookie (`apps/api/src/lib/cookies.ts`). The refresh token is an opaque,
high-entropy random string; it is stored hash-only (SHA-256) and never appears
in any JSON body, log, or security event — the cookie is its only channel.

**Refresh rotation (transactional).** `POST /v1/auth/refresh` rotates the
presented token inside a single PostgreSQL transaction that locks the token row
`FOR UPDATE`, marks it used, and inserts exactly one successor in the same
family. Concurrent refreshes of one token serialize — only one successor can
ever be minted (`auth.repo.ts → rotateRefreshToken`).

**Reuse detection.** A used/replaced/revoked token, or one whose session is
revoked/expired, is treated as compromised: the **entire token family and its
session are revoked**, the cookie is cleared, no access token is issued, and
`TOKEN_REUSE_DETECTED` is returned.

**Session management.** Logout revokes the session + its refresh tokens
server-side and is idempotent. `GET /v1/auth/sessions` returns the caller's
active sessions, cursor-paginated, marking the current one; `DELETE
/v1/auth/sessions/:sessionId` revokes one owner-scoped session (cross-user →
indistinguishable `404`). Both session endpoints are Bearer-authenticated and
user-scoped.

**CSRF & rate limiting.** Cookie-backed mutations (refresh, logout) require a
custom CSRF header; the protection is `SameSite=Lax` + the strict CORS
allow-list + the required header. Redis-backed fixed-window rate limits cover
login-per-IP, login-per-email, register-per-IP, refresh-per-session, and
refresh-per-IP, returning `RATE_LIMITED`. The limiter **fails open inside auth
handlers** — a Redis outage disables limiting but never affects auth
correctness. Redis remains a required dependency of runtime readiness (`/ready`).

**Security events.** Six new durable, sanitized event types:
`auth.refresh_token_rotated`, `auth.refresh_token_reuse_detected`,
`auth.refresh_failed`, `auth.logout_succeeded`, `auth.session_revoked`,
`auth.rate_limit_exceeded`.

**No migration required.** The `refresh_tokens` family columns (`family_id`,
`parent_token_id`, `replacement_token_id`, `used_at`, `revoked_*`) and
`sessions.revoked_*` shipped as Sprint 2 scaffolding, so Sprint 3 added behavior
only — `drizzle-kit generate` reports no schema changes.

## 2. API Surface

| Endpoint | Auth | CSRF | Result |
| --- | --- | --- | --- |
| `POST /v1/auth/register` | none | n/a | `201 { user, tokens }` + refresh cookie |
| `POST /v1/auth/login` | none | n/a | `200 { user, tokens }` + refresh cookie |
| `GET /v1/auth/me` | Bearer | n/a | `200 { user }` |
| `POST /v1/auth/refresh` | refresh cookie | **required** | `200 { tokens }` + rotated cookie |
| `POST /v1/auth/logout` | refresh cookie | **required** | `200 { success }` + cleared cookie |
| `GET /v1/auth/sessions` | Bearer | n/a | `200 { items, nextCursor, hasMore }` |
| `DELETE /v1/auth/sessions/:sessionId` | Bearer | n/a | `200 { success }` |

## 3. Security Invariants

- Refresh token is opaque, **cookie-only**, and persisted **hash-only**; never in
  any JSON body, log, or security event.
- Cookie attributes are centralized (`HttpOnly`, `SameSite=Lax`, path-scoped,
  config-driven `Secure`, `Max-Age` = refresh TTL); set and clear share them, so
  they cannot drift.
- Rotation is transactional and **single-successor**; concurrency cannot fork a
  family.
- Reuse detection revokes the affected **token family and its session**; no
  access token is issued; the cookie is cleared.
- Logout is server-side and idempotent.
- Session listing/revocation are **Bearer-authenticated and owner-scoped**;
  cross-user access is an indistinguishable `404`.
- The session DTO exposes no token hashes, token family ids, user ids, cookies,
  or authorization headers. `ipAddress`/`userAgent` are deliberately exposed as
  **owner-only** session metadata (returned only to the session's authenticated
  owner) for the standard "recognize and revoke your devices" UX.
- CSRF is required on cookie-backed mutations; missing → `403 CSRF_REQUIRED`
  with a request id.
- Rate limits are Redis-backed, config-driven, and **fail open in auth
  handlers**; Redis is never on the auth-correctness path, yet remains required
  for runtime readiness.
- Access-token claim shape unchanged: `{ sub, sessionId, type: 'access', iat, exp }`.

## 4. Contracts

Added to `@orgistry/contracts`: `refreshResponseSchema`, `logoutResponseSchema`,
`sessionSummarySchema`, `sessionListResponseSchema`,
`sessionRevocationResponseSchema`; error codes `INVALID_REFRESH_TOKEN`,
`TOKEN_REUSE_DETECTED`, `CSRF_REQUIRED` (`RATE_LIMITED` already existed). All
preserve the standard success/error envelopes and request id; no DB rows or
token material cross the boundary; built to be consumed by a future web demo
auth client.

## 5. Validation

Each command was run **independently** in the refinement pass (not chained),
against a disposable local PostgreSQL + Redis. Results reflect actual
completion. This artifact pass is documentation-only and did not rerun them.

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | ✅ pass | All 7 workspace projects. |
| `pnpm test` | ✅ pass | 138 unit tests (cookies, rate limiter incl. fail-open, full session lifecycle via `app.inject`, rate-limit behavior, config, contracts, security-event sanitization; all Sprint 1/2 tests preserved). |
| `pnpm --filter @orgistry/api test:integration` | ✅ pass | 12 tests vs live PostgreSQL + Redis: hash-only persistence, transactional rotation, reuse + family/session revocation, concurrency, register/login/me, readiness. |
| `pnpm --filter @orgistry/db test:integration` | ✅ pass | 5 migration-from-scratch tests. |
| `pnpm --filter @orgistry/web-demo build` | ✅ pass | Vite production build. |
| `pnpm db:generate` | ✅ pass | "No schema changes" — confirms no migration was required. |
| `pnpm lint` | ⚠️ placeholder | The repo's `lint` script is a Sprint-1 placeholder that performs **no** linting and exits 0; `pnpm typecheck` is the active gate. **Not a real lint pass.** |

Environment note: the local host's port 5432 is held by an unrelated project, so
the integration runs used a disposable PostgreSQL on host port 5440 plus a
disposable Redis on 6379 (`TEST_DATABASE_URL`/`DATABASE_URL`/`REDIS_URL`
overridden for the run). The integration suites otherwise skip cleanly when no
database/Redis is reachable.

## 6. Out of Scope (as of Sprint 3)

> **Historical note.** This is the Sprint 3 completion record. **Sprint 4 has
> since delivered the organization foundation** (organizations, personal
> workspaces, memberships, the role baseline, and registration-time workspace
> provisioning) — see
> [`sprint-4-artifact-package.md`](sprint-4-artifact-package.md) and
> [`organization-foundation.md`](organization-foundation.md). The list below is
> the scope boundary at Sprint 3 close and is preserved as-is for the record.

Organizations, personal workspaces, memberships, roles, permissions,
entitlements, quotas, invitations, projects, API keys, external API,
organization audit logs, email verification, password reset, MFA, OAuth,
passkeys, Stripe/billing, PostgreSQL RLS, workers/queues, production deployment
automation, web demo auth UI, and the authenticated web shell. As of Sprint 3,
registration created only a user + session.

## 7. Documentation Index

| Document | Purpose |
| --- | --- |
| [`README.md`](../README.md) | Project overview, what is implemented through Sprint 3, the explicit scope boundary, and local setup. |
| [`docs/auth-foundation.md`](auth-foundation.md) | Sprint 2 reference: register/login/current-user, Argon2id, JWT access tokens, security-event persistence. Annotated where Sprint 3 superseded its "deferred" notes. |
| [`docs/session-lifecycle.md`](session-lifecycle.md) | **Authoritative Sprint 3 engineering reference** (A–F): refresh/cookie/rotation/reuse/logout/session-management/CSRF/rate-limit design, tradeoffs, invariants, integration notes, limitations. |
| [`docs/api-conventions.md`](api-conventions.md) | Shared HTTP conventions: success/error envelopes, the error-code catalog, the auth endpoint table, and the cookie/CSRF/rate-limit conventions. |
| [`docs/database-foundation.md`](database-foundation.md) | Schema and migration reference; records that `refresh_tokens` is now exercised by Sprint 3 with no migration needed. |
| [`docs/sprint-3-artifact-package.md`](sprint-3-artifact-package.md) | This file — the Sprint 3 completion record and index. |
| [`.env.example`](../.env.example) | Canonical environment variables, including refresh TTL, refresh-cookie name/path, the CSRF header name, and the auth rate-limit buckets. |

(No repo-wide docs-index file exists; per Sprint convention this artifact's own
index is the entry point and no broader docs system was introduced.)

## 8. Confidence Assessment

Confidence is **high for the implemented scope**, grounded in commands that
actually completed in the refinement pass (§5):

- `pnpm typecheck` passed across all 7 projects.
- `pnpm test` passed (138 unit tests), covering the full session lifecycle
  through `app.inject` plus the limiter (including fail-open) and event
  sanitization.
- `pnpm --filter @orgistry/api test:integration` passed against **live
  PostgreSQL + Redis** — the highest-risk paths (transactional `FOR UPDATE`
  rotation, reuse with family + session revocation, and the concurrency test
  proving a single successor) were exercised on a real database, not only in
  memory.
- `pnpm --filter @orgistry/db test:integration` passed (migration-from-scratch).
- `pnpm --filter @orgistry/web-demo build` passed.
- `pnpm db:generate` reported no schema drift, confirming the no-migration claim.
- Known limitations are documented and specific (§9), not glossed.

Confidence **boundaries** — areas deliberately accepted, not yet hardened:

- **Fixed-window rate limiting** can permit a boundary burst (≈2× a bucket's
  limit across a window edge); adequate for v1 abuse control, not a smooth rate.
- **CSRF is header-presence only** — no signed double-submit token. It relies on
  `SameSite=Lax` + a strict CORS allow-list holding at the deployment edge.
- **No background pruning** of expired/revoked sessions or refresh tokens yet;
  rows accumulate (indexes support a future sweep).
- **No real lint gate** — `pnpm lint` is a placeholder; only `tsc` enforces
  static analysis.
- The in-memory rate limiter is per-process (tests/fallback only); Redis is the
  production store.

This is **not** a production-readiness certification; it is a statement that the
Sprint 3 scope is implemented, internally consistent, and validated by the
commands listed.

## 9. Remaining Risks

- Concurrent double-submit of one refresh token signs the user out — a
  secure-by-default consequence of reuse detection, documented and accepted.
- Fixed-window boundary bursts (see §8).
- CSRF depends on `SameSite=Lax` + strict CORS staying correct in production
  config (header-presence model only).
- Unbounded growth of `sessions` / `refresh_tokens` / `security_events` without
  pruning.
- No automated lint beyond typecheck.
- Email verification remains schema scaffolding with no behavior. The system is
  **not** production-certified.

## 10. Readiness for Next Sprint

**The next sprint may begin organization / workspace modeling.** The auth and
session lifecycle below is stable and may be relied on without revisiting token
primitives, the claim shape, or the rotation/reuse model. The
`security_events.organization_id` column is already reserved (no FK) for the
organization domain, and sessions + security events are the intended join points
for future organization, membership, and audit work.

| Assumption the next sprint may rely on | Status |
| --- | --- |
| Access-token claim shape `{ sub, sessionId, type: 'access', iat, exp }` | Stable |
| Session-bound authentication (`/me` boundary, shared by session endpoints) | Stable |
| Refresh cookie behavior (HttpOnly, SameSite=Lax, centralized set/clear) | Stable |
| Refresh-token schema (`refresh_tokens` family lineage, hash-only) | Stable |
| Refresh rotation behavior (transactional, single-successor) | Stable |
| Reuse detection behavior (family + session revocation) | Stable |
| Logout behavior (server-side, idempotent) | Stable |
| Session revocation behavior (owner-scoped, idempotent) | Stable |
| Auth rate-limit model (Redis-backed, fail-open, config-driven buckets) | Stable |
| CSRF header model (required on cookie-backed mutations) | Stable |
| Security-event sanitization (denylist keys, request-id carried) | Stable |
| Auth contracts (`@orgistry/contracts` auth/session DTOs + error codes) | Stable |

No item above is unstable. The only caveats are the documented confidence
boundaries in §8 (rate-limit algorithm, CSRF model, pruning, lint), none of
which block organization/workspace modeling.
