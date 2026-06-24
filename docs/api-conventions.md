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
unknown email and wrong password) and `EMAIL_ALREADY_REGISTERED` (duplicate
normalized email on register).

Session-lifecycle codes (Sprint 3): `INVALID_REFRESH_TOKEN` (401, generic —
missing/unknown/expired refresh), `TOKEN_REUSE_DETECTED` (401, a used/revoked
refresh token was presented; the family + session are revoked), and
`CSRF_REQUIRED` (403, a cookie-backed mutation lacked the custom CSRF header).
`RATE_LIMITED` (429) is now exercised by the auth rate-limit buckets.

Organization codes (Sprint 4): `ORGANIZATION_NOT_FOUND` (404 — does not exist
**or** the caller has no active membership; the two are indistinguishable so
non-members cannot probe existence) and `ORGANIZATION_SLUG_TAKEN` (409 — a
requested explicit slug is already in use).

## Auth endpoints

See [`auth-foundation.md`](auth-foundation.md) (register/login/me) and
[`session-lifecycle.md`](session-lifecycle.md) (refresh/logout/sessions) for the
full design.

- `POST /v1/auth/register` — `201 { user, tokens }`. Validates body, enforces a
  12-char minimum password, hashes with Argon2id, and atomically provisions a
  user + personal workspace (organization + active Owner membership) + session +
  refresh token (Sprint 4), then sets the HttpOnly refresh cookie.
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
  register-per-IP, refresh-per-session/IP) from typed config; exceeding →
  `429 RATE_LIMITED` with a request id. The limiter fails open — a Redis outage
  never affects auth correctness.

## Request IDs

- Fastify reuses an inbound `x-request-id` header if present, otherwise
  generates `req_<uuid>` (`@orgistry/shared`).
- The id is echoed on every response via the `x-request-id` header.
- It appears in every error envelope (`error.requestId`) and in logs as
  `requestId`. This is the single value to correlate a request end to end.

## Health vs. readiness

- `GET /health` — liveness; never touches dependencies; `200` when up.
- `GET /ready` — `200` with per-dependency `checks` when PostgreSQL and Redis
  are reachable; `503` with a `SERVICE_UNAVAILABLE` error envelope (whose
  `details.checks` flag the failing dependency) otherwise.

## Pagination

Cursor-based. Request `{ cursor?, limit }` (`limit` default 20, max 100).
Response page: `{ items, nextCursor, hasMore }`. The cursor is opaque — clients
pass `nextCursor` back verbatim and must not parse it.
