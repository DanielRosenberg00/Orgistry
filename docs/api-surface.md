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

## Health / Readiness

| Method | Path | Auth | Purpose / notes |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness only; never touches dependencies; always `200` when up. |
| GET | `/ready` | none | Readiness; checks PostgreSQL + Redis; `503` with a per-dependency `checks` array if any is down. |

## Auth

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/register` | none | — | Register; provisions personal workspace atomically; sets refresh cookie. Optional `invitationToken` also joins the inviting org. |
| POST | `/v1/auth/login` | none | — | Login; creates session; sets refresh cookie. |
| GET | `/v1/auth/me` | Bearer | — | Current authenticated user. |
| POST | `/v1/auth/refresh` | Cookie+CSRF | — | Rotate refresh token; returns a fresh access token only. |
| POST | `/v1/auth/logout` | Cookie+CSRF | — | Revoke session; always clears the cookie. |
| GET | `/v1/auth/sessions` | Bearer | `sessions.read` | List the caller's sessions (cursor-paginated). |
| DELETE | `/v1/auth/sessions/:sessionId` | Bearer | `sessions.revoke` | Revoke a session; clears the cookie if it is the current one. |

## Organizations

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| POST | `/v1/organizations` | Bearer | — | Create a team org (Free plan; caller becomes Owner). |
| GET | `/v1/organizations` | Bearer | — | List orgs where the caller has an active membership. |
| GET | `/v1/organizations/:organizationId` | Bearer | `org.read` | Read one org (requires active membership). |

## Members

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/members` | Bearer | `members.read` | List members (cursor-paginated; soft-removed omitted). |
| PATCH | `/v1/organizations/:organizationId/members/:membershipId/role` | Bearer | `members.change_role` | Change a member's role; Last Owner invariant enforced transactionally. |
| DELETE | `/v1/organizations/:organizationId/members/:membershipId` | Bearer | `members.remove` | Soft-remove a member; Last Owner protected. |

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
| GET | `/v1/organizations/:organizationId/permissions/effective` | Bearer | active membership | The caller's effective permissions in this org (drives UI hints). |

## Projects

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/projects` | Bearer | `projects.read` | — | List projects (cursor-paginated; soft-deleted omitted). |
| POST | `/v1/organizations/:organizationId/projects` | Bearer | `projects.create` | `max_projects` quota | Create a project; quota checked after permission; records `project.created`. |
| GET | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.read` | — | Read a project; cross-tenant/deleted → uniform `404`. |
| PATCH | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.update` | — | Rename a project. |
| DELETE | `/v1/organizations/:organizationId/projects/:projectId` | Bearer | `projects.delete` | — | Soft-delete; records `project.deleted`; no hard delete/restore. |

## Plans and Entitlements

| Method | Path | Auth | Permission | Purpose / notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:organizationId/plan` | Bearer | `plan.read` | Current plan + assignment timestamps. |
| GET | `/v1/organizations/:organizationId/entitlements` | Bearer | `plan.read` | Resolved entitlement/quota values for the plan. |
| PATCH | `/v1/organizations/:organizationId/plan/demo` | Bearer | `plan.change_demo` | **Demo-only** plan switch (Free/Pro/Business); no billing. |

## API Keys (management, user-authenticated)

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/organizations/:organizationId/api-keys` | Bearer | `api_keys.create` | `api_keys_access` + `max_api_keys` quota | Create a key; raw secret returned **once**; checks permission → entitlement → quota. |
| GET | `/v1/organizations/:organizationId/api-keys` | Bearer | `api_keys.read` | `api_keys_access` | List keys (cursor-paginated; secrets never returned). |
| DELETE | `/v1/organizations/:organizationId/api-keys/:apiKeyId` | Bearer | `api_keys.revoke` | `api_keys_access` | Revoke a key (audited, idempotent). |

## External API (API-key authenticated)

| Method | Path | Auth | Scope | Entitlement | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/external/projects` | API key | `projects:read` | `api_keys_access` (every request) | Machine-facing projects read. **No** org ID in the route (tenant derived from the key); **no** browser JWT. Redis rate limits (per-key/per-org, fail-open); throttled `last_used_at`. |

## Invitations

| Method | Path | Auth | Permission | Entitlement / quota | Purpose / notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/organizations/:organizationId/invitations` | Bearer | `invitations.create` | `max_members` (reservation: active members + pending) | Create + email (fail-closed before persist); records `invitation.created`. |
| GET | `/v1/organizations/:organizationId/invitations` | Bearer | `invitations.read` | — | List pending invitations (cursor-paginated). |
| DELETE | `/v1/organizations/:organizationId/invitations/:invitationId` | Bearer | `invitations.revoke` | — | Revoke a pending invitation (idempotent). |
| POST | `/v1/invitations/inspect` | none | — | — | Public, safe token inspection (no token/hash leaked); supports new-user onboarding. |
| POST | `/v1/invitations/accept` | Bearer | active user | `max_members` quota | Accept; email must match; creates membership transactionally; does **not** create a session. |

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
