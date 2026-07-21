# API Conventions

Baseline HTTP conventions frozen in Sprint 1. They live in `@orgistry/contracts`
so both the API and (later) the web demo share one definition. Treat these as
stable contracts — see "Contracts & Invariants" in `sprint-1-foundation.md`.

## Response envelopes

Every response is one of two shapes, discriminated by `ok`.

**Success**

```json
{ "ok": true, "data": { "...": "..." } }
```

**Error**

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /x not found.",
    "requestId": "req_...",
    "details": { "...": "optional" }
  }
}
```

- Build success responses with `sendSuccess(reply, data, status?)`
  (`apps/api/src/lib/envelope.ts`).
- Never send raw, unwrapped bodies from a handler.

## Error handling

There is exactly one error path — the central handler in
`apps/api/src/plugins/error-handler.ts`:

| Thrown value | Result |
| --- | --- |
| `AppError(code, status, message, details?)` | That code/status/message |
| `ZodError` (domain route body validation) | `400 VALIDATION_ERROR` + issue details |
| Fastify validation error | `400 VALIDATION_ERROR` + field details |
| Anything else | `500 INTERNAL_ERROR`, generic message, real error logged only |
| Unknown route | `404 NOT_FOUND` |

Unexpected errors never leak stack traces or internal messages to the client.
Throw `AppError` from handlers/modules to produce a controlled response.

## Error codes

Baseline catalog (`ERROR_CODES`): `VALIDATION_ERROR`, `BAD_REQUEST`,
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`,
`SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. These are generic; domain codes are
added deliberately in later sprints.

Auth codes (Sprint 2): `INVALID_CREDENTIALS` (generic failed login — same for
unknown email and wrong password) and `EMAIL_ALREADY_REGISTERED` (originally a
duplicate normalized email on register; since Sprint 18 it exists ONLY on the
authenticated change-email flow — public registration never returns it).

Session-lifecycle codes (Sprint 3): `INVALID_REFRESH_TOKEN` (401, generic —
missing/unknown/expired refresh), `TOKEN_REUSE_DETECTED` (401, a used/revoked
refresh token was presented; the family + session are revoked), and
`CSRF_REQUIRED` (403, a cookie-backed mutation lacked the custom CSRF header).
`RATE_LIMITED` (429) is now exercised by the auth rate-limit buckets.

Organization codes (Sprint 4): `ORGANIZATION_NOT_FOUND` (404 — does not exist
**or** the caller has no active membership; the two are indistinguishable so
non-members cannot probe existence) and `ORGANIZATION_SLUG_TAKEN` (409 — a
requested explicit slug is already in use).

Email-verification codes (Sprint 16): `EMAIL_VERIFICATION_TOKEN_INVALID`
(404 — unknown token, or a token whose account cannot complete verification;
indistinguishable so account state never leaks),
`EMAIL_VERIFICATION_TOKEN_EXPIRED` (410), and
`EMAIL_VERIFICATION_TOKEN_USED` (409 — consumed earlier or invalidated by a
resend/sibling completion; reuse never verifies twice). All three describe
token validity only. See
[`email-and-verification.md`](email-and-verification.md).

Password-recovery codes (Sprint 17): `PASSWORD_RESET_TOKEN_INVALID` (404 —
unknown token, or a token whose account cannot complete a reset;
indistinguishable so account state never leaks),
`PASSWORD_RESET_TOKEN_EXPIRED` (410), and `PASSWORD_RESET_TOKEN_USED` (409 —
consumed earlier or invalidated by a newer request/sibling completion; a token
never resets twice). The recovery **request** endpoint returns none of these —
it succeeds identically for every email. Two existing codes gained new
Sprint 17 uses: `INVALID_CREDENTIALS` at status **400** (not 401) rejects a
wrong current password on `change-password` / `change-email` (the caller's
session is valid, so 401 would falsely signal an expired session), and
`EMAIL_ALREADY_REGISTERED` (409) rejects a duplicate email on `change-email`.
See [`credential-management.md`](credential-management.md).

Registration codes (Sprint 18): `REGISTRATION_TOKEN_INVALID` (404 — unknown
token, or the email was taken while the pending registration was outstanding;
indistinguishable so account state never leaks),
`REGISTRATION_TOKEN_EXPIRED` (410), and `REGISTRATION_TOKEN_USED` (409 —
consumed earlier or superseded by a newer generation; a token never completes
twice). All three describe token validity only and belong to
`POST /v1/auth/registration/complete`. The registration **request** endpoint
returns none of these — like the password-recovery request, it succeeds
identically (`200 { accepted: true }`) for every account state, and it never
returns `EMAIL_ALREADY_REGISTERED`. See
[`auth-foundation.md`](auth-foundation.md).

Edge-hardening code uses (Sprint 19): no new codes, but two existing ones
gained producers. `RATE_LIMITED` (429) is now also returned by the **global**
per-IP limiter (every route except `/health`, `/ready`, and `OPTIONS`
preflight) and by the per-actor **mutation buckets** (org create, project
create, API-key create, demo plan change, invitation create) and the
invitation inspect/accept throttles — always in the standard envelope with a
request id. `SERVICE_UNAVAILABLE` (503) is now also returned by **sensitive**
rate-limited endpoints when Redis is unreachable and the limiter fails closed
(the production default) — generic message, request id included, no Redis
details. See [`security-model.md`](security-model.md).

## Auth endpoints

See [`auth-foundation.md`](auth-foundation.md) (registration/login/me) and
[`session-lifecycle.md`](session-lifecycle.md) (refresh/logout/sessions) for the
full design.

- `POST /v1/auth/register` — `200 { accepted: true }`, always
  (enumeration-safe, verification-first; Sprint 18). Validates the body
  (shared 12-char-minimum password policy), rate-limits per IP and per email
  digest before any account lookup, and validates an optional
  `invitationToken` INTERNALLY: every private invitation failure (unknown,
  expired, revoked, accepted, email mismatch, quota) returns this same
  generic acceptance and stages/sends nothing — no `INVITATION_*` error ever
  escapes this endpoint (use `/v1/invitations/inspect` for invitation
  feedback). For an eligible new email it stages a hash-only pending
  registration and emails a completion link. Creates no user, session, or
  cookie. Only `VALIDATION_ERROR` and `RATE_LIMITED` are explicit.
- `POST /v1/auth/registration/complete` — `201 { user, tokens, invitation }`
  (+ refresh cookie, set after commit). Body `{ token }`. In one transaction
  creates the email-verified user + personal workspace (organization + active
  Owner membership) + session + refresh token, and accepts a stored invitation
  where applicable. Token errors: `REGISTRATION_TOKEN_INVALID` 404,
  `…_EXPIRED` 410, `…_USED` 409.
- `POST /v1/auth/login` — `200 { user, tokens }` (+ refresh cookie), or a generic
  `401 INVALID_CREDENTIALS` that never reveals whether the email exists.
- `GET /v1/auth/me` — `200 { user }`; requires `Authorization: Bearer <token>`.
- `POST /v1/auth/refresh` — `200 { tokens }`. Requires the refresh cookie **and**
  the custom CSRF header. Rotates the refresh token (one successor per token,
  transactionally) and returns a fresh access token. Reuse → `TOKEN_REUSE_DETECTED`.
- `POST /v1/auth/logout` — `200 { success: true }`. Requires the CSRF header;
  revokes the cookie's session + refresh tokens server-side and clears the cookie.
  Idempotent.
- `GET /v1/auth/sessions` — `200 { items, nextCursor, hasMore }`; requires Bearer.
  The caller's active sessions only; each item is a `SessionSummary`.
- `DELETE /v1/auth/sessions/:sessionId` — `200 { success: true }`; requires Bearer.
  Owner-scoped (cross-user → `404`); idempotent.
- `POST /v1/auth/password-recovery/request` — `200 { accepted: true }`, always
  (enumeration-safe). `POST /v1/auth/password-recovery/complete` —
  `200 { reset: true }`; no session issued. `POST /v1/auth/change-password` —
  `200 { success: true }`. `POST /v1/auth/change-email` — `200 { user }`. See
  [`credential-management.md`](credential-management.md) for the full design.

`tokens` is `{ accessToken, tokenType: 'Bearer', expiresIn }`. `user` is the
public `AuthUser` (`id`, `email`, `displayName`, `emailVerified`, `createdAt`) —
never a database row, password hash, or persistence-only field. The refresh
token is **never** in any JSON body — only in the HttpOnly cookie.

## Organization endpoints (Sprint 4)

See [`organization-foundation.md`](organization-foundation.md) for the full
design. All three require `Authorization: Bearer <token>`.

- `POST /v1/organizations` — `201 { organization, membership }`. Creates a team
  organization and the creator's active Owner membership. Body:
  `{ name, slug? }`; an explicit slug already in use → `409
  ORGANIZATION_SLUG_TAKEN`; an omitted slug is derived from the name and
  collision-resolved.
- `GET /v1/organizations` — `200 { items, nextCursor, hasMore }`. Cursor-paginated
  list of the **active** organizations where the caller has an **active**
  membership; each item is `{ organization, membership }`. Never leaks other
  users' organizations.
- `GET /v1/organizations/:organizationId` — `200 { organization, membership }`.
  Requires an active membership; the **organization ID is the authority
  boundary** (never the slug). Non-member or non-existent → identical `404
  ORGANIZATION_NOT_FOUND`.

`organization` is the public `Organization` DTO (`id`, `name`, `slug`, `type`,
`status`, `createdAt`, `updatedAt`) — never a raw row or `createdByUserId`.
`membership` is a `MembershipSummary` carrying an identity-only `role` (never
permissions).

## Cookies, CSRF, and rate limits (Sprint 3)

- **Refresh cookie.** `HttpOnly`, `SameSite=Lax`, `Path=/v1/auth`, `Secure` in
  production-like mode, `Max-Age` = refresh TTL. Set/cleared only through the
  centralized helper (`apps/api/src/lib/cookies.ts`).
- **CSRF.** Cookie-backed mutations (`refresh`, `logout`) require a custom header
  (`x-orgistry-csrf` by default). Presence is sufficient; the protection is
  `SameSite=Lax` + the strict CORS allow-list + the required header. Missing →
  `403 CSRF_REQUIRED` with a request id.
- **Rate limits.** Redis-backed fixed-window buckets (login-per-IP/email,
  registration request per IP/email-digest, registration completion per
  IP/token-digest, refresh-per-session/IP, change-password/change-email
  per user, password-recovery request per IP/email-digest, password-recovery
  completion per IP/token-digest, email-verification request/complete) from
  typed config; exceeding → `429 RATE_LIMITED` with a request id. No raw email
  or token material ever enters a limiter key (emails and tokens are digested
  first).
- **Global + mutation limits (Sprint 19).** One additional fixed-window bucket
  per trusted client IP covers every route except `/health`, `/ready`, and
  `OPTIONS` preflight (`RATE_LIMIT_MAX`, default 300 per
  `RATE_LIMIT_WINDOW_SECONDS`, default 60), evaluated before route-specific
  work; and per-actor mutation buckets (org/project/API-key create, demo plan
  change, invitation create — run **after** permission checks) plus invitation
  inspect/accept throttles. All produce the same standard
  `429 RATE_LIMITED` envelope.
- **Limiter failure mode (Sprint 19).** `RATE_LIMIT_FAILURE_MODE`
  (`open`|`closed`; unset derives production→`closed`,
  development/test→`open`; production refuses an explicit `open` at boot). In
  `closed` mode a Redis outage makes **sensitive** rate-limited endpoints
  (login, refresh, registration, password recovery, email verification,
  invitation inspect/accept/create, the external API buckets, the mutation
  buckets) reject with `503 SERVICE_UNAVAILABLE` — generic message, request id
  included, no Redis details. In `open` mode requests proceed. The **global**
  limiter always fails open by design (readiness takes the instance out of
  rotation).

## Request IDs

- An inbound `x-request-id` header is accepted **only** if it matches
  `[A-Za-z0-9._-]{1,128}` (max 128 chars). Anything else — missing, empty,
  overlong, whitespace, CR/LF/NUL, control characters, or any other character
  — is replaced by a server-generated `req_<uuid>`. The policy lives in
  `packages/shared/src/request-id.ts` (`resolveRequestId`) and is applied in
  `genReqId` before any logging (Sprint 19).
- The one resolved id is echoed on every response via the `x-request-id`
  header.
- It appears in every error envelope (`error.requestId`), in logs as
  `requestId`, and flows into audit/security events. This is the single value
  to correlate a request end to end.

## Security headers (Sprint 19)

Every API response — success, error envelope, `404`, and CORS preflight —
carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, and
`Permissions-Policy: camera=(), microphone=(), geolocation=()`.
`Strict-Transport-Security` (`max-age=<HSTS_MAX_AGE_SECONDS>`, default
15552000; `includeSubDomains`) is sent only when BOTH `NODE_ENV=production`
AND the request's proxy-aware protocol resolves to `https` (a real TLS
socket, or `X-Forwarded-Proto: https` through a TRUSTED hop under
`TRUST_PROXY`) — never on local HTTP, and never from a forged header on an
untrusted connection. `/v1/auth/*` and `/v1/invitations/*` responses
additionally carry `Cache-Control: no-store`. This is an **API response
policy**, not a frontend CSP (SPA CSP hardening remains a known limitation).
Implemented in `apps/api/src/plugins/security-headers.ts`; CORS and CSRF
behavior are unchanged.

## Health vs. readiness

- `GET /health` — liveness; never touches dependencies; `200` when up.
- `GET /ready` — readiness over PostgreSQL and Redis (both required; Redis is
  a readiness dependency consistent with the fail-closed limiters). In
  development/test: `200` with per-dependency `checks` (name/ok/latencyMs —
  never error text, hosts, or ports) when both are reachable; `503` with a
  `SERVICE_UNAVAILABLE` error envelope (whose `details.checks` flag the
  failing dependency) otherwise. In production (Sprint 19): **coarse output
  only** — `200 {status:'ready'}` or a generic `503 SERVICE_UNAVAILABLE` with
  no dependency names or details; per-check outcomes are logged server-side on
  failure.

## Pagination

Cursor-based. Request `{ cursor?, limit }` (`limit` default 20, max 100).
Response page: `{ items, nextCursor, hasMore }`. The cursor is opaque — clients
pass `nextCursor` back verbatim and must not parse it.
