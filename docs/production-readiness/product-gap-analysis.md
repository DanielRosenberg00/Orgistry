# Product Gap Analysis

Compares the Orgistry v1 capability baseline against actual implementation. The
baseline is the as-built v1 scope defined consistently in `README.md`,
`docs/architecture.md`, and `docs/portfolio-case-study.md` (there is no separate
predating spec; `docs/sprint-1-foundation.md` is pure scaffolding). Status values:
**Implemented**, **Partially implemented**, **Scaffolding only**, **Documented but
not implemented**, **Explicitly deferred**, **No longer applicable**.

## Capability matrix

| Capability | Status | Evidence | Divergence / production impact | Findings |
| --- | --- | --- | --- | --- |
| Registration | Implemented (verification-first, S18) | `registration.routes.ts POST /v1/auth/register` + `/v1/auth/registration/complete`; `pending_registrations`; Argon2id (`password.ts`) | Enumeration oracle removed (S18): generic acceptance for all account states, account created only via emailed completion token; residual timing side channel documented | ORG-PR-030 (closed, S18) |
| Login | Implemented | `POST /v1/auth/login`; uniform error + dummy-hash timing | Fail-open limits under Redis outage | ORG-PR-009 |
| Logout | Implemented | `POST /v1/auth/logout`; revokes session + refresh tokens | — | — |
| Refresh / rotation | Implemented | `auth.repo.ts rotateRefreshToken` (txn + `FOR UPDATE`) | Benign double-refresh forces logout | ORG-PR-050 |
| Sessions (list/revoke) | Implemented | `GET /v1/auth/sessions`, `DELETE …/:id` | — | — |
| Email verification | **Implemented (S16; advisory)** | `email-verification.{service,repo,routes}.ts`; hash-only single-use tokens; transactional `FOR UPDATE` completion; web flow | Advisory only — nothing gated on the flag yet; external delivery unvalidated | ORG-PR-024 closed; ORG-PR-002 |
| Resend verification | Implemented (S16) | same authenticated request endpoint; resend invalidates prior unused tokens | — | ORG-PR-024 closed |
| Password recovery | **Implemented (S17)** | `password-recovery.{service,repo,routes}.ts`; `password_reset_tokens` (hash-only, single-use, 1 h TTL); enumeration-safe request; `FOR UPDATE` completion revokes all sessions/refresh tokens; web flow | External delivery unvalidated; request-timing residual documented | ORG-PR-004 closed; ORG-PR-002 |
| Password change | Implemented (S17) | `POST /v1/auth/change-password`; current-password re-auth; keep-current-session revocation policy | — | ORG-PR-039 closed |
| Email change | Implemented (S17) | `POST /v1/auth/change-email`; current-password re-auth; verification reset + re-issue to new address | — | ORG-PR-039 closed |
| Personal workspace | Implemented | registration-completion txn (`registration.repo.ts`) provisions it; DB partial unique `uq_organizations_active_personal_owner` enforces at-most-one-active (S20) | — | ORG-PR-038 closed |
| Team organizations | Implemented | `organization.repo.ts createTeamOrganization` | — | — |
| Organization update | **Partially** | read/create exist; archive/suspend states inert (`organizations.ts status`) | No lifecycle transitions | (roadmap) |
| Membership lifecycle | Implemented | invite-accept / removal; per-request membership re-check | No self-leave route for Member/Viewer | (noted) |
| Invitations | Implemented | full lifecycle, hash-only token, email-match; delivery via the shared account mailer (S16) | External provider delivery unvalidated | ORG-PR-002 |
| Roles | Implemented | fixed 4 roles (`access.ts`); DG-2 Owner-transition guard in-transaction (S20) | — | ORG-PR-017 closed |
| Permissions | Implemented | 23-key catalog, permission-first checks; read paths aligned, one documented membership-only exception (S20) | — | ORG-PR-053 closed |
| Projects | Implemented | soft-delete, cursor pagination, uniform 404; serialized create quota (S20) | — | ORG-PR-029 closed |
| Plans | Implemented (demo) | 3 fixed plans; `PATCH …/plan/demo` (Owner-only) | Demo-only; no billing (by design) | — |
| Entitlements | Implemented | `entitlement.service.ts`; separated from permission/quota | — | — |
| Quotas | Implemented | `quota.ts` policy + in-transaction plan snapshot (FOR SHARE) and serialized enforcement under org/kind advisory locks (S20) | — | ORG-PR-029 closed |
| API keys | **Partially** | create/list/revoke, hash-only, one-time secret | No rotation; pre-auth event write; no create rate limit | ORG-PR-013, ORG-PR-032 |
| External API | Implemented (read-only) | `GET /v1/external/projects`, tenant-derived | Fail-open limits; pre-auth write | ORG-PR-013 |
| Audit log | Implemented (read-only) | `audit.routes.ts`; sanitized; perm+entitlement gated; org/time composite index (S20) | No retention | ORG-PR-014 closed; ORG-PR-015 |
| Security events | Implemented | `security-events.ts` → `security_events` | No alerting; PII retained | ORG-PR-007, ORG-PR-043 |
| Web demo surfaces | Implemented (demo) | all pages present | Robustness/a11y gaps | ORG-PR-023, ORG-PR-036 |
| Demo credentials / seed | Implemented | `tooling/demo-seed.mjs` | Local-only, non-secret | — |
| MFA / passkeys | **Explicitly deferred** | absent (grep); `known-limitations.md` | Single-factor only | ORG-PR-045 |
| Security notifications | Documented but not implemented | events are DB-only | No user alerting | ORG-PR-045 |
| Account disablement | Partially | `status='disabled'` honored on read; no route to set it | Admin/DB-only | (noted) |
| Account deletion | Scaffolding only | `deleted_at` honored; no deletion route | No data-subject deletion | ORG-PR-025 |
| Data export | Documented but not implemented | absent (grep) | No data-subject export | ORG-PR-025 |
| Extension documentation | Implemented | `projects.md`, `rbac-permissions.md`, `entitlements-*.md` recipes | Good but under-linked | ORG-PR-046 |
| Billing | No longer applicable | intentional non-goal (`known-limitations.md`) | Entitlement/quota seam ready for it | — |

## Divergences from the v1 baseline

The as-built matches the stated v1 scope closely — the docs are honest. Material
divergences worth recording:

1. **Account-lifecycle recovery is now complete (Sprint 17).** Email
   verification shipped in Sprint 16 (advisory; ORG-PR-024/048 closed);
   password reset, password change, and email change shipped in Sprint 17
   (ORG-PR-004/039 closed — see
   [credential-management.md](../credential-management.md)); verification-first
   registration shipped in Sprint 18 (ORG-PR-030 closed — see
   [auth-foundation.md](../auth-foundation.md)). The remaining lifecycle
   divergence is the deliberately absent account deletion/export (DG-3).
2. **Organization lifecycle is modeled but inert.** `archived`/`suspended` states
   exist with no transition endpoint; the resolver already blocks non-active orgs.
3. **API keys are read-only and non-rotatable.** No rotation/update/reveal; the
   external API is intentionally read-only.
4. **All background/retention work is deferred**, so audit-retention and expiry
   are unenforced (ORG-PR-015/016).

None of these are docs overclaiming — every gap is disclosed in
`docs/known-limitations.md`. The finding is that they are **production-relevant
gaps**, not that they are hidden.

## Frontend page classification

From the web-demo audit (`apps/web-demo/src/pages`). Backend safety does not equal
frontend production readiness.

| Page | Classification | Largest gap |
| --- | --- | --- |
| LoginPage | Requires hardening | no recovery link; no deep-link return (ORG-PR-036) |
| RegisterPage | Requires hardening | minimal client validation; no post-verify follow-up |
| OverviewPage | Requires hardening | swallows permission/plan query errors; `selected!` assertion (ORG-PR-036) |
| MembersPage | Production-capable (demo) | native `window.confirm` only |
| InvitationsPage | Requires hardening | **revoke has no confirmation** (ORG-PR-036) |
| ProjectsPage | Production-capable (demo) | — |
| PlanPage | Production-capable (demo) | — |
| ApiKeysPage | Production-capable (demo) | clipboard-copy failure silent; one-time secret handling is exemplary |
| AuditPage | Production-capable (demo) | raw `JSON.stringify` of (backend-sanitized) metadata |
| NotFoundPage | Demo-only (acceptable) | static |

Cross-cutting frontend gaps: no React error boundary (ORG-PR-023), no CSP
(ORG-PR-035), limited a11y, jsdom-only tests (no browser E2E).

## Demo-only and local-only behavior

- **Demo-only:** the entire web demo (thin consumer, no authority); the
  `PATCH …/plan/demo` plan-change endpoint (no billing).
- **Local-only:** Mailpit email delivery with the default `MAIL_DRIVER=mailpit`
  (a production SMTPS driver exists since S16 but external delivery is
  unvalidated — ORG-PR-002); Docker Compose infra; `.env.example` and
  `demo-seed` credentials (non-secret placeholders).
- **Test-only:** in-memory repositories under each module's `testing/` directory;
  hardcoded CI secrets in `ci.yml`.
