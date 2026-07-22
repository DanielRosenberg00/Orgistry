# Sprint 20 Artifact Package — Authorization and Concurrency Correctness

Sprint: 20 · Executed: 2026-07-21 · Scope: repository implementation only
(no deployment, infrastructure, or staging work).

Companion note: [sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md)
(per-path pre-change race map, serialization primitive, lock order).

---

## 1. Implementation summary

Sprint 20 hardened Orgistry's authorization and data-integrity guarantees
under concurrent and adversarial use:

- the ratified **DG-2 Owner role-transition policy** is enforced server-side,
  inside the member-mutation transaction, against the locked active-owner set;
- every **quota-protected creation** (projects, API keys, invitation seat
  reservation, and every member-capacity consumer — distinct-token invitation
  acceptance and invited registration completion included) now evaluates its
  ENTIRE quota decision in ONE transaction under a per-(organization, quota
  kind) PostgreSQL advisory lock: the CURRENT plan ceiling is resolved
  through the same transaction (plan row `FOR SHARE`), then the count,
  comparison, write, and success event follow — no pre-resolved ceiling
  crosses into any repository (a same-sprint correctness refinement closed
  that stale-plan window);
- the personal-workspace invariant is durably constrained: the database now
  enforces **at most one active personal workspace per user** (partial unique
  index), while the tested provisioning transaction continues to guarantee
  each registered user gets theirs (§9 states the two guarantees separately);
- the two ORG-PR-053 **read paths** were aligned with the permission-first
  model (one code fix, one documented intentional exception);
- the **`security_events` organization/time composite index** backing the audit
  read path was added;
- **five real-PostgreSQL concurrency suites** prove the ceilings and fail
  deterministically if the serialization is removed;
- **retention readiness** is documented (no scheduler or cleanup runtime was
  introduced — see §12).

The Definition of Done was reached (§16, §20). The readiness classification is
unchanged (§20).

## 2. Findings closed or advanced

| Finding | Status | Evidence anchor |
| --- | --- | --- |
| ORG-PR-017 — Admin can escalate self/others to Owner | **Closed** | §3, §13; findings register resolution |
| ORG-PR-029 — Quota ceilings TOCTOU-racy | **Closed** | §5–§7, §8, §13 |
| ORG-PR-038 — Personal-workspace invariant unenforced | **Closed** | §9, §13 |
| ORG-PR-044 — Narrow concurrency test coverage | **Closed** | §8, §13 |
| ORG-PR-053 — Two read paths skip the permission gate | **Closed** | §10, §13 |
| ORG-PR-014 — `security_events` org index missing | **Closed** | §11, §13 |
| ORG-PR-015 — No retention/cleanup for unbounded tables | **Open** (documented readiness only — indexes and documentation are not enforcement) | §12 |

## 3. Owner role-transition policy (DG-2)

Enforced rules (ratified 2026-07-18, [sprint-15-decisions.md](sprint-15-decisions.md)):
only an active Owner may grant the Owner role; only an active Owner may remove
it — including by removing an Owner member; an Admin may not confer Owner on
themselves or anyone else and may not demote or remove an Owner; a Member or
Viewer cannot change roles at all (no `members.change_role`); every Owner
demotion/removal remains subject to Last Owner protection.

Implementation:

- `apps/api/src/modules/organization/owner-transition.ts` — the SINGLE policy
  definition (`roleChangeTouchesOwner`, `assertOwnerChangeAuthority`);
- `organization.repo.ts changeMemberRole`/`removeMember` — inside the existing
  transaction that locks the active-owner set `FOR UPDATE`, any change that
  grants or removes Owner (including the Owner→Owner no-op) requires the
  ACTOR's membership to be **in the locked set**, so a concurrently demoted
  actor cannot still confer Owner;
- order of checks: target resolution (unknown/cross-tenant → uniform
  `MEMBER_NOT_FOUND` 404) → DG-2 authority (safe `FORBIDDEN` 403 — the same
  error every missing permission produces; no target state disclosed) →
  Last Owner (`LAST_OWNER_REQUIRED` 409, unchanged) → mutation + in-transaction
  audit event;
- the in-memory test repository applies the identical shared guard; the member
  service passes `actorMembershipId` through; no route-level or frontend rule
  is authoritative (the web demo already renders the backend's 403 and needed
  no change);
- disabled users are stopped at the auth boundary (401 — access-token
  resolution rejects non-active users); removed memberships fail
  `requireMembership` (uniform 404).

## 4. Quota race audit summary

Full map: [sprint-20-quota-race-audit.md](sprint-20-quota-race-audit.md).
Pre-change, quota checks for project/API-key/invitation creation ran in the
service OUTSIDE the write transaction, and the acceptance path locked only the
invitation row — so distinct tokens raced. The documented capacity model
(preserved, not redesigned): **member capacity is reserved at invitation
creation** (`active members + non-expired pending invitations < max_members`)
**and re-enforced at acceptance/completion against active members only**.
Membership creation paths were enumerated: invitation acceptance, registration
completion with invitation, and organization provisioning
(`insertOrganizationWithOwnerMembership` — founding member of a brand-new
organization, exempt by construction: no concurrent writer can target an
organization id that does not exist yet). No other production path inserts
memberships.

## 5. Atomicity strategy per quota

Primitives: `acquireOrganizationQuotaLock(tx, organizationId, kind)` in
`apps/api/src/modules/entitlements/quota-lock.ts` —
`pg_advisory_xact_lock(hashtextextended('quota:<kind>:<orgId>', 0))`,
transaction-scoped, one lock per (organization, kind) — paired with the
transaction-aware plan snapshot `lockOrganizationEntitlements(tx, orgId)` in
`entitlement.snapshot.ts`: plan assignment is RUNTIME-MUTABLE
(`PATCH …/plan/demo`), so the authoritative ceiling is read INSIDE the
protected transaction (plan row `FOR SHARE`, which blocks the plan
mutation's `FOR UPDATE` until commit while staying compatible with other
quota kinds' `FOR SHARE` reads). Repository mutation contracts carry NO
`max*` parameters, so a stale pre-transaction ceiling is structurally
impossible; the policy primitives (`evaluateCountQuota` / `requireQuota` /
`requireEntitlement`, unchanged `QUOTA_EXCEEDED` contract) and the
`entitlementsForPlan` catalog are shared. `EntitlementService` remains the
resolver for non-transactional consumers (reads, external-API checks,
advisory pre-checks).

| Quota | Path | Transaction body |
| --- | --- | --- |
| `max_projects` | `project.repo.createProject` | lock `projects` kind → plan snapshot (`FOR SHARE`) → count active (deleted excluded) → `requireQuota` → insert → `project.created` event |
| `api_keys_access` + `max_api_keys` | `api-key.repo.createApiKey` | lock `api_keys` kind → plan snapshot (`FOR SHARE`; ONE coherent read supplies gate AND ceiling) → `requireEntitlement` → count active (revoked/expired excluded, clock-supplied `now`) → `requireQuota` → insert (hash-only) → `api_key.created` event |
| `max_members` (reservation) | `invitation.repo.createInvitation` | lock `members` kind → plan snapshot (`FOR SHARE`) → count active members + non-expired pending invitations → `requireQuota` → lazy-expiry → insert → `invitation.created` event |
| `max_members` (consumption) | `invitation.acceptance.ts` (shared by existing-user accept AND registration completion) | non-locking pre-read resolves org id → lock `members` kind → plan snapshot (`FOR SHARE`) → `FOR UPDATE` invitation row → lifecycle/email/duplicate checks → count active members → `requireQuota` → membership insert → accepted mutation → both events |

Service-level pre-checks that remain are precisely scoped: they CAN reject a
request early (a caller may see their error) and they avoid unnecessary
external work, but they are NOT sufficient to authorize a successful
mutation — the in-transaction plan snapshot and quota/entitlement re-check
are the sole authoritative protection before anything persists. The three
remaining pre-checks: the api-key `requireApiKeysAccess` early rejection
(before a secret is even generated; preserves the permission → entitlement
error order), the invitation-create reservation pre-check that runs BEFORE
the fail-closed email (a lock must never be held across SMTP I/O — a request
that passes the pre-check, sends the email, and then loses the authoritative
in-transaction re-check has sent a courtesy email whose never-persisted
token resolves to `INVITATION_INVALID`; listed under Remaining Risks), and
`prepareForRegistration` at registration-request time. The completion port
(`resolveCompletionContext`) is now a pure EXISTENCE check — no plan value
crosses it. API-key secret generation stays
outside the transaction by design: a pure CSPRNG draw with no side effects;
on any failure the hash was never written and the raw value is discarded, so
no usable key can exist.

API-key guarantees preserved: one-time raw-secret disclosure, hash-only
storage, Sprint 19 create throttling, no key material in errors/logs/events.

## 6. Transaction-boundary summary

- Member role change / removal: one transaction — active-owner lock, target
  lock, DG-2 guard, Last Owner guard, mutation, audit event.
- Project / API key / invitation creation: one transaction — quota lock,
  plan snapshot, entitlement/quota guards, count, insert, success event. A
  failure aborts before any write; no orphan rows, no false success events.
- Invitation acceptance: one transaction (unchanged shape + the quota lock
  and plan snapshot); single-use, email-match, lifecycle, duplicate-membership
  behavior unchanged. The acceptance contract carries no plan values.
- Registration completion: one transaction (pending-row lock → user + personal
  workspace + session + refresh token → invitation savepoint → pending-row
  consumption). The savepoint-scoped invitation-unavailable policy is
  preserved: a quota loss rolls back ONLY the acceptance; the account commits
  and the response reports `unavailable`.
- Event writes: success events commit WITH their mutation (unchanged). The
  intentionally out-of-transaction events are unchanged by design:
  `registration_completion_succeeded` (post-commit; an event failure must not
  fabricate or destroy an account) and the anonymous request-path outcome
  events (enumeration-safe surface).
- No lock is held across external I/O (SMTP happens before any transaction).

## 7. Lock ordering and deadlock avoidance

Global order (every writer respects it):

1. `pending_registrations` row (`FOR UPDATE`) — completion path only;
2. ONE organization-quota advisory lock (`quota:<kind>:<org>`) per transaction;
3. `organization_plans` row (`FOR SHARE` — the in-transaction plan snapshot);
4. invitation rows (`FOR UPDATE` accepted row; lazy-expiry `UPDATE`s);
5. inserts (`memberships`/`projects`/`api_keys`/`invitations`) + in-transaction
   `security_events` writes.

Plan MUTATION (`changeOrganizationPlan`) takes ONLY the plan row
(`FOR UPDATE`) plus its same-transaction event write — no advisory or
invitation locks — so it enters the order at position 3 holding nothing, and
cannot form a cycle. Concurrent-plan-change semantics: a quota transaction's
`FOR SHARE` snapshot blocks an in-flight plan change until the quota
transaction commits (and vice versa: a snapshot read issued while a plan
change holds `FOR UPDATE` waits for its commit and then sees the NEW plan) —
proven behaviorally by the coordinated test in
`quota-plan-coherence.integration.test.ts`. Downgrade semantics are
documented product policy, separate from creation-time atomicity: ceilings
bind when capacity is consumed; a downgrade never revokes existing rows, so
an organization can sit over-quota until usage drops.

The acceptance body resolves the organization id with a NON-LOCKING pre-read
(org id is immutable on an invitation row) so the quota lock is acquired
before any invitation row lock — satisfying the quota-primitive-first
preference consistently across acceptance, completion, and creation. Cycles
are impossible because: no transaction holds two quota locks; the quota lock
always precedes the plan-row and invitation-row locks; only the completion
path locks pending registrations, and it does so before everything else;
inserts never lock pre-existing rows. Owner mutations lock membership rows
but take no quota or plan lock, so they cannot join a cross-kind cycle.
Unrelated organizations and unrelated quota kinds never contend on any lock
(different `FOR SHARE` holders on one plan row are compatible).

## 8. Concurrency-test design and evidence

`apps/api/src/modules/entitlements/quota-concurrency.integration.test.ts`
(real PostgreSQL; part of `pnpm validate:integration`):

| Race | Parallel attempts | Capacity | Expected / observed successes | Final-state assertions |
| --- | --- | --- | --- | --- |
| Project create | 6 | 1 (2 active + 1 soft-deleted decoy, limit 3) | 1 / 1 | 3 active projects; 1 `project.created` event; 5 × `QUOTA_EXCEEDED` |
| API key create | 6 | 1 (4 active + revoked & expired decoys, limit 5) | 1 / 1 | 5 active keys; 1 `api_key.created` event; 5 × `QUOTA_EXCEEDED` |
| Distinct-token invitation acceptance | 4 | 1 (2 members, limit 3) | 1 / 1 | 3 active members; exactly 1 invitation `accepted`, 3 still `pending`; 1 acceptance + 1 provenance event; 3 × `QUOTA_EXCEEDED` |
| Invited registration completion | 4 | 1 | 4 completions / 4 (accounts commit by policy); 1 membership / 1 | outcomes exactly `[accepted, unavailable ×3]`; 3 active members; every registrant has 1 user + 1 active personal workspace + 1 session; 0 unused pending rows; invitation ledger `1 accepted / 3 pending` |
| Invitation-create seat reservation | 6 | 1 | 1 / 1 | 1 pending invitation; 1 `invitation.created` event; 5 × `QUOTA_EXCEEDED` |

Design notes:

- **Genuine overlap is engineered, not assumed.** postgres.js opens pool
  connections lazily; discovered during execution: on a COLD pool the
  connection handshakes stagger the racers enough to serialize them by
  accident — a lock-free build still passed. The suite therefore warms one
  connection per attempt (`warmPool`: concurrent `pg_sleep` transactions each
  reserve a distinct connection) before firing the race.
- **Negative control (run during the sprint, not committed):** with the
  project quota lock removed and the pool warmed, ALL 6 attempts succeeded
  and the table held 8 active projects against a limit of 3, and the suite
  failed on the exact-success-count assertion — in repeated standalone probes
  the overrun reproduced 5/5 times. With the lock restored the suite passes.
  This is requirement §14.11: the tests fail meaningfully if the
  serialization is removed.
- No sleeps as a correctness mechanism, no ordering assumptions (which
  attempt wins is unasserted), deterministic cleanup (truncate per test),
  final DATABASE state asserted — not only the call results.

Plan/quota transactional coherence (the stale-limit regression suite,
`quota-plan-coherence.integration.test.ts` — 6 tests) proves the decision
uses the TRANSACTION-CURRENT plan: a committed plan DOWNGRADE is
authoritative for the very next create (rejects with the NEW limit in the
error details — the pre-refinement design would have admitted the row on the
stale higher ceiling); a committed UPGRADE immediately admits; a coordinated
IN-FLIGHT plan change (deferred-promise barrier, no sleeps: the change
signals once it HOLDS the plan row `FOR UPDATE`, then the create is fired)
proves the create's `FOR SHARE` snapshot WAITS for the plan commit and uses
the new plan; API-key creation rejects `ENTITLEMENT_REQUIRED` from one
coherent snapshot after a committed downgrade; acceptance of the SAME
invitation flips from `QUOTA_EXCEEDED` to accepted purely by a committed
plan change; and a missing plan row fails safe (`PLAN_STATE_MISSING`) inside
the transaction. Combined with the contract change (no `max*` parameters
exist to pass), a stale pre-transaction ceiling is impossible by
construction AND proven behaviorally.

DG-2 and schema invariants are additionally proven against live PostgreSQL in
`member.integration.test.ts` and `migrate.integration.test.ts` (§13).

## 9. Personal-workspace invariant

Two SEPARATE guarantees, stated precisely:

1. **Database uniqueness (new in Sprint 20):** at most ONE active personal
   workspace per user identity. Migration `0011_calm_gressill.sql` adds the
   partial unique index `uq_organizations_active_personal_owner` on
   `organizations (created_by_user_id) WHERE type = 'personal' AND status =
   'active'` (schema: `packages/db/src/schema/organizations.ts`).
   `created_by_user_id` is the stable identity for this invariant: it is
   written once at insert, no code path updates it, and no ownership-transfer
   feature exists (verified by inspection; any future transfer feature must
   revisit this index).
2. **Provisioning guarantee (application, pre-existing and tested):** the
   registration-completion transaction CREATES the personal workspace, so
   every completed user HAS one. Existence is provisioning logic, not a
   database constraint — the index alone cannot and does not promise it.

Team organizations are unconstrained; archived/suspended personal workspaces
free the slot (compatible with the inert lifecycle states); registration
completion (the only personal-workspace creation path) is unchanged and
transactional; seeds and demo data drive the real API and remain valid.
Evidence: SQL-level tests (duplicate-active rejected; team multi-org allowed;
archived-then-new allowed), the completion concurrency test (each completed
registrant ends with exactly one active personal workspace — the provisioning
guarantee under concurrency), and migrate-from-scratch.

**Migration safety (forward path):** `migrate.integration.test.ts` also
re-applies the EXACT committed 0011 statements over a POPULATED valid
pre-Sprint-20 dataset (users each owning one active personal workspace, team
organizations, existing org-scoped security events) and asserts the indexes
build and no rows are touched. Reviewer PREFLIGHT before applying 0011 to any
legacy database — the migration never deletes, archives, or merges data, so
any returned row is an explicit operational precondition to resolve first:

```sql
SELECT created_by_user_id, count(*) AS n
FROM organizations
WHERE type = 'personal' AND status = 'active'
GROUP BY created_by_user_id
HAVING count(*) > 1;
```

If this returns rows, `CREATE UNIQUE INDEX` in 0011 will fail (safely — it
mutates no data); resolve the duplicates deliberately before applying. No
application path can create a duplicate today (a brand-new user cannot
already own a personal workspace), so no new domain error mapping was
introduced; the constraint exists to stop FUTURE code paths and backfills.

## 10. Read-path permission consistency (ORG-PR-053)

- `GET /v1/organizations/:organizationId` (`organization.service.readOrganization`)
  now enforces `org.read` after membership resolution — code now matches the
  long-documented `api-surface.md` contract (drift resolved in the CODE
  direction). Every fixed role holds `org.read`, so there is no observable
  behavior change today; the gate exists so a future narrowing cannot
  silently mis-authorize. Cross-tenant/removed-membership behavior is the
  unchanged uniform 404; a role stripped of `org.read` fails closed with the
  safe 403 (proven by test).
- `GET …/permissions/effective` (`org-rbac.service.getEffectivePermissions`)
  is the ONE intentional membership-only surface, now documented as a stable
  contract: it returns the caller's OWN effective permissions, and gating
  self-introspection on a permission would be circular (a member whose role
  granted nothing could never learn that). Narrow, explicit, and tested.

## 11. Security-event index (ORG-PR-014)

`ix_security_events_org_created_id` on
`security_events (organization_id, created_at, id)` — matching the audit read
exactly (`WHERE organization_id = ? [AND filters] ORDER BY created_at DESC,
id DESC` with keyset pagination; `audit.repo.ts`). Existing indexes were
checked: only `user_id`, `event_type`, `created_at` single-column indexes
existed; nothing redundant was added. Tests assert the migration/index exists,
its `indexdef` columns and order, and — with `enable_seqscan = off` inside a
transaction, to stay stable on tiny fixtures — that the audit-shaped query is
answered through the index. Representative EXPLAIN (from the integration
environment):

```txt
Limit  (cost=0.13..5.90 rows=1 width=40)
  ->  Index Only Scan Backward using ix_security_events_org_created_id on security_events
        Index Cond: (organization_id = 'org_plan_probe'::text)
```

Planner CHOICE on large tables is a production property; the suite
deliberately does not assert it for small fixtures.

## 12. Retention readiness (ORG-PR-015 — no runtime added)

No scheduler, worker, or cleanup job was introduced (hard scope boundary; the
enabler is ORG-PR-016). Documentation is not enforcement; the finding stays
OPEN. The readiness map for the future cleanup work:

| Table | Growth | Lifecycle timestamps | Cleanup-supporting indexes today |
| --- | --- | --- | --- |
| `security_events` | unbounded (append-only) | `created_at` | `ix_security_events_created_at`; org-scoped deletes can ride `ix_security_events_org_created_id` (Sprint 20) |
| `sessions` | unbounded | `expires_at`, `revoked_at`, `created_at` | `ix_sessions_expires_at` |
| `refresh_tokens` | unbounded | `expires_at`, `used_at`, `revoked_at` | none on `expires_at` (add with the cleanup job; session-id index exists for cascade-style deletes) |
| `invitations` | unbounded (never hard-deleted) | `expires_at`, `accepted_at`, `revoked_at`, `updated_at` | org-scoped indexes; none on `expires_at` |
| `email_verification_tokens` | unbounded | `expires_at`, `used_at`, `invalidated_at` | user-id index; none on `expires_at` |
| `password_reset_tokens` | unbounded | `expires_at`, `used_at`, `invalidated_at` | user-id index; none on `expires_at` |
| `pending_registrations` | unbounded | `expires_at`, `used_at`, `invalidated_at` | `ix_pending_registrations_expires_at` (built for this purpose) |
| `api_keys` (expired/revoked) | slow-growing (never hard-deleted) | `expires_at`, `revoked_at` | partial org/active index |

Policy decisions still owed before enforcement: retention windows per event
class (`plans.audit_retention_days` is display-only), PII minimization for
event metadata (ORG-PR-043, legal review), and whether revoked credentials
are ever purged. What cannot be enforced without scheduled execution: ALL of
the above — batched deletes need an idempotent, locked, observable job
(ORG-PR-016 / the reliability track). No new tables were introduced this
sprint; no speculative retention fields were added.

## 13. Tests added or updated

Unit / route (offline tier — `pnpm validate`; suite now 820 unit + 78
web-demo tests):

- `owner-transition.test.ts` (new) — the shared DG-2 predicate/guard.
- `member.routes.test.ts` (+15) — full DG-2 matrix: Owner promotes
  Member/Admin to Owner; Owner demotes an Owner with another remaining; last
  Owner protected; Admin cannot self-promote, promote others, demote an Owner
  to admin/member/viewer, or remove an Owner; Admin keeps non-Owner
  transitions; Member/Viewer 403; removed membership 404; disabled user 401;
  cross-tenant grant 404 with no event and untouched rows.
- `organization.routes.test.ts` (+5) — `org.read` gate: admin/member/viewer
  allowed; a role stripped of `org.read` fails closed (403); disabled actor
  401 (existing tests keep cross-tenant/removed 404 and unauthenticated 401).
- `entitlement.service.test.ts` — the service-level create-quota tests were
  retired with their methods (`requireProjectCreationQuota`,
  `requireApiKeyCreationQuota`, then `getMaxProjects`/`getMaxMembers` in the
  refinement); the authoritative seam is covered by the integration suites
  below and the in-memory mirrors.
- In-memory repositories now enforce the same repo-level rules — including
  the store-resolved CURRENT plan (`resolveStoreEntitlements`, mirroring the
  transaction snapshot) for projects, API keys, invitation reservation, and
  the shared store acceptance — keeping every existing route-level quota and
  entitlement test meaningful.

Integration (live PostgreSQL — `pnpm validate:integration`):

- `quota-concurrency.integration.test.ts` (new) — the five races of §8
  (repositories now resolve their own ceilings from the seeded plan rows).
- `quota-plan-coherence.integration.test.ts` (new, refinement) — the six
  stale-limit regression tests of §8 (committed downgrade/upgrade, the
  coordinated in-flight plan change vs `FOR SHARE`, coherent API-key
  gate+ceiling, transaction-resolved acceptance ceiling, `PLAN_STATE_MISSING`
  fail-safe).
- `member.integration.test.ts` (+2) — DG-2 transactional proof (Admin cannot
  self-promote / demote / remove an Owner; rows untouched; zero role-change
  events) and Owner promotion + hand-off; the pre-existing concurrent
  Last-Owner demotion race unchanged.
- `migrate.integration.test.ts` (+3, index list extended) — personal-workspace
  partial unique invariant (duplicate rejected, team orgs allowed, archived
  frees the slot), forward application of the exact committed 0011 DDL over a
  populated pre-Sprint-20 dataset (preceded by the reviewer preflight
  duplicate query; data untouched), and the audit-read index (definition +
  EXPLAIN).

Regression: the full pre-existing suites pass unchanged — verification-first
registration, email verification, password recovery/reset/change, email
change, invitation inspect/accept, invited completion, project and API-key
flows, audit reads, web-demo build and tests, schema drift.

## 14. Validation evidence

All commands on 2026-07-21, at the final tree:

| Command | Result |
| --- | --- |
| `pnpm validate` | **exit 0** — typecheck (7 projects), ESLint, 817 unit tests (73 files), 78 web-demo tests, web build, schema-drift check ("migrations are in sync"), `git diff --check` |
| `pnpm validate:integration` | **exit 0** — db reset + migrate from scratch; db package 16/16 (incl. the 0011 forward-migration case); api package 82/82 across 15 files (incl. the 5 concurrency races and the 6 plan-coherence tests) |
| `git diff --check` | **exit 0** (no whitespace errors) |

Environment note: this machine's port 5432 is held by a foreign PostgreSQL,
so integration validation ran against the documented alternate-port throwaway
instance (`localhost:55432`, `orgistry_test`) with Redis on 6379 — the
runbook's port-conflict procedure. This is an environment workaround, not a
code accommodation; CI uses the standard ports.

Negative control (§8): with the project quota lock removed, the project race
fails (6/6 attempts succeeded, 8 > 3 active); restored before completion.

## 15. Documentation index (what changed and why)

| File | Technical truth updated |
| --- | --- |
| `docs/production-readiness/findings-register.md` | Resolutions for 014/017/029/038/044/053; 015 status note; summary rows |
| `docs/production-readiness/README.md` | Sprint 20 status block; navigation rows |
| `docs/production-readiness/production-scorecard.md` | Authorization/tenant-isolation/data-integrity/testing rows |
| `docs/production-readiness/production-roadmap.md` | Authorization sprint marked done (executed as Sprint 20); supply-chain sprint renumbered next (21) |
| `docs/production-readiness/launch-checklist.md` | LC-2.6 advanced (index half), LC-2.7/LC-2.8 done |
| `docs/production-readiness/security-assessment.md` | Authorization + concurrency + database gap sections resolved/updated |
| `docs/production-readiness/threat-model.md` | T-PRIV/T-BOLA/T-QUOTA mitigations + residual-risk list |
| `docs/production-readiness/product-gap-analysis.md` | Personal workspace, roles, permissions, projects, quotas, audit rows |
| `docs/production-readiness/repository-inventory.md` | Module/route/table maturity notes for the closed findings |
| `docs/production-readiness/sprint-20-quota-race-audit.md` | NEW — per-path race map, primitive + in-transaction plan snapshot, lock order incl. the plan row, downgrade semantics |
| `docs/production-readiness/sprint-20-artifact-package.md` | NEW — this package |
| `docs/rbac-permissions.md` | DG-2 section, sanctioned role-identity checks, Owner-transition contract |
| `docs/security-model.md` | DG-2 policy, permission-gated reads + documented exception, serialized quotas, known-limitations line |
| `docs/entitlements-plans-quotas.md` | Enforcement point moved in-transaction; extension guidance; reversed rejected-alternative recorded honestly |
| `docs/projects.md` | Create quota now atomic in-transaction |
| `docs/api-keys-external-api.md` | Create flow diagram + active-count atomicity |
| `docs/invitations.md` | Reservation + acceptance serialization; the accepted courtesy-email residual |
| `docs/audit-log.md` | The new backing index; filter guidance |
| `docs/api-surface.md` | Org read `org.read` note; effective-permissions exception; member-role/removal DG-2; project/api-key/accept quota atomicity |
| `docs/organization-foundation.md` | Invariants 1 (DB-enforced) and 4 (`org.read`) |
| `docs/architecture.md` | Entitlements/quota model — in-transaction serialization |
| `docs/known-limitations.md` | Quota race window closed; residual documented |
| `docs/validation.md` | What integration validation now proves (Sprint 20 races + schema invariants) |
| `docs/evaluation-guide.md` | Test counts (820/78) |
| `README.md` | Sprint 20 status sentence |

## 16. Scope-control confirmation

No deployment automation, Dockerfiles, IaC, staging, reverse proxy, TLS,
secrets manager, secret/JWT rotation, backup/PITR, external SMTP validation,
bounce processing, observability platforms, incident-response programs,
schedulers or background workers, retention jobs, account deletion/export,
supply-chain scanning, CI pinning, dependency upgrades, browser E2E, MFA,
passkeys, OAuth/SAML/SCIM, custom roles, resource-level permissions, ABAC,
or billing work was introduced. ORG-PR-001/002/005/006 were not touched. The
frontend is unchanged (it already renders the backend's safe errors and holds
no authority). The one new mechanism (the quota advisory lock) reuses the
Sprint 18 advisory-lock construction rather than introducing new
infrastructure.

## 17. Sprint changelog (iteration history)

1. **Inspection** mapped every quota path, member-creation path, the DG-2
   surfaces, the ORG-PR-053 routes, and the audit read query; produced the
   quota-race audit note before any quota code changed.
2. **Design selections:** transaction-scoped advisory locks per (org, quota
   kind) over plan-row locking (avoids cross-kind serialization and demo
   plan-change contention) and over counter rows (no drift-prone state);
   DG-2 authority derived from the ALREADY-LOCKED active-owner set rather
   than the service-resolved role (transaction-time truth); quota-lock-first
   ordering via a non-locking org-id pre-read in the acceptance body.
3. **Policy-layer revision recorded honestly:** the pre-Sprint-20 rationale
   "never enforce quota in a repository" was reversed for the enforcement
   point only; limits are still resolved exclusively by the entitlement
   service and passed in.
4. **Issue found during execution — cold-pool false confidence:** the first
   negative control (lock removed) still passed. Root cause: postgres.js
   lazy connection creation staggered the "concurrent" transactions into
   accidental serial execution. Fix: `warmPool` reserves one live connection
   per attempt before racing. After the fix the lock-free build overran the
   ceiling in 5/5 standalone probes and the suite failed deterministically —
   restoring real force to §14.11.
5. **Tooling slip, corrected:** a `git checkout` used to undo the
   negative-control patch also reverted the sprint's project-repo changes;
   they were re-applied and re-verified (the final diff and green suites are
   the evidence of record).
6. **Final evidence:** `pnpm validate` and `pnpm validate:integration` exit 0;
   negative control re-run and restored; docs synchronized in the same
   execution.
7. **Correctness refinement (same day) — stale-plan window closed:** the
   first implementation resolved plan ceilings in the SERVICE
   (`getMaxProjects` / `resolveApiKeyEntitlements` / `getMaxMembers`) and
   passed them into the protected transactions — but plan assignment is
   runtime-mutable, so a plan change committing between resolution and the
   transaction could make the enforced ceiling stale (a check outside the
   transaction that writes). Fix: the transaction-aware snapshot
   `lockOrganizationEntitlements` (plan row `FOR SHARE`, after the quota
   lock) now supplies the ceiling — and for API keys the access gate — from
   inside each protected transaction; every `max*` parameter was REMOVED
   from the repository mutation contracts (`CreateProjectParams`,
   `CreateApiKeyParams`, `CreateInvitationParams`, `AcceptInvitationParams`,
   `CompletionInvitationContext`), the now-unused `getMaxProjects` /
   `getMaxMembers` were deleted, the project service dropped its
   entitlement-service dependency entirely, and the registration completion
   port became a pure existence check. Proven by
   `quota-plan-coherence.integration.test.ts` (incl. the coordinated
   in-flight plan-change serialization test) with the original warmed-pool
   races unchanged and green. The same pass tightened the ORG-PR-038 wording
   (DB enforces AT MOST one active personal workspace; the tested
   provisioning transaction supplies existence) and added the 0011
   forward-migration + preflight evidence.

Remaining limitations are in §12 (retention) and §19.

## 18. Confidence assessment

Evidence-based, per dimension — with the limits stated:

| Dimension | Confidence | Basis | Honest limit |
| --- | --- | --- | --- |
| Authorization policy correctness (DG-2) | High | Single shared guard enforced inside the transaction against the LOCKED active-owner set; 15-case route matrix + live-PostgreSQL suite (Admin self/other promotion, demote/remove Owner, removed membership, disabled user, cross-tenant) all green; Last Owner distinct and unchanged | Policy coverage is for the four fixed system roles; a future custom-roles feature must revisit the guard |
| Quota-race resistance | High | Five warmed-pool races (4–6 genuinely parallel attempts, capacity 1) assert exact success counts, final DB state, and event/mutation correspondence; a lock-removed build failed deterministically (negative control, 6/6 overrun) | Evidence is controlled contention on one host, not production load; overlap depends on the warm-pool harness remaining in place |
| Plan-change coherence | High | Repository contracts accept no ceilings (structural); six behavioral tests incl. the coordinated in-flight plan change proving `FOR SHARE` waits for the mutation's `FOR UPDATE` commit | The FOR SHARE discipline binds only code paths using `lockOrganizationEntitlements`; raw scripts could bypass it (Remaining Risks) |
| Migration safety (0011) | High | From-scratch, idempotency, and a populated forward-application case executing the exact committed DDL over pre-Sprint-20-shaped data with rows untouched; reviewer preflight query documented and exercised | The populated dataset is representative, not a copy of any real deployment; duplicate legacy data remains an explicit operational precondition |
| Tenant isolation | High | Unchanged mechanisms plus regression suites; cross-tenant probes verified to keep the uniform 404 through the new DG-2/quota paths | No new isolation mechanism was added this sprint — confidence inherits from the existing test base |
| Regression safety | High | Full offline suite (817 unit + 78 web) and integration suite (16 db + 82 api) green at the final tree; all Sprint 16–19 suites unmodified except for contract-signature updates | One historical flaky web test exists in the repo (documented pre-Sprint-20); a single unrelated unit flake was observed mid-sprint and passed on every re-run |
| Test realism | Medium–High | Real PostgreSQL, real pool connections, deterministic barriers (deferred promises, warm pool), no sleeps as correctness mechanisms, final DB state asserted | Concurrency scale is single-digit parallelism; no failure-injection (DB/Redis mid-transaction kill) — that is ORG-PR-026, out of scope |

## 19. Remaining risks and P1 blockers

P1 blockers (all pre-existing, none in Sprint 20 scope, all still visible):

```txt
ORG-PR-001 — No production deployment automation
ORG-PR-002 — External production email delivery unvalidated
ORG-PR-005 — No backups / PITR / restore drill
ORG-PR-006 — No secrets management
```

Residual Sprint 20 risks, stated honestly:

- the invitation-create courtesy-email residual (email sent, quota lost —
  link safely invalid); accepted to keep SMTP outside locks;
- advisory-lock + plan-snapshot serialization holds only while all writers go
  through the repositories — raw SQL backfills must take the same locks and
  read the plan row the same way (documented in `quota-lock.ts`,
  `entitlement.snapshot.ts`, and the race-audit note);
- the concurrency suites prove capacity-1 contention with 4–6 racers; they
  are not a load test (out of scope with the rest of performance work);
- ORG-PR-015 retention remains open — unbounded tables keep growing until a
  cleanup runtime exists (ORG-PR-016).

## 20. Final readiness classification

```txt
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Unchanged. Sprint completion is not launch clearance; the four P1 blockers
above gate any staging claim.

## 21. Readiness for next sprint

The final closing review found no contradiction, failing test, security
defect, or false documentation statement; the authorization-and-concurrency
group (ORG-PR-017/029/038/044/053/014) is fully closed and Sprint 20 is
FROZEN as complete, with this package as the official sprint record. The
roadmap's next step stands:

```txt
Sprint 21 — Supply Chain and CI Hardening
```

(SHA-pinned actions + workflow `permissions`, dependency/vuln/secret
scanning, triage of the `drizzle-orm`/`esbuild` advisories, image pinning —
ORG-PR-018/019/020/042/054, plus `noUncheckedIndexedAccess` if scheduled.)
