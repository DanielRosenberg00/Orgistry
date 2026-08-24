# Data Retention and Cleanup

The lifecycle policy for growth-sensitive Orgistry tables, the runnable cleanup
that enforces it, and the safety boundaries that keep it from touching live
state.

Companion documents: [backup-and-restore.md](backup-and-restore.md),
[audit-log.md](audit-log.md), [session-lifecycle.md](session-lifecycle.md),
[credential-management.md](credential-management.md).

Finding: [ORG-PR-015](production-readiness/findings-register.md#org-pr-015).

---

## 1. What exists

| Piece | Where |
| --- | --- |
| Policy catalog (one definition per category) | `apps/api/src/maintenance/retention-policy.ts` |
| Executor (dry-run / apply, batching, failure isolation) | `apps/api/src/maintenance/retention.ts` |
| Argument surface and report | `apps/api/src/maintenance/retention-cli.ts` |
| Command entry point | `apps/api/src/maintenance/retention-command.ts` |
| Typed configuration | `packages/config/src/schema.ts`, `packages/config/src/index.ts` |
| Supporting indexes | `packages/db/src/schema/auth.ts`, migration `0012` (four, additive, index-only) |
| Tests | `retention-cli.test.ts`, `retention-policy.test.ts`, `retention.integration.test.ts` (live PostgreSQL) |

```bash
pnpm db:retention -- --dry-run                    # report; deletes nothing (default)
pnpm db:retention -- --apply                      # delete eligible rows
pnpm db:retention -- --apply --category=security_events --batch-size=500
node dist/retention.mjs --apply                   # from the deployable artifact
```

---

## 2. Schema analysis

Every table in the schema was examined for unbounded growth. The three
outcomes:

### Covered — growth-sensitive with a safe age predicate

| Table | Growth driver | Retention column | Active rows in the same table? | Deletion safety boundary |
| --- | --- | --- | --- | --- |
| `security_events` | One row per authentication, authorization, and audited mutation event. The highest-volume table in the platform. | `created_at` | No lifecycle state — every row is historical the moment it is written. | Age only. The window is long because this is the audit trail. |
| `refresh_tokens` | One row per refresh rotation; a long-lived session accumulates a whole family. | `expires_at` | Yes — an unexpired token is a live credential. | `expires_at < cutoff`. An expired refresh token is refused by the session lifecycle, so an eligible row cannot authenticate anything. |
| `sessions` | One row per login. Logout marks `revoked_at`; it never deletes. | `expires_at` | Yes — an unexpired session may be active. | `expires_at < cutoff`. An expired session cannot be refreshed or reused. Its `refresh_tokens` children are removed in the same transaction (foreign key `refresh_tokens.session_id`). |
| `email_verification_tokens` | One row per verification request/resend. | `expires_at` | Yes — the current usable token. | `expires_at < cutoff`. A token is usable only while `used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`, so anything past expiry is already dead. |
| `password_reset_tokens` | One row per password-recovery request. | `expires_at` | Yes. | Same as verification tokens. Short TTL (1 h default) means these age out quickly. |
| `pending_registrations` | One row per public registration request, including every request never completed — the most attacker-influenceable of the token tables. | `expires_at` | Yes — the one usable generation per normalized email. | `expires_at < cutoff`. The partial unique index `uq_pending_registrations_usable_email` covers unused rows only, so deleting expired rows cannot disturb it. |

### Deliberately not covered — durable by schema contract

| Table | Why | Evidence |
| --- | --- | --- |
| `invitations` | An invitation is a durable lifecycle record. Accepted and revoked rows are the audit trail of who was invited to an organization and by whom; expiry is *derived* at read time, so there is no "expired invitation" row to reclaim. | `packages/db/src/schema/invitations.ts`: "Rows are NEVER hard-deleted". |
| `api_keys` | Revoked, never hard-deleted. The revoked row is what proves a key existed and when it was withdrawn. | `packages/db/src/schema/api-keys.ts`. |
| `users`, `organizations`, `memberships`, `projects` | Account and tenant state, soft-deleted at most. Deleting an account is a product feature with its own consent, export, and cascade semantics (**ORG-PR-043**, open) — not something a maintenance sweep may do. | Schema `deleted_at` / `status` columns. |
| `roles`, `permissions`, `role_permissions`, `plans` | Migration-seeded reference data with no growth. | Migrations `0002`, `0003`, `0005`. |
| `app_meta` | Bounded key/value infrastructure metadata. | `packages/db/src/schema/meta.ts`. |

### Categories from the retention checklist that do not exist here

Documented rather than invented — no infrastructure was created for a concept
the repository does not have:

- **No separate audit table.** The audit read path (Sprint 20) reads
  `security_events`. Audit retention *is* the `security_events` category.
- **No persistent idempotency store.** No idempotency-key table exists;
  idempotency is handled by database constraints (e.g.
  `uq_invitations_org_email_pending`), not by stored request keys.
- **No persistent email-event store.** The account mailer delivers
  synchronously and stores nothing (`apps/api/src/modules/mail/`); there is no
  outbox, retry queue, or delivery-event table.
- **No job/queue tables.** There is no background runtime (**ORG-PR-016**,
  open).

---

## 3. Retention policy matrix

| Category | Table | Retention column | Default | Minimum enforced | Deletion predicate | Supporting index | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `security_events` | `security_events` | `created_at` | 180 days | 30 days | `created_at < now() - window` | `ix_security_events_created_at` | Orgistry engineering default |
| `expired_refresh_tokens` | `refresh_tokens` | `expires_at` | 90 days | 7 days | `expires_at < now() - window` | `ix_refresh_tokens_expires_at` (added in migration `0012`) | Orgistry engineering default |
| `expired_sessions` | `sessions` | `expires_at` | 90 days | 7 days | `expires_at < now() - window` **AND no retained referrer** (see §3.1) | `ix_sessions_expires_at` (+ `ix_refresh_tokens_session_id`, `ix_security_events_session_id`) | Orgistry engineering default |
| `expired_email_verification_tokens` | `email_verification_tokens` | `expires_at` | 30 days | 1 day | `expires_at < now() - window` | `ix_email_verification_tokens_expires_at` (migration `0012`) | Orgistry engineering default |
| `expired_password_reset_tokens` | `password_reset_tokens` | `expires_at` | 30 days | 1 day | `expires_at < now() - window` | `ix_password_reset_tokens_expires_at` (migration `0012`) | Orgistry engineering default |
| `expired_pending_registrations` | `pending_registrations` | `expires_at` | 30 days | 1 day | `expires_at < now() - window` | `ix_pending_registrations_expires_at` | Orgistry engineering default |

Common to every category:

| Property | Behavior |
| --- | --- |
| Cleanup owner / entrypoint | `pnpm db:retention` (source) or `node dist/retention.mjs` (artifact). No scheduler. |
| Dry-run behavior | Counts eligible rows. Executes no statement that can mutate. |
| Batch behavior | `RETENTION_CLEANUP_BATCH_SIZE` rows per statement, one batch per transaction, oldest rows first, until a short batch or the `--max-batches` cap. |
| Audit/security-event behavior | The cleanup writes **no** `security_events` rows. It is an operator action outside any request context with no actor, tenant, or request id to attribute; the run's evidence is its printed summary and the operator's own job logs. |
| Rerun / idempotency | Safe and expected. A second run over the same window deletes nothing. A capped run is resumed by simply running the command again. |

### 3.1 Referential integrity is never traded for storage

`sessions` is the only retention target with **inbound** foreign keys, and it
has two:

```
refresh_tokens.session_id  -> sessions.id
security_events.session_id -> sessions.id
```

Neither has `ON DELETE CASCADE`. That is deliberate: nothing may delete session
or audit history implicitly. So the ended-session category carries one extra
clause — **a session is deleted only when every row that references it is
itself past its own retention cutoff:**

```sql
DELETE FROM sessions s
 WHERE s.expires_at < $session_cutoff
   AND NOT EXISTS (SELECT 1 FROM refresh_tokens rt
                    WHERE rt.session_id = s.id AND rt.expires_at >= $session_cutoff)
   AND NOT EXISTS (SELECT 1 FROM security_events se
                    WHERE se.session_id = s.id AND se.created_at >= $security_event_cutoff)
```

Each clause uses **that referrer's own cutoff**, so the predicate stays correct
if the windows are configured independently. Two consequences, both intended:

**A refresh token is only ever deleted by its own predicate.** Refresh-token
lifetimes are *not* capped by the session — `auth.service.ts — refresh` mints a
successor at `now + refreshTokenTtl` — so a token rotated shortly before a
session ends outlives it, and the session becomes retention-eligible before the
token does. Holding the session back makes the active-token guarantee
**structural**: it does not depend on the (true, but remote) fact that
`auth.repo.ts — rotateRefreshToken` rejects a token whose session has expired
*before* it looks at the token's own expiry. Nothing outside
`retention-policy.ts` has to be read to trust the guarantee.

**Sessions are effectively retained until their security events age out.**
Security events are retained far longer than sessions (180 d vs 90 d by
default), and a normal login writes an event carrying that `session_id`. So in
a real database most expired sessions *are* still referenced by a retained
event, and the ended-session sweep reclaims little until the event window
passes. This is stated plainly rather than hidden behind a nominal 90-day
number. The alternatives were both rejected: cascading the delete, or nulling
`security_events.session_id`, would each destroy audit fidelity to reclaim a
session row.

Without this clause the category does not merely over-delete — it **fails**,
with SQLSTATE `23503`, on essentially every run against a real database. That
is how the `security_events` reference was found (see the Sprint 25 artifact
package, §13).

A held-back session is picked up by a later run automatically. The hold-back is
expressed in the `SELECT`, not by skipping rows afterwards, so a blocked
session never consumes a batch slot and never triggers early termination.

### Two policy notes worth reading before changing a value

**These are engineering defaults, not legal requirements.** No regulatory
retention obligation is asserted anywhere in this repository. A deployment
subject to one must set these values from that obligation — and note that
retention interacts with the open privacy findings: `security_events` metadata
can contain normalized email addresses (**ORG-PR-052**), and account deletion /
data export do not exist (**ORG-PR-043**). Cleanup bounds growth; it is not a
privacy-erasure mechanism.

**`audit_retention_days` is modeled metadata, not a behavioral contract — and
Sprint 25 did not change that.** This is worth stating precisely, because a
reader could reasonably assume a "retention" entitlement implies enforced
per-plan deletion. It does not, and never has. The repository says so in three
independent places, all predating Sprint 25:

- `packages/contracts/src/plans.ts` — the entitlement-key catalog classifies it
  as a *"Modeled policy value — `audit_retention_days` (returned, not enforced
  by a deletion job in this sprint)"*;
- `packages/contracts/src/plans.ts` — `entitlementValuesSchema`:
  *"`audit_retention_days` is a modeled policy value only — Sprint 7 returns it
  but does not run a retention/deletion job"*;
- `apps/api/src/modules/entitlements/entitlement.service.ts` —
  `AuditEntitlements.retentionDays`: *"Modeled retention window in days (not
  enforced by a deletion job in v1)"*.

`docs/audit-log.md` carries the same statement on the read surface. No route,
service, or query anywhere reads the value to decide what a caller may see or
what data is removed; it is returned in the audit page's `meta` and in the
plan/entitlements DTOs, and nothing else.

Sprint 25 therefore establishes **repository-level lifecycle cleanup** — a
global, platform-wide window — and leaves the pre-existing non-enforced
entitlement semantics exactly as they were. It neither honours nor breaks a
promise, because there was no behavioral promise to honour. This is why the
global window does not invalidate the closure of ORG-PR-015: that finding asked
for retention/cleanup on unbounded tables, which now exists and is tested.
Per-plan enforcement is a *separate, unclaimed* capability and remains a known
limitation.

The one interaction that does matter is presentational: the seeded catalog
advertises at most 90 days (Free 0, Pro 30, Business 90; migration `0005`), so
the 180-day default cannot delete history a plan displays as retained. If an
operator lowers `RETENTION_SECURITY_EVENT_DAYS` below 90, the displayed value
and the real one diverge and must be reconciled deliberately. `config.test.ts`
pins the default above the largest plan value so the relationship cannot drift
silently.

---

## 4. Configuration

Four typed values, validated in `packages/config/src/schema.ts` and surfaced as
`config.retention`:

| Variable | Default | Floor | Governs |
| --- | --- | --- | --- |
| `RETENTION_SECURITY_EVENT_DAYS` | 180 | 30 | `security_events` |
| `RETENTION_EXPIRED_AUTH_TOKEN_DAYS` | 30 | 1 | verification, reset, and pending-registration rows |
| `RETENTION_ENDED_SESSION_DAYS` | 90 | 7 | sessions and refresh tokens |
| `RETENTION_CLEANUP_BATCH_SIZE` | 1000 | 1 (max 50000) | rows per batch |

**Why floors instead of `positive()`.** A window of `0` would make
`cutoff = now`, putting live rows in scope. A negative window would push the
cutoff into the *future* and make **every** row eligible. Both are rejected at
config load, so a typo or an unset variable coerced to zero fails process start
instead of silently authorizing a destructive sweep. `config.test.ts` pins each
of those rejections.

**There is no disable switch, and that is the safe design.** Cleanup runs only
when an operator invokes the command — there is no scheduler, no boot hook, and
no request-path caller. "Disabled" is the default state of the system. Adding a
`RETENTION_ENABLED` flag would create dead configuration and a second way to be
wrong about whether deletion can happen.

**Testing with short windows.** The floors intentionally prevent sub-floor
production windows. The integration suite does not need them: it inserts rows
with explicit ages (400 days old, 90 days expired) against a fixed reference
instant, so every boundary is exercised deterministically without a sleep and
without weakening a production guard.

---

## 5. The cleanup command

### Operator ergonomics

```
Usage: orgistry-retention [options]

  --dry-run              Report eligible rows and delete nothing (default).
  --apply                Delete eligible rows. Required for any mutation.
  --category=<name>      Limit the run to one category. Repeatable.
  --batch-size=<n>       Rows per batch (1-50000).
  --max-batches=<n>      Batches per category before stopping (default 1000).
  --json                 Emit the summary as one JSON object.
  --help
```

**Contract — deletion requires `--apply`.** The default mode is `dry-run`. No
other flag combination reaches apply mode, and `retention-cli.test.ts` asserts
that over the whole flag space. A forgotten flag, a truncated command line, or
a copied command missing its tail can only ever produce a report.

Every malformed input is rejected rather than absorbed: an unknown category, a
non-numeric or out-of-range batch size, `--apply --dry-run` together, and an
unknown argument all exit `2` with the usage text. A silently ignored `--aply`
typo would run the opposite mode from the one the operator believed they asked
for.

### Output

```
retention cleanup: mode=apply batch_size=1000 started_at=2026-08-24T06:24:09.281Z
  applied security_events table=security_events retention_days=180 cutoff=2026-02-25T06:24:09.280Z deleted=412 batches=1
  applied expired_sessions table=sessions retention_days=90 cutoff=2026-05-26T06:24:09.280Z deleted=0 batches=1
retention cleanup: deleted=412 failed_categories=0 duration_ms=91
```

**Contract — counts only.** The summary carries category names, table names,
column names, day counts, ISO cutoffs, and integers. Nothing else is reachable
from it: the executor never selects a row payload, and the formatter has no
access to one. `retention.integration.test.ts` asserts that a serialized
summary contains no seeded email address, token hash, user id, or password-hash
marker.

Failure descriptions are narrowed twice for the same reason: PostgreSQL puts
offending column *values* in a constraint error's `detail`/`hint`, so only
`message` and the SQLSTATE `code` are carried; and Drizzle appends a
`params:` block to its `Failed query` message, so the message is truncated at
the first newline.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected category completed. |
| `1` | At least one category failed, or the run could not start (bad configuration, unreachable database). |
| `2` | Invalid arguments. Nothing was executed. |

A category that throws is recorded as failed and the run continues with the
next one — one broken category must not prevent the others from reclaiming
space — and the process still exits non-zero.

### Configuration source

The command loads configuration through exactly the same path as the API
process: `loadWorkspaceEnv()` then `getConfig()`, which resolves `<NAME>_FILE`
mounted secrets ([runtime-secrets.md](runtime-secrets.md)) and applies every
production guard. A misconfigured environment fails here for the same reason it
would fail at API boot.

*Consequence, stated plainly:* under `NODE_ENV=production` the command requires
the API's full production-valid environment, including mail settings it never
uses. That is deliberate. *Rejected alternative:* a minimal environment reader
for the maintenance command (as `packages/db/src/env.ts` does for migrations).
It would be more convenient and would create a second configuration path — one
where a production process could boot with values no guard had validated. Run
the command as a one-shot job with the same environment and secret mounts as
the API deployment.

---

## 6. Transaction and batching safety

**One batch is one transaction.** The executor loops:

```
while batches < maxBatchesPerCategory:
    deleted = transaction( deleteBatch(cutoff, batchSize) )
    if deleted < batchSize: done          # the predicate has nothing left
```

A sweep therefore never holds a long destructive lock, and an interrupted run
leaves whole batches committed rather than a half-deleted category. Reaching
the cap marks the category `truncated=true` and the summary says
`(rerun to continue)`.

**The bounded-delete SQL, and why it is safe.** PostgreSQL has no
`DELETE ... LIMIT`, so the rows are chosen by a bounded `SELECT` and deleted by
primary key:

```sql
DELETE FROM <table>
 WHERE id IN (SELECT id FROM <table>
               WHERE <retention column> < $cutoff
               ORDER BY <retention column>
               LIMIT $batch)
RETURNING id
```

- `ORDER BY <retention column>` makes each batch the **oldest** eligible rows,
  which keeps repeated runs monotonic and lets the planner walk the supporting
  index.
- The subselect is evaluated once, inside the batch's transaction, so a
  concurrent insert cannot widen the batch.
- `RETURNING id` is how the deleted count is obtained — it is a real count, not
  an estimate.
- Five of the six categories share this statement through one factory; only
  `expired_sessions` differs, because it must clear its `refresh_tokens`
  children in the same transaction.

**Why `sql` templates rather than the Drizzle query builder in the factory.**
`.from()` cannot be applied to a table held in a generic type parameter, so a
shared factory has to use the template form. Nothing is string-concatenated:
the table and columns are interpolated as schema *objects* (Drizzle emits their
quoted identifiers) and the cutoff and batch size are bound parameters. The
statements are exactly as injection-safe as the builder.

**Category ordering matters exactly once.** `expired_refresh_tokens` runs before
`expired_sessions`, so the bulk of the child rows are gone before the parent
sweep needs them. `retention-policy.test.ts` pins that order, and the session
sweep still clears its own children unconditionally so `--category=expired_sessions`
is correct on its own.

---

## 7. Invariants

Stable guarantees a reviewer should be able to rely on without re-reading every
predicate:

1. **Age, never state.** Every predicate is `<timestamp column> < cutoff`. No
   category infers eligibility from a status string, a nullable lifecycle
   marker, or a join.
2. **Expired means unusable.** For the token and session categories the column
   is `expires_at`, and the platform already refuses every expired token and
   session at use time. An eligible row is dead state by the schema's own
   rules.
3. **Strictly `<`.** A row exactly at the cutoff is retained. Pinned by an
   integration test that seeds one row at the cutoff and one row one
   millisecond older.
4. **Active-row preservation.** No category can reach an active session, an
   unexpired token, a pending invitation, an unrevoked API key, a membership,
   or an account. Proven both structurally (the catalog's table list is
   asserted against a durable-table denylist) and behaviorally (paired
   expired/active fixtures).
5. **Referential integrity is never traded for storage.** A row is deleted only
   by its own predicate. A parent whose referrers are still retained waits
   (§3.1); no cascade, no null-out, no cross-table collateral deletion.
6. **Dry-run mutates nothing.** No statement executed in dry-run mode can
   write.
7. **Bounded deletion.** One statement can never delete more than the batch
   size; one category can never exceed `--max-batches` batches.
8. **Idempotent.** Repeated execution is safe and converges.
9. **Counts only.** No row content reaches any output stream.

---

## 8. Test evidence

`retention.integration.test.ts` runs against real PostgreSQL because every
property under test is relational or temporal. Twenty-one cases:

- dry-run counts eligible rows and mutates nothing (row counts unchanged
  afterwards); every category reports zero batches and zero deletions;
- apply deletes the expired half of five paired expired/active fixtures
  (sessions, security events, verification tokens, reset tokens, pending
  registrations — six rows in total, since the expired session's refresh token
  goes with it) and preserves the active half, including the user account
  itself;
- the boundary case — a row at the cutoff survives, a row one millisecond older
  does not;
- a second apply deletes nothing (idempotency) and exits zero;
- batch size and the batch cap are honoured exactly: 7 rows, `--batch-size=2
  --max-batches=2` deletes 4 and reports `truncated`; a rerun finishes the
  remaining 3 and reports clean;
- batches take the oldest rows first;
- `--category` touches only its own table;
- the session sweep clears its refresh tokens even when run alone;
- a refresh token whose own expiry is still inside the window survives even
  though other rows are swept;
- an unreachable database fails every category, deletes nothing, and yields
  exit code 1;
- a serialized summary contains no email address, token hash, user id, or
  password-hash marker;
- every category's `supportingIndex` exists in `pg_indexes`;
- a full apply run's result set touches only the catalog's tables — never
  `invitations` or `api_keys`;
- an eligible session whose refresh token is **not** independently eligible is
  held back — neither row is deleted, and dry-run agrees with apply;
- the same session is released on a later run once that token ages out;
- an eligible session still referenced by a **retained security event** is held
  back, with no failed category (the `23503` regression guard);
- the same session is released once the referencing event ages out;
- a held-back session does not block other eligible sessions in a batch (the
  filtering happens in the `SELECT`, so no batch slot is consumed);
- every index the predicates depend on exists, including the two session
  referrer indexes;
- the complete set of inbound foreign keys on retention targets matches the
  reviewed list — a new referencing table fails this test instead of failing a
  production sweep.

Plus unit coverage: `retention-cli.test.ts` (17 cases — flag safety, rejection
of dangerous values, report format) and `retention-policy.test.ts` (9 cases —
catalog invariants, durable-table exclusion, cutoff arithmetic, and the
sessions/refresh-tokens shared-window assumption §3.1 relies on), and the
retention block in `packages/config/src/config.test.ts` (7 cases — defaults,
floors, zero/negative rejection, batch bounds). **54 retention tests in total.**

The `--with-artifact` restore drill additionally runs the **packaged** command
against a freshly restored database and asserts that a dry-run reports no
mutation, an apply deletes nothing (no row has aged out), and every seeded
entity is still present afterwards.

---

## 9. Known limitations

- **No scheduler.** The cleanup is a one-shot command. Running it periodically
  is a deployment responsibility — a platform scheduled job, a cron container,
  or a managed task — and none exists here (**ORG-PR-016**, open). This is the
  documented residual on ORG-PR-015: enforcement is real, tested, and runnable;
  automation is not.
- **No metrics or alerting.** The summary goes to stdout. There is no metric
  emission and no failure alert (monitoring is out of scope).
- **No locking between concurrent runs.** Two simultaneous runs are safe —
  batches are transactional and the predicate is idempotent, so the worst case
  is wasted work — but nothing prevents them. A scheduled deployment should use
  its scheduler's own concurrency control.
- **Per-plan `audit_retention_days` is still not enforced.** Retention is
  global, not per organization. See §3.
- **Retention is not erasure.** Cleanup bounds growth. It does not implement
  account deletion, data export, or PII minimization (**ORG-PR-043**,
  **ORG-PR-052**, open).

---

## 10. Runbooks

### Run a retention dry-run

```bash
pnpm db:retention -- --dry-run                      # source mode
node dist/retention.mjs --dry-run                   # deployable artifact
```

Read the `eligible=` count per category. This is the number apply would delete
on this run. Always do this first on a database you have not swept before.

### Run a retention apply

```bash
# 1. Take a labelled backup first. Cleanup is irreversible.
pnpm db:backup -- --label pre-retention

# 2. Confirm what will be deleted.
pnpm db:retention -- --dry-run

# 3. Delete.
pnpm db:retention -- --apply
```

For a first sweep of a large table, start narrow and observe:

```bash
pnpm db:retention -- --apply --category=security_events --batch-size=500 --max-batches=10
```

Re-run until the category reports `truncated=false`.

### Investigate a cleanup failure

1. **Read the summary.** A failed category prints `FAILED <category> ...
   code=<SQLSTATE> error=<message>`. Categories that succeeded still report
   their real counts — the run was not all-or-nothing.
2. **Map the SQLSTATE.** `42501` is permission denied (the database role cannot
   delete from that table). `23503` is a foreign-key violation — a new child
   table references a covered table and the catalog has not been updated.
   `57014` is statement timeout: lower `--batch-size`.
3. **Re-run just that category** once the cause is fixed:
   `pnpm db:retention -- --apply --category=<name>`. Categories that already
   succeeded are unaffected.
4. **A run that cannot start at all** (exit 1 with `Retention cleanup failed:`)
   is a configuration or connectivity problem, not a cleanup problem. The
   command loads the same configuration as the API — verify it the same way.

### Change a retention window

1. Edit the value in the deployment's environment (and `.env.example` if the
   default itself is changing).
2. Confirm the floor in `packages/config/src/schema.ts` permits it. Lowering a
   floor is a policy change: update this document's matrix and the reasoning in
   §3 in the same change.
3. Run `pnpm db:retention -- --dry-run` and compare the new `eligible=` counts
   against the old ones **before** applying. A shortened window can make a very
   large number of rows eligible at once; use `--max-batches` to sweep it
   incrementally.

### Add a new retention category

1. Confirm the table has a timestamp column whose meaning is "this row is dead"
   — not a status field.
2. **Check inbound foreign keys.** If anything references the table, the
   predicate must exclude rows whose referrers are still retained (§3.1), and
   the referencing column needs an index. The integration suite asserts the
   complete inbound-FK set, so a new reference fails a test rather than a
   production sweep.
3. Add the supporting index to the schema, run `pnpm db:generate`, and commit
   the generated migration.
4. Add the category to `RETENTION_CATEGORIES` in `retention-policy.ts`. Use
   `ageBasedCategory` unless the table has dependent rows.
5. Add the category name to `RETENTION_CATEGORY_NAMES`.
6. Add paired expired/active fixtures to `retention.integration.test.ts` and
   assert the active row survives.
7. Add the row to the matrix in §3 and the table in §4 of this document.
8. If it needs its own window, add the configuration value, its floor, its
   `.env.example` entry, and its config test.
