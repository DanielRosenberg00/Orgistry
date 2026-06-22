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
