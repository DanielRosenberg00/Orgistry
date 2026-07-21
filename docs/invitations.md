# Invitations — Organization Invitation Lifecycle (Sprint 9)

Sprint 9 adds the missing organization invitation lifecycle: a secure, single-use,
expiring grant that lets a specific email join one organization with one fixed
role. It closes the identity/access chain that prior sprints established:

```
authenticated user
  → active organization membership
    → required permission
      → max_members quota (reservation policy)
        → secure opaque invitation token
          → invited user acceptance (existing user OR new registration)
            → active membership creation
```

It reuses — and does not redesign — organizations, memberships, fixed roles,
permission-first access control, plans/entitlements/quotas, registration, the
action-event seam, and the success/error envelope model.

Two facts to anchor everything below:

- **Invitations create organization memberships. They do NOT create user
  sessions by themselves.** Existing-user acceptance returns organization +
  membership context; the caller is already authenticated. Registration with an
  invitation goes through the normal registration flow — since Sprint 18 that
  flow is verification-first and two-step: the invitation token is validated
  INTERNALLY at the registration request (every private failure returns the
  same generic `{ accepted: true }` as any other registration — no
  `INVITATION_*` error escapes the public register endpoint; the INSPECT
  endpoint is the invitation-feedback channel), its stable id (never the
  token) is stored with the pending registration, and acceptance happens at
  registration completion, which is also what creates the session (see
  [auth-foundation.md](auth-foundation.md)).
- **Raw invitation tokens are never persisted and never logged; token hashes are
  never exposed.** Public inspection returns only safe onboarding context.

---

## A. Developer Documentation

### What was implemented

- An `invitations` table (hash-only token storage, `inv_`-prefixed ids, lifecycle
  timestamps, never hard-deleted).
- Organization-scoped management endpoints: **create**, **list**, **revoke**.
- A token-bearing **inspect** endpoint (unauthenticated; backs new-user
  onboarding) and an **accept** endpoint (Bearer; existing user joins).
- Optional **invitation token on registration**, so a brand-new user both gets a
  personal workspace AND joins the inviting organization.
- Fail-closed invitation **email delivery** through the shared account-mailer
  boundary (since Sprint 16: `AccountMailer` in `apps/api/src/modules/mail/`,
  driver-selected — Mailpit locally, authenticated SMTPS in production; see
  [email-and-verification.md](email-and-verification.md)).
- Invitation/member **action events** (`invitation.created`, `invitation.revoked`,
  `invitation.accepted`, `membership.created_from_invitation`).
- Contracts/DTOs and stable error codes.

### Endpoints

| Method & path | Auth | Permission | Purpose |
| --- | --- | --- | --- |
| `POST /v1/organizations/:organizationId/invitations` | Bearer (user) | `invitations.create` | Create a pending invitation; send the email. |
| `GET /v1/organizations/:organizationId/invitations` | Bearer (user) | `invitations.read` | Cursor-paginated invitations (all states). |
| `DELETE /v1/organizations/:organizationId/invitations/:invitationId` | Bearer (user) | `invitations.revoke` | Revoke a pending, non-expired invitation. |
| `POST /v1/invitations/inspect` | none | — | Safe public onboarding context for an acceptable token. |
| `POST /v1/invitations/accept` | Bearer (user) | — | Existing user joins; creates the membership. |
| `POST /v1/auth/register` (extended) | none | — | Optional `invitationToken` is validated internally at the registration request — private failures return the same generic `{ accepted: true }` (no `INVITATION_*` error escapes; use inspect for feedback); the invitation is accepted at registration completion (`POST /v1/auth/registration/complete`; Sprint 18). |

The raw token travels in the **request body** for inspect/accept (never the URL
path), so it never reaches access logs or `Referer` headers — the same
secrets-out-of-URLs discipline the refresh cookie and API-key Authorization
header already follow.

### Where the code lives

```
packages/contracts/src/invitations.ts        DTOs, statuses, request/response schemas
packages/contracts/src/error-codes.ts        INVITATION_* codes
packages/db/src/schema/invitations.ts        invitations table + indexes
packages/db/migrations/0007_*.sql            generated migration
apps/api/src/modules/invitations/
  invitation.events.ts                        action event-type constants
  invitation.errors.ts                        stable error factories
  invitation.token.ts                         generate/hash (opaque token seam)
  invitation.lifecycle.ts                     expiry/acceptability (single source)
  invitation.mailer.ts                        pure invitation email rendering + accept URL
  invitation.acceptance.ts                    shared acceptance transaction body
  invitation.types.ts                         repository boundary + internal types
  invitation.repo.ts                          Drizzle persistence + acceptance tx
  invitation.service.ts                        workflows + registration guard
  invitation.routes.ts                        thin HTTP handlers
  testing/                                     in-memory repo, test app
apps/api/src/modules/mail/                     shared account mailer (drivers, serialization,
                                               in-memory test mailer) — Sprint 16
apps/api/src/modules/auth/registration.*       verification-first registration integration
                                               (internal request-time validation +
                                               completion-time acceptance) — Sprint 18
apps/api/src/modules/entitlements/            getMaxMembers + reservation quota
```

### How the pieces connect (create)

```
route (validate body, org id from path)
  → service.createInvitation
      requireMembership → requirePermission(invitations.create)
      reject if already an active member
      reject duplicate non-expired pending invitation
      requireMemberReservationQuota(active + pending >= max_members → QUOTA_EXCEEDED)
      generate raw token + hash; compute expiry
      mailer.deliver(renderInvitationEmail(…)) ← FAIL-CLOSED: send BEFORE persist
      repo.createInvitation(...)               ← insert + record invitation.created (one tx)
  → map row → Invitation DTO (never the token/hash)
```

### How to extend it safely

- **Add a field to the DTO**: extend `invitationSchema` in contracts and the
  `toInvitation` mapper. Never surface `tokenHash`, `acceptedByUserId`, or
  `revokedByUserId` — they are persistence internals.
- **Email delivery**: the service depends on the shared `AccountMailer`
  boundary (`apps/api/src/modules/mail/`). The runtime driver is selected by
  `MAIL_DRIVER` (Mailpit locally, authenticated SMTPS in production, in-memory
  in tests) — the service and the fail-closed ordering are unchanged whichever
  driver is active. See [email-and-verification.md](email-and-verification.md).
- **A new acceptance path** (e.g. a future flow): resolve the invitation
  through the shared acceptance seam — its selector accepts a token hash OR a
  stable invitation id (the id form is what registration completion uses,
  since the pending registration never stores the token) — the single
  transactional seam that enforces every invariant. Do not re-implement
  acceptance.
- **Never** branch on role name for authorization; check a permission key.

### Local email delivery (Mailpit) and token transport

With the default `MAIL_DRIVER=mailpit`, invitation email is delivered for real
over SMTP to the local **Mailpit** container defined in
`infra/docker-compose.yml` (`MAILPIT_HOST` : `MAILPIT_SMTP_PORT`, default
`localhost:1025`). The transport (`apps/api/src/modules/mail/`) is the shared
account-mailer boundary (nodemailer-backed since Sprint 16 — see
[email-and-verification.md](email-and-verification.md)) — no worker/queue.

To see an invitation email locally:

1. `pnpm infra:up` (starts Postgres, Redis, Mailpit).
2. `pnpm dev:api`, then create an invitation
   (`POST /v1/organizations/:id/invitations`).
3. Open the Mailpit web UI at `http://localhost:8025` (`MAILPIT_UI_PORT`). The
   message shows the recipient, organization, role, expiry, and the acceptance
   link `…/invitations/accept?token=<raw>`.

**Token transport policy (Policy A).** The raw invitation token is delivered ONLY
as a link in this email — email is the intended out-of-band channel. The token
therefore legitimately appears in the email body/link and on the SMTP wire to
Mailpit. The API `inspect`/`accept` endpoints take the token in the request
**body** (never the URL path), so it never reaches API access logs or `Referer`
headers. The token NEVER appears in: any API response (create/list/revoke/
inspect/accept), API URL paths, application logs, action-event metadata, or
database rows (only the SHA-256 `token_hash` is stored). The token hash is never
exposed by any API.

**Failure policy (fail-closed).** Invitation creation sends the email BEFORE
persisting the invitation. If SMTP delivery fails (connection refused, timeout,
or a non-2xx/3xx reply), the mailer rejects, creation aborts, and NO invitation
row and NO `invitation.created` event are written — there is nothing to roll
back. Precise boundary: a creation that returns success has both delivered the
email AND persisted the invitation; a creation that fails delivery persists
neither. (The only residual is that a delivered email whose subsequent insert
hits the rare duplicate-pending race would reference an invitation that was not
created — a dead link that safely resolves to `INVITATION_INVALID`.)

### Running validation

```
pnpm infra:up          # Postgres + Redis + Mailpit (local)
pnpm typecheck         # all packages
pnpm test              # unit/route suites (in-memory; no infra)
pnpm db:generate       # schema drift check (no changes expected)
pnpm --filter @orgistry/web-demo run build
pnpm db:reset:test && pnpm test:integration   # requires local Postgres (+ Redis)
```

```
pnpm typecheck         # all packages
pnpm test              # unit/route suites (in-memory; no infra)
pnpm db:generate       # schema drift check (no changes expected)
pnpm --filter @orgistry/web-demo run build
pnpm db:reset:test && pnpm test:integration   # requires local Postgres
```

---

## B. Architectural Notes

### Key design decisions

- **Hash-only tokens.** A raw invitation token is a high-entropy opaque string
  (the shared `@orgistry/auth-core` opaque-token primitive). Only its SHA-256 hash
  is stored (`token_hash`, unique). The raw value is delivered once, by email, and
  is unrecoverable from the database — identical reasoning to refresh and
  email-verification tokens.
- **Tokens in the body, never the URL.** Inspect/accept take the token in the
  request body. URL paths are logged by request logging and leak via proxies and
  `Referer`; the body is not. This is the deliberate deviation from a
  `/:token/accept` path shape, in service of "raw tokens are never logged."
- **Derived expiry, no worker.** There is no background expiration job. Expiry is
  computed from `expires_at` at inspect/accept/list time in one place
  (`invitation.lifecycle.ts`), so a still-`pending` row past its deadline is
  presented and rejected as `expired` everywhere, consistently.
- **Quota reservation policy (v1, safer).** A pending invitation reserves a seat.
  Creation is blocked when `active members + pending invitations >= max_members`.
  Acceptance independently re-checks the **active** member count against the plan
  ceiling, atomically with the membership insert. This prevents over-provisioning
  via many outstanding invitations while still guaranteeing the hard limit at the
  moment a seat is actually taken.
- **Fail-closed email delivery.** Create sends the email **before** persisting the
  invitation. If delivery throws, nothing is written — no orphan invitation, no
  `invitation.created` event, and the client gets an error. This is the cleanest
  fail-closed shape: no compensating delete, no stranded row.
- **Deterministic duplicate-pending handling.** At most one outstanding pending
  invitation per `(organization, normalized email)`, enforced by a partial unique
  index (`WHERE status = 'pending'`) — the authoritative guard — with a friendly
  service pre-check. A new invitation may be issued after the prior one is
  accepted, revoked, or has expired (stale pending rows are lazily flipped to
  `expired` on re-invite to free the slot).

### Transaction boundaries

The acceptance logic is a single shared seam — `acceptInvitationWithinTransaction`
in `invitation.acceptance.ts` — written against a transaction handle so it runs
inside whichever transaction the caller opens. There is exactly ONE acceptance
path; both callers below reuse it.

- **Create**: one transaction inserts the invitation and records
  `invitation.created`. The email send is outside (and before) it, by design
  (fail-closed).
- **Accept (existing user)**: the invitation repository opens one transaction and
  runs the shared acceptance body — lock by token hash, re-validate lifecycle +
  email match, re-check the active-member quota, insert the membership, mark the
  invitation accepted, record both `invitation.accepted` and
  `membership.created_from_invitation`. Membership creation and acceptance cannot
  diverge.
- **Registration with invitation (rewritten in Sprint 18)**: registration is
  now verification-first and two-step. At the **registration request**
  (`POST /v1/auth/register`) the invitation is validated INTERNALLY — a
  rejected invitation (unknown token, lifecycle, email mismatch, quota)
  answers the same generic acceptance as every other registration, stages
  nothing, mutates nothing, and sends nothing; precise invitation feedback
  belongs exclusively to the INSPECT endpoint — and a VALID invitation's
  **stable id**, never the token or its hash, is stored with the pending
  registration. At **registration
  completion** (`POST /v1/auth/registration/complete`) one transaction creates
  the user, personal workspace, and session, then re-runs the SAME shared
  acceptance body — resolved by invitation id this time (the seam's selector
  accepts a token hash OR an invitation id) — under a row lock, INSIDE A
  SAVEPOINT. If the invitation has become unavailable (revoked, expired,
  accepted, quota-filled), ONLY the acceptance rolls back: the account,
  workspace, and session still commit, and the response reports
  `invitation: { status: 'unavailable' }` — never silently dropped. The
  refresh cookie is set only after the transaction commits, so no session is
  ever issued for a failed completion. See
  [auth-foundation.md](auth-foundation.md) for the full flow.

### Rejected alternatives

- **Two-transaction registration** (create the account in one transaction, accept
  the invitation in a second afterwards). Rejected at the time: a race in the gap
  could leave a new user/session/personal workspace without the invited
  membership. **Sprint 18 revision:** the fail-together behavior is no longer a
  product invariant. Verification-first registration re-checks the invitation at
  completion inside a SAVEPOINT within the one completion transaction: an
  invitation that became unavailable rolls back only the acceptance, the proven
  user's account/workspace/session still commit, and the outcome is reported
  explicitly (`invitation: { status: 'unavailable' }`). Rationale: the user has
  proven the mailbox and set a password; destroying the account because a third
  party revoked an invitation would punish the proven user. There is still no
  unreported gap — the re-check happens inside the same transaction, not
  afterwards.
- **Returning the raw token in the create response** (as API keys do for secrets).
  Invitations are delivered by email; returning the token would put a redeemable
  secret in a response body and tempt logging. Tests recover the token from the
  (in-memory) mailer instead.
- **A background expiration worker.** Out of scope and unnecessary: derived expiry
  is correct and simpler.

---

## C. Contracts & Invariants

### Stable endpoints

See the table in section A. Path shapes, methods, and the body-borne token are
the contract.

### DTOs (high level)

- `Invitation` — `id`, `organizationId`, `invitedEmail`, `role` (summary),
  `status`, `invitedByUserId`, `expiresAt`, `createdAt`, `acceptedAt|null`,
  `revokedAt|null`. **Never** the token or hash.
- `PublicInvitation` (inspect) — `organizationName`, `invitedEmail`,
  `role {key,name}`, `expiresAt`, `acceptable`. No ids, no organization internals.
- `InvitationAcceptResponse` — `organization` + the caller's `membership` summary.

### Invitation statuses

`pending` → terminal `accepted` or `revoked`. `expired` is a **derived**
presentation of a pending invitation past `expires_at` (only persisted lazily on
re-invite to free the duplicate-pending slot).

### Invariants (must not change)

- **Token security**: raw token never persisted; never logged; `token_hash`
  unique and never returned by any API; neither the raw token nor the hash ever
  appears in action-event metadata.
- **Email match**: the accepting account's normalized email must equal the
  invitation's normalized invited email, on every acceptance path. Mismatch
  creates no membership and does not mark the invitation accepted.
- **Single use**: acceptance is terminal; a second acceptance fails
  (`INVITATION_ALREADY_ACCEPTED`) and never creates a second membership.
- **Role assignment**: an invitation stores exactly one fixed system role; invalid
  or custom roles are rejected at the contract boundary; the role is applied only
  on acceptance. Subsequent role changes use the existing member role-change
  endpoint.
- **Quota**: creation blocked at `active + pending >= max_members`; acceptance
  blocked at `active >= max_members`. A quota failure mutates nothing.
- **Tenant scoping**: management is scoped by the route `:organizationId`; an
  unknown/cross-tenant invitation id is a uniform `INVITATION_INVALID` (404).
- **No hard delete**: every transition is a status change.

### Error codes

`INVITATION_INVALID` (404), `INVITATION_EXPIRED` (410), `INVITATION_REVOKED`
(409), `INVITATION_ALREADY_ACCEPTED` (409), `INVITATION_EMAIL_MISMATCH` (403),
`QUOTA_EXCEEDED` (409, with `details.quota = max_members`), `CONFLICT` (409,
duplicate pending / already an active member), `FORBIDDEN` (403, missing
permission), `UNAUTHORIZED` (401), `VALIDATION_ERROR` (400). (The platform's
"unauthenticated" code is `UNAUTHORIZED`.)

### Permission decision

The catalog already contains both `members.invite` and the `invitations.*` triad.
Sprint 9 uses the dedicated triad — `invitations.create` (create),
`invitations.read` (list), `invitations.revoke` (revoke) — because it gives a
clean, symmetric mapping for the three management surfaces. Owner and Admin hold
all three; Member and Viewer hold none, so neither can create, list, or revoke.
`members.invite` is left reserved (Owner/Admin also hold it) for a possible future
member-centric surface; the two are equivalent for Owner/Admin today.

---

## D. Integration Notes

- **Organizations**: the `:organizationId` path segment is the tenant authority
  boundary for management; acceptance derives the organization from the resolved
  invitation row. Inspect exposes only the organization display name.
- **Memberships**: acceptance creates an active membership via the same columns
  the member module uses (`invited_by_user_id` is populated from the invitation).
  The `uq_memberships_active_user_org` partial unique index backstops the
  duplicate-active-membership guard.
- **RBAC**: authorization is by permission key through the existing
  `requireMembership`/`requirePermission` helpers. No role-name branching.
- **Entitlements/quotas**: the entitlement service gained `getMaxMembers` and
  `requireMemberReservationQuota`; acceptance reuses the existing active-member
  quota boundary. No plan/quota model change.
- **Registration**: `registerRequestSchema` carries an optional
  `invitationToken`. Since Sprint 18 the integration lives in the registration
  module (`apps/api/src/modules/auth/registration.*`): the request validates
  the token internally (rejections collapse to the generic acceptance —
  `resolveRequestInvitation` is the single translation point) and stages the
  stable invitation id for valid ones; completion re-runs the shared
  acceptance seam (selector: token hash OR invitation id) inside a savepoint.
  The personal workspace is always created by the completion transaction.
- **Mailpit / local mailer**: `InvitationMailer` is the seam; the runtime
  transport (`createMailpitInvitationMailer`) delivers over SMTP to the local
  Mailpit container (`MAILPIT_*` config), viewable in the Mailpit web UI.
  Delivery is fail-closed and the transport never logs (so the raw token in the
  email body is never written to application logs).
- **Action events**: written through the existing organization-scoped
  `security_events` sink, inside the mutation transaction, with sanitized
  metadata. There is no public audit-log read API.

---

## E. Known Limitations

All within the accepted Sprint 9 scope:

- No invitation UI and no web-demo invitation pages.
- No bulk/CSV invitation import and no invitation reminders.
- No dedicated resend endpoint (re-invite after accept/revoke/expiry is supported
  by creating a new invitation).
- No production email provider — invitation email is delivered to the local
  Mailpit container over SMTP; pointing at a real provider is out of scope.
- No external (API-key) invitation API and no API-key invitation management.
- No custom roles — only the four fixed system roles.
- No organization audit-log read API.
- No background expiration worker — expiry is enforced at inspect/accept/list
  time.

---

## F. Sprint Changelog

See `docs/sprint-9-artifact-package.md` for the full iteration log, validation
evidence, security review, and scope-control confirmation. Summary:

- Added the `invitations` table (migration `0007`), `inv_` ids, hash-only tokens,
  partial unique duplicate-pending guard.
- Added create/list/revoke/inspect/accept endpoints and registration-with-token.
- Added the reservation quota policy, the four action events, and a fail-closed
  Mailpit SMTP mailer (zero-dependency, real local delivery).
- Made registration-with-invitation a SINGLE transaction (account + workspace +
  invited membership + acceptance commit or roll back together).
- Added contracts, error codes, and tests (route, contract, lifecycle, mailer,
  SMTP transport, plus a DB-backed integration suite). Full unit suite green (440
  tests); integration suite green against live Postgres (migration-from-scratch +
  invitation/registration), Mailpit delivery verified end-to-end; typecheck
  clean, no schema drift, web build green.
