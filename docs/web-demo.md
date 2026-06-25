# Web Demo — Admin Surfaces

**Sprint 11 reference (A–F).** This document is the authoritative developer,
architecture, contract, and integration reference for the Orgistry web demo. The
sprint changelog and handoff record live in
[`docs/sprint-11-artifact-package.md`](./sprint-11-artifact-package.md).

> The web demo is a thin official consumer of Orgistry APIs.
>
> The backend remains authoritative for all authorization, entitlement, quota,
> and tenant-isolation decisions.

Everything below follows from those two sentences. The frontend renders state the
backend owns, hides or disables actions as a convenience, and never makes an
authorization, entitlement, quota, tenant-isolation, Last-Owner, invitation, API
key, or audit-visibility decision itself.

---

## A. Developer documentation

### What was implemented

Sprint 11 turns `apps/web-demo` from a static foundation status page into a
coherent authenticated admin interface that demonstrates the full operator
journey:

```
login → select organization → overview → members → invitations
      → projects → plan & entitlements → API keys → audit log
```

Concretely, the sprint added:

- app bootstrap with routing, a TanStack Query provider, an auth provider, and an
  organization provider (`src/main.tsx`);
- one central, typed API client with envelope + error handling, in-memory bearer
  injection, cookie/CSRF support, and silent refresh-on-401 (`src/api/`);
- in-memory auth state with refresh-cookie session restore (`src/auth/`);
- organization-selection state with graceful recovery and team creation
  (`src/organization/`);
- per-domain API hooks built on shared cursor pagination (`src/hooks/`);
- shared loading / empty / error / permission UI components (`src/components/`);
- seven admin pages plus login/register (`src/pages/`);
- jsdom component/route smoke tests (`src/**/*.test.tsx`, `src/test/`).

### Where the frontend pieces live

```
apps/web-demo/src
├── main.tsx                  app bootstrap + provider tree
├── App.tsx                   route table
├── config.ts                 API base URL, CSRF header name, Mailpit URL
├── queryClient.ts            TanStack Query client + retry policy
├── api/
│   ├── client.ts             central API client (the only place fetch is called)
│   └── errors.ts             ApiError + coercion helpers
├── auth/
│   ├── auth-context.ts       AuthContext + status type
│   ├── AuthProvider.tsx      session restore, login/register/logout
│   └── useAuth.ts            consumer hook
├── organization/
│   ├── org-context.ts        OrganizationContext + storage key
│   ├── OrganizationProvider.tsx   org list, selection, recovery, team create
│   └── useOrganization.ts    consumer hooks (incl. useSelectedOrganizationId)
├── hooks/
│   ├── useCursorQuery.ts     shared load-more wrapper over cursor lists
│   ├── useEffectivePermissions.ts
│   ├── useMembers.ts  useInvitations.ts  useProjects.ts
│   ├── usePlan.ts (plan + entitlements)  useApiKeys.ts  useAudit.ts
├── components/
│   ├── AppShell.tsx          authenticated layout (nav, top bar, switcher)
│   ├── ProtectedRoute.tsx    route guard
│   ├── OrganizationSwitcher.tsx
│   ├── ErrorBanner.tsx       consistent backend-error rendering
│   ├── QueryStates.tsx       LoadingState / EmptyState / QueryBoundary / LoadMore
│   └── PermissionNote.tsx    UX-only "you can't do this" hint
├── pages/                    Login, Register, Overview, Members, Invitations,
│                             Projects, Plan, ApiKeys, Audit, NotFound
├── lib/format.ts             date formatting
└── test/                     fixtures + mock-API harness + setup
```

Module boundaries are deliberate: pages call hooks, hooks call the API client,
the API client calls `fetch`. No page issues a raw request, and no request logic
is duplicated.

### How to run the web demo locally

```bash
pnpm install
cp .env.example .env
pnpm infra:up        # PostgreSQL, Redis, Mailpit
pnpm db:migrate      # apply migration baseline
pnpm dev             # API (:3000) + web demo (:5173) together
# or individually:
pnpm dev:api         # API only  -> http://localhost:3000
pnpm dev:web         # web only  -> http://localhost:5173
```

Open <http://localhost:5173>, register an account (this auto-provisions a
personal organization and signs you in), then create a **team** organization from
the switcher to exercise the multi-org flow. Invitation emails land in Mailpit at
<http://localhost:8025>.

Configuration (all optional, with local-dev defaults in `src/config.ts`):

| Vite env var | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3000` | Orgistry API base URL |
| `VITE_CSRF_HEADER_NAME` | `x-orgistry-csrf` | must match `AUTH_CSRF_HEADER_NAME` |
| `VITE_MAILPIT_URL` | `http://localhost:8025` | local invitation email inbox |

The backend's `CORS_ORIGINS` must include the web origin (`http://localhost:5173`
by default) — the refresh-cookie and logout flows require `credentials: include`,
which the strict CORS allow-list governs.

### How to validate the web demo

```bash
pnpm --filter @orgistry/web-demo typecheck   # strict tsc (app + node config)
pnpm --filter @orgistry/web-demo test         # jsdom component/route smoke tests
pnpm --filter @orgistry/web-demo build        # production Vite build
```

`pnpm typecheck` at the repo root also covers the web demo. The root `pnpm test`
runner is intentionally scoped to API + package `*.test.ts` files (Node
environment); the web demo's `*.test.tsx` suites run under jsdom via the package
script above.

The web demo consumes the backend over HTTP, so the backend's own
`pnpm test:integration` (live PostgreSQL + Redis) is the authority for the
contracts it relies on. Sprint 11 changes no backend code, but those suites are
part of the sprint's validation matrix — see
[`sprint-11-artifact-package.md`](./sprint-11-artifact-package.md) §3 for the run
and the local-infrastructure note (how to validate when the default Postgres port
is occupied).

### How to extend admin surfaces safely

1. Add or reuse a contract DTO in `@orgistry/contracts` — never invent a response
   shape in the frontend.
2. Add a hook in `src/hooks/` that calls the API client and is keyed by the
   selected organization id (use `useSelectedOrganizationId()`); build lists on
   `useCursorQuery`.
3. Add a page in `src/pages/` and a route in `App.tsx` + a nav entry in
   `AppShell.tsx`.
4. Gate actions with `useEffectivePermissions().has(...)` for the **hint**, and
   still render the backend error with `ErrorBanner` when a call fails.
5. Add a smoke test using the `src/test/harness.tsx` mock API.

Do not move authorization, entitlement, quota, or tenant decisions into the
client, and do not persist access tokens or raw secrets.

---

## B. Architecture notes

### Why the frontend is a thin consumer

Orgistry's value is its backend identity/access foundation. The web demo exists to
prove those APIs are consumable by an official client end-to-end, not to own any
product logic. Keeping it thin means there is exactly one place each decision is
made (the backend), so the demo can never drift from — or quietly weaken — the
real policy. Every page maps to existing endpoints; the sprint introduced no new
backend domain and no backend redesign.

### How the API client handles envelopes

Every response is the platform envelope: `{ ok: true, data }` or
`{ ok: false, error: { code, message, requestId, details? } }`. The client
(`src/api/client.ts`) unwraps success to `data` and converts failure into a typed
`ApiError` carrying the stable `code`, the safe `message`, the `requestId`, the
HTTP `status`, and any structured `details`. Pages and hooks therefore deal in
plain data or a typed error — never raw responses. A transport/parse failure that
never produced an envelope becomes a safe `UNEXPECTED_ERROR` so the UI always has
something coherent to render. `ErrorBanner` is the single consistent renderer.

### Why access tokens are memory-only

The access token is a bearer credential: anything that can read it can act as the
user until it expires. `localStorage`/`sessionStorage` are readable by any script
on the origin (the classic XSS token-theft vector) and survive indefinitely. So
the token lives **only** in a module-scoped variable inside the API client — never
in React state (it is never rendered), never in web storage. A full page reload
deliberately drops it; the session is then restored from the HttpOnly refresh
cookie, which JavaScript cannot read. This is the standard, safer split: a
short-lived in-memory access token plus a long-lived HttpOnly refresh cookie.

### How refresh-cookie bootstrap works

At app boot, `AuthProvider` calls `POST /v1/auth/refresh` (with
`credentials: include` and the CSRF header). The browser attaches the HttpOnly
refresh cookie if one exists. On success the client stores the new access token in
memory and the provider loads the current user via `GET /v1/auth/me`, landing the
user in the app without re-login. On failure the app shows the login screen. The
same refresh is reused mid-session: when an authenticated request returns `401`,
the client performs a **single-flight** refresh and retries the request once, so a
merely-expired access token never bounces the user to login. A failed mid-session
refresh resets auth state.

### How organization selection works

`OrganizationProvider` fetches the user's organizations once authenticated and
tracks a selected organization id. The selection is **client context** — it
decides which org-scoped endpoints the UI calls — and is persisted to
`localStorage` (it is a plain id, never a token or authority). After each list
load the selection is reconciled: a still-valid selection is kept; an
inaccessible one falls back to the first available organization; none yields a
"create a team" prompt. The opaque organization id is the only identifier used;
the slug is display-only and never an authorization input.

### How permission-aware UX works without becoming enforcement

`useEffectivePermissions()` reads the caller's effective permissions for the
selected org and exposes `has(key)`. Pages use it to hide or disable actions and
to show `PermissionNote` explanations. This is a **hint only**: the client still
calls the API for any real operation, and still renders the backend's `FORBIDDEN`
/ `ENTITLEMENT_REQUIRED` / `QUOTA_EXCEEDED` / `LAST_OWNER_REQUIRED` response if the
hint was wrong or stale. Hiding a button is a convenience, not a security
boundary.

### Tradeoffs and rejected alternatives

- **React Router + TanStack Query** were added rather than hand-rolling routing
  and a cache. The Sprint 1 flat path→component registry does not scale to nested
  protected routes, server-state caching, pagination, or mutation invalidation,
  and re-implementing those would be more code and more bug surface than two
  well-understood libraries. Trade-off: two dependencies and bundle size for a
  demo.
- **Memory-only token + silent refresh** over persisting the token (rejected: XSS
  exposure) and over forcing re-login on every reload (rejected: poor UX given a
  valid refresh cookie exists).
- **Single API client module holding the token** over passing the token through
  React context (rejected: would place a bearer credential into rendered state and
  invite accidental persistence). The token never leaves the client closure.
- **One hand-written stylesheet** over a design system/component library
  (rejected: out of scope; the bar is clarity, not polish).
- **Component/route smoke tests under jsdom** over full browser E2E (Playwright)
  (rejected for this sprint: no existing browser-E2E harness, and route-level
  tests through the real provider tree + a mock API cover the integration risk
  that matters). See §E.

### Constraints respected

No backend redesign; no new backend domain; no authorization in the browser;
client permission checks are UX hints only; no access token in
local/sessionStorage; refresh token stays in the HttpOnly cookie;
`credentials: include` + CSRF header on cookie-backed flows; no duplication of
backend business logic; no raw invitation tokens in the UI; raw API key secret
shown once and never persisted; no API key rotation or secret reveal; no billing,
production email, audit export, custom roles, ABAC/RLS/workers/queues, or
deployment/publishing surfaces.

---

## C. Contracts & invariants

These are stable invariants the web demo upholds. They are the frontend/backend
boundary; changing one is a reviewed decision.

1. **Backend is authoritative for authorization.** The client may hide/disable
   actions but always handles `FORBIDDEN`.
2. **Backend is authoritative for entitlements.** Feature gating
   (`api_keys_access`, `audit_log_access`) is enforced server-side; the client
   surfaces `ENTITLEMENT_REQUIRED`.
3. **Backend is authoritative for quotas.** `max_members` / `max_projects` /
   `max_api_keys` are enforced server-side; the client surfaces `QUOTA_EXCEEDED`
   with its `details`.
4. **Backend is authoritative for tenant isolation.** The route organization id is
   the authority boundary; cross-tenant access is a uniform safe not-found.
5. **Client permission checks are UX-only.** Never an enforcement point.
6. **Access token is memory-only.** Never `localStorage`, never `sessionStorage`,
   never React state.
7. **Refresh token stays in the HttpOnly cookie.** The client never reads it; it
   travels only via `credentials: include` to the `/v1/auth` cookie path.
8. **Raw API key secret is shown once and never persisted.** It exists only in
   short-lived component state immediately after creation, then is unrecoverable.
9. **Raw invitation tokens are not exposed by the admin UI.** Delivery is
   out-of-band (Mailpit locally); the UI points operators there.
10. **API envelopes are the frontend/backend boundary.** All success/error parsing
    is centralized in the API client.
11. **Selected organization id is client context, not tenant authority.** The
    backend re-resolves membership for the route org on every request.

---

## D. Integration notes

### How auth connects to the API client

The access token lives inside the API client. `AuthProvider` drives it: it calls
`refreshAccessToken()` at boot and on login/register stores the token via the
client. The client injects `Authorization: Bearer <token>` on authenticated
requests and runs single-flight refresh on `401`. When refresh is unrecoverable,
the client invokes a session-expired callback the provider registered, which
clears auth state and the query cache.

### How selected organization flows into org-scoped hooks

Org-scoped hooks call `useSelectedOrganizationId()` and build their request paths
and TanStack Query keys from it (e.g. `['projects', organizationId]`). Switching
organizations changes the id, which re-keys every dependent query and refetches
automatically. No hook accepts a caller-supplied organization id.

### How TanStack Query is used

Reads are `useQuery` / `useInfiniteQuery` (lists go through `useCursorQuery` for
load-more). Writes are `useMutation` and invalidate the relevant query keys on
success, so lists refresh after create/update/delete/role-change/revoke/plan
change. The shared client (`queryClient.ts`) never retries a 4xx (a deterministic
backend answer) and retries other failures once.

### How permissions affect visible actions

`useEffectivePermissions().has(key)` disables or hides actions and shows
`PermissionNote`. Backend calls still run and their errors still render — the hint
is advisory only.

### How backend errors are rendered

Always through `ErrorBanner`, which shows the safe backend `message`, adds a
specific explanation for `QUOTA_EXCEEDED` / `ENTITLEMENT_REQUIRED` from their
`details`, and always shows the `requestId` for log correlation. No backend
internals beyond the envelope fields are surfaced.

### How each admin page maps to backend APIs

| Page | Endpoint(s) |
| --- | --- |
| Login / Register | `POST /v1/auth/login`, `POST /v1/auth/register`, `POST /v1/auth/refresh`, `GET /v1/auth/me`, `POST /v1/auth/logout` |
| Organization switcher | `GET /v1/organizations`, `POST /v1/organizations` |
| Overview | `GET /v1/organizations` (selected), `…/permissions/effective`, `…/plan` |
| Members | `GET …/members`, `PATCH …/members/:id/role`, `DELETE …/members/:id` |
| Invitations | `GET …/invitations`, `POST …/invitations`, `DELETE …/invitations/:id` |
| Projects | `GET …/projects`, `POST …/projects`, `PATCH …/projects/:id`, `DELETE …/projects/:id` |
| Plan & entitlements | `GET …/plan`, `GET …/entitlements`, `PATCH …/plan/demo` |
| API keys | `GET …/api-keys`, `POST …/api-keys`, `DELETE …/api-keys/:id` |
| Audit log | `GET …/audit-events` (filters + cursor) |
| Effective permissions (hints) | `GET …/permissions/effective` |

All org-scoped paths are `/v1/organizations/:organizationId/...` with the selected
id.

---

## E. Known limitations

- **Demo quality, not production-ready.** The UI targets a desktop demo: clear and
  correct, not pixel-perfect or fully responsive.
- **Design-system limitations.** A single hand-written stylesheet, no component
  library, no theming, minimal accessibility polish beyond semantic markup and
  labels.
- **Test coverage.** Component/route-level smoke tests under jsdom with a mocked
  API — no full browser E2E (no Playwright/Cypress harness exists in the repo).
  The smoke suite covers the integration seams (envelope handling, auth routing,
  org switching, projects, the one-time secret, audit DTO rendering, permission
  hinting, error rendering) but does not exercise a real browser, real cookies, or
  the live backend.
- **No backend contract workaround was introduced.** Sprint 11 consumes the
  existing APIs unchanged (no backend files modified; `pnpm db:generate` reports no
  schema drift).
- **Page-level compromises.** Invitation acceptance/onboarding UI is out of scope
  (the backend `inspect`/`accept` endpoints exist but the admin demo does not
  build a redemption screen). Audit metadata is shown as compact JSON of the
  already-sanitized DTO. Pagination is load-more (no page-number UI).

---

## F. Sprint changelog

The living Sprint 11 changelog — iteration summary, implementation/documentation
changes, validation results, quality notes, and remaining limitations — is
maintained in
[`docs/sprint-11-artifact-package.md`](./sprint-11-artifact-package.md).
