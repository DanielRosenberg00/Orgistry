# Sprint 20 — Quota-race and authorization audit (implementation note)

Status: implementation-scoped engineering note for Sprint 20 (ORG-PR-029 /
ORG-PR-044 / ORG-PR-017 / ORG-PR-038 / ORG-PR-053 / ORG-PR-014). This maps the
**pre-Sprint-20** state of every quota-protected mutation path and the selected
remediation. It is not a repository-wide audit; see
[findings-register.md](findings-register.md) for the full register and the
[sprint-20-artifact-package.md](sprint-20-artifact-package.md) for the final
evidence.

## Serialization primitive (selected)

Transaction-scoped PostgreSQL advisory locks, keyed by organization and quota
kind:

```sql
SELECT pg_advisory_xact_lock(hashtextextended('quota:<kind>:<organizationId>', 0))
```

Paired (correctness refinement, same sprint) with an IN-TRANSACTION plan
snapshot: plan assignment is runtime-mutable (`PATCH …/plan/demo`), so the
ceiling itself must come from the protected transaction, not from a caller.
`lockOrganizationEntitlements(tx, orgId)`
(`entitlement.snapshot.ts`) reads the `organization_plans` row **`FOR SHARE`**
inside the quota transaction: the read blocks a concurrent plan change's
`FOR UPDATE` until the quota transaction commits (one plan state covers the
gate, the count, the comparison, and the write), while staying compatible
with other `FOR SHARE` readers so different quota kinds never serialize on
the plan row. Repository mutation contracts carry NO `max*` parameters — a
stale pre-transaction ceiling is structurally impossible.

- `<kind>` ∈ `projects` | `api_keys` | `members` — one lock per (organization,
  quota kind), so unrelated quotas and unrelated organizations never contend.
- Transaction-scoped (`_xact_`): released automatically at commit/rollback;
  nothing persists, nothing to clean up, no lock table rows.
- Same construction the Sprint 18 pending-registration issuance lock already
  uses (`registration.repo.ts`), so it follows an existing repository
  convention rather than introducing a new mechanism.
- Helper: `apps/api/src/modules/entitlements/quota-lock.ts` —
  `acquireOrganizationQuotaLock(tx, organizationId, kind)`. Must be called
  inside an open transaction (documented on the helper).

Rejected alternatives: locking the `organization_plans` row FOR UPDATE would
serialize *all* quota kinds plus demo plan changes behind one row; counter rows
would introduce new state that can drift from the counted tables.

## Global lock order

1. `pending_registrations` row (`FOR UPDATE`) — registration completion only
   (the token single-use seam; unrelated to quotas but held first on that path).
2. Organization-quota advisory lock (`quota:<kind>:<org>`), at most ONE per
   transaction.
3. `organization_plans` row (`FOR SHARE` — the in-transaction plan snapshot).
4. Invitation rows (`FOR UPDATE` on the accepted row; `UPDATE` of lazily
   expired rows in create).
5. Row inserts (`memberships`, `projects`, `api_keys`, `invitations`) and the
   in-transaction success event inserts (`security_events`).

Plan MUTATION (`changeOrganizationPlan`) takes ONLY the plan row
(`FOR UPDATE`) plus its same-transaction event insert — no advisory lock, no
invitation locks — so it slots into the order at position 3 with nothing held
before it, and no cycle is possible in either direction.

Cycle argument: no transaction acquires more than one advisory quota lock; the
advisory lock always precedes the plan-row and invitation-row locks;
`pending_registrations` row locks are taken only by the completion path and
only before everything else; membership/project/api-key inserts never lock
pre-existing rows (unique-index waits resolve in the same order because the
advisory lock already serializes the writers of a given quota kind).
Owner-role mutations lock membership rows but never take a quota or plan
lock, so they cannot participate in a cross-kind cycle.

Downgrade semantics (product policy, unchanged and documented separately from
creation-time atomicity): ceilings are enforced when capacity is CONSUMED.
A plan downgrade never revokes existing rows, so an organization can be
over-quota after a downgrade; the serialized creation path simply rejects
further creates until usage drops below the new ceiling.

## Path-by-path map (pre-change state → remediation)

### 1. `projects.create` (`POST /v1/organizations/:orgId/projects`)

| Aspect | Pre-Sprint-20 |
| --- | --- |
| Permission check | `project.service.createProject` — `requirePermission(projects.create)` |
| Entitlement check | none (projects have no boolean gate) |
| Quota check | service, `entitlements.requireProjectCreationQuota` → `plan.repo.countActiveProjects` — **outside any transaction** |
| Counted rows | `projects` where `organization_id = ? AND deleted_at IS NULL` (soft-deleted excluded) |
| Write | `project.repo.createProject` — **separate** transaction (insert + `project.created` event) |
| Transaction boundary | check-tx and write-tx are different connections |
| Lock behavior | none |
| Race | two concurrent creates at `limit - 1` both pass the count and both insert → ceiling exceeded |
| Events | `project.created` written in the write transaction (correct) |

**Remediation:** the repo transaction acquires `quota:projects:<org>`,
resolves the CURRENT plan through the same transaction
(`lockOrganizationEntitlements`, plan row `FOR SHARE`, fail-safe
`PLAN_STATE_MISSING`), counts active projects, applies `requireQuota` (same
`QUOTA_EXCEEDED` shape), inserts, and records the event — one transaction,
serialized against both concurrent creates and concurrent plan changes. The
service no longer resolves or passes any ceiling.

### 2. `api_keys.create` (`POST /v1/organizations/:orgId/api-keys`)

| Aspect | Pre-Sprint-20 |
| --- | --- |
| Permission check | `api-key.service.createApiKey` — `requirePermission(api_keys.create)` |
| Entitlement check | service, `requireApiKeysAccess` (plan boolean) |
| Quota check | service — `apiKeys.countActiveApiKeys` then `requireApiKeyCreationQuota` — **outside any transaction** |
| Counted rows | `api_keys` where `organization_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)` (revoked/expired excluded) |
| Write | `api-key.repo.createApiKey` — separate transaction (insert + `api_key.created` event) |
| Transaction boundary | split, as with projects |
| Lock behavior | none |
| Race | identical TOCTOU overrun of `max_api_keys` |
| Events | `api_key.created` in the write transaction (correct); secret is hash-only (unchanged) |

**Remediation:** the service keeps `requireApiKeysAccess` as a
NON-AUTHORITATIVE fast-fail (before secret generation; preserves the
permission → entitlement error order); the repo transaction acquires
`quota:api_keys:<org>`, resolves the CURRENT plan through the same
transaction, re-checks `api_keys_access` AND `max_api_keys` from that ONE
snapshot (they can never reflect two different plan states), counts active
keys with the same predicate, applies `requireQuota`, inserts, records the
event. Secret generation stays outside the transaction — a pure CSPRNG draw
with no side effects; on failure the hash was never written and the raw value
is discarded. One-time raw-secret disclosure and hash-only storage unchanged.

### 3. `invitations.create` (`POST /v1/organizations/:orgId/invitations`)

| Aspect | Pre-Sprint-20 |
| --- | --- |
| Permission check | `invitation.service.createInvitation` — `requirePermission(invitations.create)` |
| Entitlement check | none (invitations have no boolean gate) |
| Quota check | service, `requireMemberReservationQuota(active members + non-expired pending invitations vs max_members)` — **outside any transaction**, BEFORE the fail-closed email |
| Counted rows | active memberships + `invitations` where `status='pending' AND expires_at > now` |
| Write | `invitation.repo.createInvitation` — separate transaction (lazy-expiry update + insert + `invitation.created` event) |
| Transaction boundary | split |
| Lock behavior | none (partial unique index guards only same-email duplicates, not the seat count) |
| Race | concurrent creates for DIFFERENT emails can over-reserve seats past `max_members` |
| Events | `invitation.created` in the write transaction (correct) |

**Capacity model (existing, preserved):** capacity is **reserved at invitation
creation** (`active members + pending invitations < max_members`) **and
re-enforced at acceptance/completion against active members only**. Sprint 20
does not change this product policy; it makes both checks atomic.

**Remediation:** the service pre-check stays where it is (it must run BEFORE
the fail-closed email — the email is deliberately sent before persistence, and
a lock must never be held across SMTP I/O) and is explicitly
non-authoritative; the repo transaction then acquires `quota:members:<org>`,
resolves the CURRENT `max_members` through the same transaction, re-counts
members + pending reservations, and applies `requireQuota` before the insert. Narrow accepted residual: under a lost race
the courtesy email for the losing request was already sent, but its token was
never persisted, so the link resolves to `INVITATION_INVALID` — no state and no
seat is leaked.

### 4. Invitation acceptance (`POST /v1/invitations/accept`)

| Aspect | Pre-Sprint-20 |
| --- | --- |
| Permission check | none by design (Bearer-authenticated token holder; org derived from the token) |
| Entitlement check | none |
| Quota check | inside the acceptance transaction (`invitation.acceptance.ts`) — counts active members vs `max_members` |
| Counted rows | active memberships of the invitation's organization |
| Write | membership insert + invitation `accepted` mutation, same transaction |
| Transaction boundary | single transaction (correct) |
| Lock behavior | `FOR UPDATE` on the invitation row only — serializes same-token races, **not** distinct-token races |
| Race | two DISTINCT valid invitations accepted concurrently both count `limit - 1` members and both insert → `max_members` exceeded |
| Events | `invitation.accepted` + `membership.created_from_invitation` in the transaction (correct) |

**Remediation:** the shared acceptance body resolves the organization id with a
non-locking read of the invitation, acquires `quota:members:<org>` BEFORE the
`FOR UPDATE` row lock (the documented lock order), resolves the CURRENT
`max_members` through its own transaction (no `maxMembers` parameter exists
on the acceptance contract any more), then proceeds exactly as before — the
in-transaction count is serialized across distinct tokens AND against plan
changes. Single-use, email-match, lifecycle, and duplicate-membership
behavior unchanged.

### 5. Registration completion with invitation acceptance (`POST /v1/auth/registration/complete`)

| Aspect | Pre-Sprint-20 |
| --- | --- |
| Permission check | none by design (public token proof) |
| Quota check | same in-transaction count as path 4 (the completion savepoint runs the shared acceptance body); `prepareForRegistration` also pre-checks at request time (advisory only) |
| Write | user + personal workspace + session + refresh token + (savepoint) membership + invitation mutation — one transaction |
| Transaction boundary | single transaction with an acceptance savepoint (correct; invitation-unavailable rolls back only the savepoint) |
| Lock behavior | `FOR UPDATE` on the pending-registration row, then `FOR UPDATE` on the invitation row — same distinct-token gap as path 4 |
| Race | concurrent completions carrying DISTINCT invitations into one org can exceed `max_members` |
| Events | `registration_completion_succeeded` written AFTER commit (post-commit success event, existing design); invitation events inside the savepoint (correct) |

**Remediation:** inherited from path 4 (shared body). Lock order on this path:
pending-registration row → `quota:members:<org>` → plan row `FOR SHARE` →
invitation row. The completion port carries NO plan values (it is an
existence check only). A quota loss surfaces as the documented `unavailable`
invitation outcome; the account itself still commits (Sprint 18 policy,
preserved).

### 6. Other membership-creation paths

- `insertOrganizationWithOwnerMembership` (registration completion personal
  workspace; team-organization create): creates the FOUNDING membership of a
  brand-new organization. The organization id does not exist before the
  transaction, so no concurrent writer can target it and the founding member
  can never exceed any ceiling — exempt from the quota lock by construction.
- Test helpers insert membership rows directly; they are not production paths.
- No other production code path inserts into `memberships` (verified by
  grep over `insert(schema.memberships)` / raw SQL).

### 7. Member role change / removal (ORG-PR-017 — authorization, not quota)

Pre-change: `members.change_role` is held by Owner AND Admin, and
`organization.repo.changeMemberRole` enforced only the Last-Owner demotion
invariant — an Admin could set any membership (including their own) to
`owner`. Remediation: the ratified DG-2 policy is enforced INSIDE the
mutation transaction — any transition that grants or removes the Owner role
(and any removal of an Owner member) requires the ACTOR to hold one of the
locked active-owner memberships (`assertOwnerChangeAuthority`,
`owner-transition.ts`), rejected with the standard safe 403 after target
resolution so cross-tenant probes still see the uniform 404.

## Event-write posture (reviewed, §9)

- Success events for projects / api keys / invitations / memberships / member
  admin are written in the SAME transaction as the mutation — they commit or
  roll back together. Unchanged.
- `registration_completion_succeeded` and the request-path anonymous outcome
  events are deliberately written OUTSIDE the mutation transaction (Sprint 18
  design: an event-store failure must never alter the public contract).
  Preserved.
- Failed attempts (quota rejections, forbidden transitions) write no success
  event and leave no rows (the transaction aborts before/at the guard).
