# API Surface Index

A consolidated index of every HTTP route the Orgistry API exposes, grouped by
domain. This is **documentation only** — it introduces no endpoints. Routes are
defined under `apps/api/src/routes` and `apps/api/src/modules/*`.

## Conventions

- **Auth types**: `none` (public); `Bearer` (user access-token JWT); `Cookie+CSRF`
  (HttpOnly refresh cookie plus the custom CSRF header); `API key` (external
  machine credential).
- **Permission**: the permission key checked via
  `requireMembership → requirePermission(...)`. "active membership" means
  membership is required but no specific permission key.
- **Entitlement / quota**: the plan entitlement or quota enforced (after the
  permission check). Blank = none.
- Every response uses the standard envelope (`{ ok, data }` / `{ ok, error }`)
  and organization-scoped reads are cursor-paginated. See
  [api-conventions](./api-conventions.md).
- **Global rate limit (Sprint 19)**: every route except `/health`, `/ready`,
  and CORS `OPTIONS` preflight shares one fixed-window bucket per trusted
  client IP (`RATE_LIMIT_MAX`, default 300 per `RATE_LIMIT_WINDOW_SECONDS`,
  default 60), evaluated before route-specific work; over-limit →
  `429 RATE_LIMITED`. Endpoints marked **429** below additionally carry their
  own per-actor buckets. Sensitive rate-limited endpoints (auth flows,
  invitation inspect/accept/create, the external API, the mutation buckets)
  may return `503 SERVICE_UNAVAILABLE` when Redis is down and the limiter
  fails closed (the production default) — see
  [api-conventions](./api-conventions.md).

## Health / Readiness

| Method | Path | Auth | Purpose / notes |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness only; never touches dependencies; always `200` when up. |
| GET | `/ready` | none | Readiness; checks PostgreSQL + Redis (both required). In development/test: `503` with a per-dependency `checks` array (name/ok/latencyMs; never error text/hosts/ports) if any is down. In production (Sprint 19): coarse output only — `200 {status:'ready'}` or a generic `503 SERVICE_UNAVAILABLE` with no dependency names; per-check outcomes are logged server-side. |

## Auth

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/register` | none | — | Request registration (verification-first, Sprint 18). Validates and rate-limits per IP + per email digest BEFORE any lookup, then **always** returns `200 { accepted: true }` — for new, existing, disabled, and soft-deleted accounts AND for every private failure of an optional `invitationToken` (unknown/expired/revoked/accepted, email mismatch, quota) alike; only `VALIDATION_ERROR` and `RATE_LIMITED` are explicit. Creates NO user, session, or cookie; never returns `EMAIL_ALREADY_REGISTERED` or any `INVITATION_*` error (invitation feedback lives on `/v1/invitations/inspect`). Eligible new emails get a completion email; rejected invitations stage and send nothing. |
| POST | `/v1/auth/registration/complete` | none | — | Complete registration by raw token possession. Body `{ token }` (never a URL). One transaction creates the email-verified user + personal workspace + Owner membership + session, and accepts a stored invitation where applicable; refresh cookie set after commit. Returns `201 { user, tokens, invitation }` (`invitation`: null / `{status:'accepted'}` / `{status:'unavailable'}`); errors: `REGISTRATION_TOKEN_INVALID` 404, `…_EXPIRED` 410, `…_USED` 409. |
| POST | `/v1/auth/login` | none | — | Login; creates session; sets refresh cookie. |
| GET | `/v1/auth/me` | Bearer | — | Current authenticated user. |
| POST | `/v1/auth/refresh` | Cookie+CSRF | — | Rotate refresh token; returns a fresh access token only. |
| POST | `/v1/auth/logout` | Cookie+CSRF | — | Revoke session; always clears the cookie. |
| GET | `/v1/auth/sessions` | Bearer | `sessions.read` | List the caller's sessions (cursor-paginated). |
| DELETE | `/v1/auth/sessions/:sessionId` | Bearer | `sessions.revoke` | Revoke a session; clears the cookie if it is the current one. |
| POST | `/v1/auth/email-verification/request` | Bearer | — | Issue/resend a verification email for the CURRENT user's stored address (no body; enumeration-safe). Safe success when already verified. Returns `{ sent, alreadyVerified }`. |
| POST | `/v1/auth/email-verification/complete` | none | — | Complete verification by raw token possession. Body `{ token }` (never a URL path). Returns `{ verified: true }`; errors: `EMAIL_VERIFICATION_TOKEN_INVALID` 404, `…_EXPIRED` 410, `…_USED` 409. |
| POST | `/v1/auth/password-recovery/request` | none | — | Request a password-reset email. Body `{ email }`. **Enumeration-safe**: identical `{ accepted: true }` for existing, unknown, and inactive accounts (and on internal mail failure). Rate-limited per IP + per email digest. |
| POST | `/v1/auth/password-recovery/complete` | none | — | Complete a reset by raw token possession. Body `{ token, newPassword }` (shared password policy). Revokes ALL of the user's sessions and refresh tokens; issues no session (sign in again). Returns `{ reset: true }`; errors: `PASSWORD_RESET_TOKEN_INVALID` 404, `…_EXPIRED` 410, `…_USED` 409. |
| POST | `/v1/auth/change-password` | Bearer | — | Change password with mandatory current-password re-auth. Keeps the caller's session; revokes every other session + its refresh tokens. Wrong current password → `INVALID_CREDENTIALS` **400** (not 401). Returns `{ success: true }`. |
| POST | `/v1/auth/change-email` | Bearer | — | Change email with mandatory current-password re-auth (direct-change policy). Clears verification, invalidates old verification tokens, best-effort sends a new verification email to the NEW address. Duplicate → `EMAIL_ALREADY_REGISTERED` 409. Returns `{ user }`. |

## Organizations

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| POST | `/v1/organizations` | Bearer | — | Create a team org (Free plan; caller becomes Owner). **429**: throttled per user (`RATE_LIMIT_ORG_CREATE_PER_USER_MAX`, default 10/min; Sprint 19). |
| GET | `/v1/organizations` | Bearer | — | List orgs where the caller has an active membership. |
| GET | `/v1/organizations/:organizationId` | Bearer | `org.read` | Read one org (requires active membership). `org.read` is enforced in code since Sprint 20 (all fixed roles hold it — no behavior change). |

## Members

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/members` | Bearer | `members.read` | List members (cursor-paginated; soft-removed omitted). |
| PATCH | `/v1/organizations/:organizationId/members/:membershipId/role` | Bearer | `members.change_role` | Change a member's role; DG-2 Owner-transition policy (Sprint 20: only an active Owner may grant or remove Owner — safe 403 otherwise) and the Last Owner invariant enforced transactionally. **429**: shares the per-acting-user member-admin bucket (`RATE_LIMIT_MEMBER_MUTATION_PER_USER_MAX`, default 30/min; Sprint 19 refinement). |
| DELETE | `/v1/organizations/:organizationId/members/:membershipId` | Bearer | `members.remove` | Soft-remove a member; removing an Owner member requires Owner authority (DG-2, Sprint 20); Last Owner protected. **429**: shares the member-admin bucket above (Sprint 19 refinement). |

## Roles and Permissions

Global static reference (authenticated, **not** permission-gated — must not be
read as a tenant's authorization state):

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/roles` | Bearer | — | The four fixed roles. |
| GET | `/v1/permissions` | Bearer | — | The fixed permission catalog. |
| GET | `/v1/permissions/matrix` | Bearer | — | Role → permission matrix. |

Organization-scoped, permission-gated:

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/roles` | Bearer | `roles.read` | Roles in org context. |
| GET | `/v1/organizations/:organizationId/permissions` | Bearer | `permissions.read` | Permission catalog in org context. |
| GET | `/v1/organizations/:organizationId/permissions/matrix` | Bearer | `permissions.read` | Matrix in org context. |
| GET | `/v1/organizations/:organizationId/permissions/effective` | Bearer | active membership | The caller's OWN effective permissions (drives UI hints). Intentionally membership-only — the documented ORG-PR-053 exception: self-introspection cannot be permission-gated without circularity. |

## Projects

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/projects` | Bearer | `projects.read` | — | List projects (cursor-paginated; soft-deleted omitted). |
| POST | `/v1/organizations/:organizationId/projects` | Bearer | `projects.create` | `max_projects` quota | Create a project; quota checked after permission and enforced atomically inside the creation transaction (Sprint 20); records `project.created`. **429**: throttled per user after the permission check (`RATE_LIMIT_PROJECT_CREATE_PER_USER_MAX`, default 30/min; Sprint 19). |
| GET | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.read` | — | Read a project; cross-tenant/deleted → uniform `404`. |
| PATCH | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.update` | — | Rename a project. **429**: shares the per-acting-user project-mutation bucket (`RATE_LIMIT_PROJECT_MUTATION_PER_USER_MAX`, default 60/min; Sprint 19 refinement). |
| DELETE | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.delete` | — | Soft-delete; records `project.deleted`; no hard delete/restore. **429**: shares the project-mutation bucket above (Sprint 19 refinement). |

## Plans and Entitlements

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/plan` | Bearer | `plan.read` | Current plan + assignment timestamps. |
| GET | `/v1/organizations/:organizationId/entitlements` | Bearer | `plan.read` | Resolved entitlement/quota values for the plan. |
| PATCH | `/v1/organizations/:organizationId/plan/demo` | Bearer | `plan.change_demo` | **Demo-only** plan switch (Free/Pro/Business); no billing. **429**: throttled per org after the permission check (`RATE_LIMIT_PLAN_CHANGE_PER_ORG_MAX`, default 10/min; Sprint 19). |

## API Keys (management, user-authenticated)

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/organizations/:organizationId/api-keys` | Bearer | `api_keys.create` | `api_keys_access` + `max_api_keys` quota | Create a key; raw secret returned **once**; checks permission → entitlement → quota (quota enforced atomically inside the creation transaction since Sprint 20). **429**: throttled per user after the permission check (`RATE_LIMIT_API_KEY_CREATE_PER_USER_MAX`, default 10/min; Sprint 19). |
| GET | `/v1/organizations/:organizationId/api-keys` | Bearer | `api_keys.read` | `api_keys_access` | List keys (cursor-paginated; secrets never returned). |
| DELETE | `/v1/organizations/:organizationId/api-keys/:apiKeyId` | Bearer | `api_keys.revoke` | `api_keys_access` | Revoke a key (audited, idempotent). |

## External API (API-key authenticated)

| Method | Path | Auth | Scope | Entitlement | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/external/projects` | API key | `projects:read` | `api_keys_access` (every request) | Machine-facing projects read. **No** org ID in the route (tenant derived from the key); **no** browser JWT. Redis rate limits (per-key/per-org; fail closed in production, `503` on Redis outage — Sprint 19); throttled `last_used_at`; failed-auth security-event writes bounded per IP. |

## Invitations

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/organizations/:organizationId/invitations` | Bearer | `invitations.create` | `max_members` (reservation: active members + pending) | Create + email (fail-closed before persist); records `invitation.created`. **429**: throttled per user (`RATE_LIMIT_INVITATION_CREATE_PER_USER_MAX`, default 20/min) and per org (`RATE_LIMIT_INVITATION_CREATE_PER_ORG_MAX`, default 60/min), after the permission check (Sprint 19). |
| GET | `/v1/organizations/:organizationId/invitations` | Bearer | `invitations.read` | — | List pending invitations (cursor-paginated). |
| DELETE | `/v1/organizations/:organizationId/invitations/:invitationId` | Bearer | `invitations.revoke` | — | Revoke a pending invitation (idempotent). |
| POST | `/v1/invitations/inspect` | none | — | — | Public, safe token inspection (no token/hash leaked); supports new-user onboarding. **429**: throttled per trusted IP (`RATE_LIMIT_INVITATION_INSPECT_PER_IP_MAX`, default 30/min) and per token digest across all IPs (`RATE_LIMIT_INVITATION_INSPECT_PER_TOKEN_MAX`, default 10/min); response contract unchanged (Sprint 19). |
| POST | `/v1/invitations/accept` | Bearer | active user | `max_members` quota | Accept; email must match; creates membership transactionally under the org member-quota lock (Sprint 20 — distinct tokens cannot overrun the ceiling); does **not** create a session. **429**: throttled per user (`RATE_LIMIT_INVITATION_ACCEPT_PER_USER_MAX`, default 10/min; Sprint 19). |

## Audit Log

| Method | Path | Auth | Permission | Entitlement | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/audit-events` | Bearer | `audit_events.read` | `audit_log_access` | Read org action events; permission **and** entitlement both required; cursor-paginated, filterable; metadata sanitized; `meta.auditRetentionDays` is display-only. |

## Enforcement order (organization-scoped routes)

1. Authenticate the Bearer token (or API key, for `/v1/external/*`).
2. `requireMembership` — active member of the route organization.
3. `requirePermission(<key>)` — RBAC by permission key (never role name).
4. `requireEntitlement(<key>)` / `requireQuota(...)` — plan unlocks the feature /
   has remaining capacity.
5. Business logic and structural invariants (e.g. Last Owner, duplicate-pending
   invitation, uniform cross-tenant `404`).

This order makes failures attributable: `UNAUTHORIZED` → `FORBIDDEN` →
`ENTITLEMENT_REQUIRED` → `QUOTA_EXCEEDED`.
