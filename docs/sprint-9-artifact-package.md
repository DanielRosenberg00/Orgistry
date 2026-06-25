# Sprint 9 Artifact Package

**Sprint:** 9 — Invitations Lifecycle
**Status:** Implementation complete; ready for review.
**Scope:** Organization invitation lifecycle (create / list / revoke / inspect /
accept), registration-with-invitation, local fail-closed mailer, reservation
quota, action events, contracts, tests, and synchronized documentation.

This package is the living changelog and review evidence for Sprint 9. The
developer/architecture/contract/integration documentation lives in
`docs/invitations.md`; this file records what changed, how it was validated, and
how scope was controlled.

---

## 1. Implementation Summary

### What was implemented

- **Persistence**: an `invitations` table with `inv_`-prefixed ids, hash-only
  token storage (unique `token_hash`), one organization, one normalized invited
  email, one fixed role, lifecycle status + timestamps, and inviter/accepter/
  revoker user ids. Rows are never hard-deleted. Migration `0007` generated.
- **Token security**: server-side opaque token generation via the shared
  `@orgistry/auth-core` primitive; only the SHA-256 hash is persisted; the raw
  token appears only in the email link and travels in request bodies (never URLs).
- **Endpoints**: organization-scoped create/list/revoke (Bearer + permission),
  public token inspect, Bearer accept, and an extended registration that accepts
  an optional invitation token.
- **Quota**: v1 reservation policy — creation blocked at `active + pending >=
  max_members`; acceptance re-checks `active >= max_members` atomically with the
  membership insert.
- **Mailer**: a swappable `InvitationMailer` whose default runtime transport
  (`createMailpitInvitationMailer`) delivers over SMTP to the local Mailpit
  container (zero-dependency `net` client); fail-closed on create; never logs.
- **Events**: `invitation.created`, `invitation.revoked`, `invitation.accepted`,
  `membership.created_from_invitation`, with sanitized metadata.

### Major modules / files

- `packages/contracts/src/invitations.ts`, `error-codes.ts`, `auth.ts`, `index.ts`
- `packages/db/src/schema/invitations.ts` (+ schema/index, db index), migration `0007`
- `packages/config` (`INVITATION_TTL_SECONDS`)
- `apps/api/src/modules/invitations/*` (events, errors, token, lifecycle, mailer,
  mailpit-mailer, acceptance, types, repo, service, routes, testing helpers)
- `apps/api/src/modules/auth/*` (optional registration guard wired into `register`)
- `apps/api/src/modules/entitlements/*` (`getMaxMembers`, `requireMemberReservationQuota`)
- `apps/api/src/app.ts`, `apps/api/src/server.ts` (wiring)

### Important design decisions

- Token in request body, not URL → upholds "raw tokens are never logged". The
  raw token appears only in the email/link and on the SMTP wire to Mailpit.
- Send email before persisting → clean fail-closed create (no orphan rows).
- SINGLE-transaction registration → `registerAccount` accepts the invitation in
  the same transaction that creates the user/workspace/session via a shared
  acceptance seam (`acceptInvitationWithinTransaction`). A failed accept rolls the
  whole registration back; no session is issued. A cheap pre-check fails bad
  tokens fast and resolves the `max_members` ceiling.
- Derived expiry (no worker), single source in `invitation.lifecycle.ts`.
- Partial unique index `(org, normalized email) WHERE status='pending'` is the
  authoritative duplicate-pending guard; stale pending rows lazily expire on
  re-invite.

---

## 2. API / Contract Summary

### Endpoints added/updated

- `POST /v1/organizations/:organizationId/invitations` (create, 201)
- `GET /v1/organizations/:organizationId/invitations` (list, cursor-paginated)
- `DELETE /v1/organizations/:organizationId/invitations/:invitationId` (revoke)
- `POST /v1/invitations/inspect` (public; safe context)
- `POST /v1/invitations/accept` (Bearer; existing user)
- `POST /v1/auth/register` — extended with optional `invitationToken`

### DTOs / contracts added

`invitationStatusSchema`, `invitationSchema`, `publicInvitationSchema`,
`invitationCreateRequest/Response`, `invitationListResponse`,
`invitationRouteParams`, `invitationRevokeResponse`, `invitationTokenRequest`,
`invitationInspectResponse`, `invitationAcceptResponse`, and the
`invitationToken` field on `registerRequestSchema`.

### Error codes added/used

Added: `INVITATION_INVALID` (404), `INVITATION_EXPIRED` (410),
`INVITATION_REVOKED` (409), `INVITATION_ALREADY_ACCEPTED` (409),
`INVITATION_EMAIL_MISMATCH` (403). Reused: `QUOTA_EXCEEDED`, `CONFLICT`,
`FORBIDDEN`, `UNAUTHORIZED`, `VALIDATION_ERROR`, `ORGANIZATION_NOT_FOUND`.

---

## 3. Security & Invariants

- **Token storage & transport (Policy A)**: raw token never persisted (stored as
  a unique SHA-256 hash); never returned by create/list/revoke/inspect/accept;
  never written to event metadata; never in API URL paths (inspect/accept take it
  in the body); never logged. It appears ONLY in the invitation email/link and on
  the SMTP wire to Mailpit — the intended out-of-band channel. The token hash is
  never exposed by any API.
- **Email match**: enforced on existing-user acceptance, registration, and again
  inside the acceptance transaction. Mismatch → `INVITATION_EMAIL_MISMATCH`, no
  membership, no acceptance, generic message (no account-existence leak).
- **Single use / expiration / revocation**: acceptance is terminal; expired
  (derived) and revoked invitations are rejected with precise codes; revoked and
  accepted invitations cannot be re-accepted or re-revoked.
- **Quota**: creation uses the reservation total (active + pending); acceptance
  re-checks active count inside the transaction. Any quota failure mutates
  nothing — no membership, no acceptance, no `membership.created_from_invitation`.
- **Event sanitization**: all metadata passes `sanitizeSecurityMetadata`; keys
  containing `token`/`hash`/`secret`/… are dropped; tests assert neither the raw
  token nor the hash appears in any recorded event.

---

## 4. Documentation Updates

- **`docs/invitations.md`** (new): full developer guide, architectural notes
  (quota policy, hash-only model, transaction boundaries, email delivery policy,
  duplicate-pending policy, rejected alternatives), contracts & invariants,
  integration notes, known limitations, and changelog pointer.
- **`docs/sprint-9-artifact-package.md`** (this file): summary, contract summary,
  security/invariants, validation evidence, scope control, confidence.
- **`.env.example`** and `packages/config` documented `INVITATION_TTL_SECONDS`
  and the mailer/Mailpit positioning.

---

## 5. Validation Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | ✅ pass | All 7 buildable packages, including tests. |
| `pnpm test` | ✅ pass | 440 tests across 50 files (unit/route/contract/lifecycle/mailer/SMTP). No regressions. |
| `pnpm db:generate` | ✅ pass | Migration `0007` generated; re-run reports "No schema changes" (no drift). |
| `pnpm --filter @orgistry/web-demo run build` | ✅ pass | Production build succeeds. |
| `git diff --check` | ✅ pass | No whitespace errors. |
| `pnpm db:reset:test` (migration-from-scratch) | ✅ pass | Ran against a fresh Postgres on an alternate port (5432 was occupied): "Test database reset and migrated." |
| `pnpm test:integration` | ✅ pass | 51 integration tests green (13 db migrate-from-scratch + 38 api, incl. the new 3-test invitation suite) against live Postgres + Redis. |
| Mailpit delivery (manual) | ✅ pass | `createMailpitInvitationMailer` delivered to the live Mailpit container; the message (correct subject/recipient/role/link/expiry) was confirmed via the Mailpit API (`/api/v1/messages`). |

---

## 6. Scope Control Confirmation

Not added (confirmed out of scope): invitation UI; bulk/CSV invitations;
invitation reminders; a production email provider; OAuth/SSO invite acceptance;
an external (API-key) invitation API; API-key invitation management; an audit-log
read API; custom roles; resource-level permissions; ABAC/policy engine; RLS;
workers/queues; billing/Stripe; deployment automation; package publishing.

No prior architecture (organizations, memberships, roles, permissions, plans,
quotas, sessions, API keys, projects, envelopes) was redesigned.

---

## 7. Known Limitations / Follow-up

Within accepted scope: no UI, no bulk invites, no reminders, no production email
provider (invitation email is delivered to the local Mailpit container over SMTP),
no external invitation API, no custom roles, no audit-log read API, no background
expiration worker (expiry enforced at inspect/accept/list time).

Suggested follow-ups (future sprints): an invitations UI; expanding the list
DTO's inviter field from id to a user summary if a member-style view is desired;
a production email adapter behind `InvitationMailer` when email leaves local dev.

---

## 8. Confidence Assessment

**High confidence the sprint is ready for review and meets DoD.** Typecheck, the
full unit/route suite (440), the schema-drift check, the web build, the
migration-from-scratch reset, and the integration suite (51, against live
Postgres + Redis) all pass; live Mailpit delivery was verified end-to-end via the
Mailpit API. Security invariants (hash-only tokens, no token/hash leakage in
responses/logs/events/URLs, email match, single use, quota non-mutation on
failure, single-transaction registration with no session on failed accept, tenant
scoping) are each covered by explicit tests.

The earlier DoD caveat (live DB not run because port 5432 was occupied) is now
CLOSED: the live run used a throwaway Postgres on an alternate port plus the
Mailpit container, and all DB/integration validation passed.

Validation provenance: the fast commands (`pnpm typecheck`, `pnpm test`, web
build, `pnpm db:generate`, `git diff --check`) were re-confirmed in the final
handoff pass. The live commands (`pnpm db:reset:test`, `pnpm test:integration`,
Mailpit delivery) passed in the verified run earlier in the same session; the
throwaway Postgres/Redis containers and the Mailpit container were then removed,
so reproducing them requires `pnpm infra:up` (or CI-provided services).

---

## 9. Documentation Index

| File | Covers |
| --- | --- |
| `docs/invitations.md` | The Sprint 9 invitation-lifecycle reference (A–F): developer guide and code map; architecture (hash-only tokens, derived expiry, reservation quota, fail-closed delivery, duplicate-pending, single-transaction registration, rejected alternatives); contracts & invariants; integration notes; known limitations; changelog. Includes the local Mailpit delivery + token-transport-policy + failure-policy subsection. |
| `docs/sprint-9-artifact-package.md` | This package — the official Sprint 9 completion artifact: implementation summary, API/contract summary, security & invariants, documentation updates, validation results, scope control, known limitations, confidence, documentation index, remaining risks, and next-sprint readiness. |
| `README.md` | Top-of-repo summary paragraph for Sprint 9; the invitation endpoint/flow section; the endpoint table; the corrected "not included" scope list; and the documentation index entries for the two files above. |
| `.env.example` | `INVITATION_TTL_SECONDS` (7-day default) and the `MAILPIT_*` values used for local SMTP delivery. |
| `packages/config/src/schema.ts` | Inline config docs: `INVITATION_TTL_SECONDS` and the corrected Mailpit comment (real SMTP delivery to the Mailpit container, not a log sink). |

No separate architecture/security document was required; the architecture and
security material lives in sections B and C of `docs/invitations.md` and section 3
of this package.

---

## 10. Remaining Risks

Only real, accepted risks remain:

- **Mailpit SMTP transport is local-development only.** `createMailpitInvitationMailer`
  speaks the minimal no-auth/no-TLS SMTP exchange Mailpit accepts; it is not a
  production transport.
- **Production email delivery is future work** behind the `InvitationMailer` seam
  (a production adapter would be a drop-in; intentionally not built).
- **No invitation UI.** Invitations are API + email only; presentation is a future
  surface.
- **The organization audit-log READ API is next-sprint work.** Invitation, member,
  project, plan, and API-key action events are persisted on the internal
  `security_events` seam, but there is no permission-gated read API yet (by design).
- **Equivalent validation needs infrastructure.** Reproducing the live DB and
  Mailpit validation requires Postgres + Redis + Mailpit (CI must provide them, or
  run `pnpm infra:up` locally).

---

## 11. Readiness for Next Sprint

**Sprint 10 can proceed without revisiting any Sprint 9 deliverable.** The
following are stable and need no rework: the invitation schema and migration
`0007`; the hash-only token model; the four invitation statuses (with derived
`expired`); the create/list/revoke management APIs; the public inspect API;
existing-user acceptance; single-transaction registration-with-invitation;
email-match enforcement; fixed-role assignment; the `max_members` reservation and
acceptance quota integration; the invitation/member action events; the contracts/
DTOs; and the documentation.

**Recommended next sprint: the organization Audit Log Read API.** It is the
strongest backend continuation — invitation, member, project, plan, and API-key
action events already exist on the internal event seam, so a permission-gated
(`audit_events.read`) read surface is now a natural, additive slice with no
schema redesign. **Web Demo Admin Surfaces** remains a valid alternative if
presentation becomes the priority instead.

---

Sprint 9 is ready to close.
