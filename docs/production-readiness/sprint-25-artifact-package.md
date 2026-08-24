# Sprint 25 Artifact Package — Backup, PITR, Restore, and Retention Foundation

**Sprint:** 25 · **Executed:** 2026-08-24 · **Findings targeted:** ORG-PR-005
(backup/PITR/tested restore, P1), ORG-PR-015 (retention/cleanup, P2).

This is the official Sprint 25 closing artifact. It records what was built,
what was actually executed, what each result proves, and — with equal weight —
what remains unproven.

**Outcome in one line:** the repository-controlled half of data durability is
complete and verified (**PITR VERIFIED**), retention enforcement is real and
tested (**ORG-PR-015 CLOSED**), and **ORG-PR-005 remains OPEN** on the
deployment-dependent half. Readiness classification is unchanged:
**C — Ready to continue production implementation. Not ready for staging. Not
ready for production.**

---

## 1. Implementation summary

| Area | Delivered |
| --- | --- |
| Persistent-data inventory | PostgreSQL established as the sole durability boundary, from repository evidence; Redis, Mailpit, artifacts, logs, and object storage classified with the evidence for each. |
| Logical backup | `tooling/db-backup.sh` — `pg_dump -Fc` from the repository's pinned PostgreSQL image, plus a SHA-256 sidecar and a provenance `meta.json`. |
| Restore drill | `tooling/db-restore-drill.sh` — real backup path, checksum verification, corrupted-AND-missing-artifact rejection, restore into a genuinely empty target, schema/ledger/entity/relational/hash assertions, migration no-op check. |
| Artifact recovery contract | `--with-artifact` — restored DB → `dist/migrate.mjs` → packaged API → `/health`, `/ready` → API-key-authenticated read of restored data → packaged retention command. |
| PITR | `tooling/db-pitr-drill.sh` — base backup + verified WAL archiving + `recovery_target_time`, with the boundary proven in both directions. **VERIFIED.** |
| Retention policy | Six-category catalog with per-category table, growth driver, retention column, window, index, and predicate; durable tables explicitly excluded on their own schema contracts. |
| Retention enforcement | `apps/api/src/maintenance/` — dry-run-by-default one-shot command, runnable from source and from the deployable artifact. |
| Retention configuration | Four typed values with hard floors, wired through the existing config schema and its production guards. |
| Migrations | `0012` — additive, index-only; four indexes, one per cleanup predicate that lacked one. |
| CI | Restore drill in the `integration` job; `--with-artifact` drill in the `artifacts` job; a new manual/weekly `data-durability.yml` for PITR. |
| Documentation | Three new documents plus reconciliation of 20 existing ones. |

**Explicitly not done** (out of scope by the sprint specification, and untouched):
staging or production infrastructure, cloud provisioning, IaC, managed
databases, production object storage, real backup scheduling, registry
publishing, deployment promotion or rollback automation, external SMTP/provider
validation, sender-domain validation, secrets-manager integration, automated
secret rotation, new product functionality, authorization or account-lifecycle
redesign, queue architecture, long-running workers, and monitoring/alerting
platforms. ORG-PR-001, ORG-PR-002, and ORG-PR-006 were not worked on and are
not closed.

---

## 2. Persistent-store inventory

| Store / state | Classification | Evidence | In backup scope |
| --- | --- | --- | --- |
| PostgreSQL | **Durable state — system of record** | Every domain table in `packages/db/src/schema/` plus the Drizzle migration ledger. | **Yes — the entire scope.** |
| Redis | **Ephemeral operational state** | Only `INCR` + `EXPIRE` on fixed-window rate-limit counters (`apps/api/src/lib/rate-limit.ts — createRedisRateLimiter`) and a readiness `PING` (`apps/api/src/server.ts`). Every key is TTL-bounded. | No — losing it re-opens the current rate-limit windows and nothing else. |
| Mailpit | Development-only | Local SMTP sink (`infra/docker-compose.yml`); production uses the SMTP driver. | No. |
| API artifact | Rebuildable | `apps/api/Dockerfile` + `apps/api/scripts/build.mjs`, resolved from `pnpm-lock.yaml`. | No. |
| Web artifact | Rebuildable | `apps/web-demo/Dockerfile`. | No. |
| Logs | Operational evidence | stdout/stderr only; no file sink; the runtime image has no writable application path. | No. |
| Uploaded / object-storage state | **Does not exist** | No upload route, no multipart handling, no object-storage client anywhere in `apps/` or `packages/`; `infra/compose.production-like.yml` declares no volumes. | Nothing to back up. |

Redis backup was **not** implemented, because inspection proved it stores no
durable state. Backing up rate-limit counters would create a second copy of
security-relevant data for zero recovery value.

---

## 3. Backup scope policy

- **In scope:** the PostgreSQL database named by the configured `DATABASE_URL`
  (or an explicit `--database-url`), in full — schema, data, and the
  `drizzle.__drizzle_migrations` ledger.
- **Out of scope:** Redis, Mailpit, images, logs, and the repository itself
  (recoverable from git).
- **Artifact format:** `pg_dump --format=custom --compress=9 --no-owner
  --no-acl`. Custom format is compressed, restorable into an empty database
  with `pg_restore`, and supports selective restore during an incident.
- **Client versioning:** every PostgreSQL client tool runs from
  `postgres:16.14-alpine` at the digest the repository's servers already use
  (`tooling/lib/pg-tools.sh`). Client/server drift — a classic source of
  recovery-time failure — is structurally impossible. *Rejected alternative:*
  the host's `pg_dump`, which makes the artifact depend on whatever a laptop
  or runner happens to have installed.

---

## 4. Logical backup behavior

`tooling/db-backup.sh` (`pnpm db:backup`) produces:

```
orgistry-<UTC timestamp>[-<label>].dump         mode 600
orgistry-<UTC timestamp>[-<label>].dump.sha256  mode 600
orgistry-<UTC timestamp>[-<label>].meta.json    mode 600
```

Behavioral guarantees:

- accepts the configured `DATABASE_URL`, an explicit `BACKUP_DATABASE_URL`, or
  `--database-url`; falls back to the workspace `.env` only when nothing else
  is supplied;
- the connection URL is passed to the client through an environment variable —
  never as a command argument, never into a filename, never printed;
- provenance is read back from the SERVER (`current_database()`,
  `server_version`, the migration-ledger count) rather than parsed out of the
  URL, so no credential can reach the sidecar;
- a `pg_dump` non-zero exit or a zero-byte output deletes the partial file and
  exits non-zero — there is no partial-backup state to mistake for a backup;
- the output directory is created under `umask 077`; writing inside a `.git`
  directory is refused; overwriting an existing artifact is refused;
- `.gitignore` excludes `backups/`, `*.dump`, and `*.dump.sha256`.

Recorded local run (against a throwaway PostgreSQL):

```
Backing up to .../orgistry-20260824T061320Z.dump
Backup complete: 53493 bytes, 13 applied migrations, server 16.12
```

---

## 5. Restore drill behavior

`tooling/db-restore-drill.sh` (`pnpm drill:restore`). Ten steps, each built so
it can only pass for the right reason:

1. throwaway **source** PostgreSQL created and migrated with the repository's
   own migration entrypoint;
2. deterministic synthetic Orgistry data seeded
   (`tooling/fixtures/restore-drill-seed.sql`);
3. backup taken by the **real** `tooling/db-backup.sh` — not a drill-only copy;
4. artifact asserted present and non-empty; SHA-256 verified; **a truncated
   copy is proven to be rejected by `pg_restore`**, so corruption fails loudly
   rather than restoring partially;
5. a **fresh** target container asserted to have **zero public tables before
   restoring** — a "successful" restore can never be reporting the target's own
   pre-existing state;
6. **a MISSING artifact proven to fail the same way**: non-zero exit, the
   unopenable path named, no credential echoed, and the target still at zero
   public tables. Probed on the real target immediately before the real
   restore, so the emptiness assertion is meaningful rather than vacuous;
7. `pg_restore --exit-on-error` (without it, `pg_restore` continues past
   failures and reports success on a partial restore);
8. all 18 expected tables asserted present; the Drizzle migration ledger
   asserted equal to the source's;
9. every seeded entity asserted by count, an owner → membership → organization
   → plan → project join asserted, and the API-key `secret_hash` +
   `display_prefix` asserted byte-identical — a restore that mangled hash-only
   secret storage would silently break every machine credential;
10. migrations re-run against the **restored** database with the ledger required
    to be unchanged (restored-database compatibility with current migration
   handling);
11. every container, volume, network, and backup file destroyed on exit unless
    `--keep` is passed.

Representative entities cover: user, organization, membership, role assignment,
plan/entitlement state, project, API-key hash metadata, invitation,
security/audit events, and the `app_meta` infrastructure marker. Roles,
permissions, and plans are referenced rather than re-created, so the drill also
proves the migration-seeded baseline survived.

### Deployable-artifact restore compatibility

`--with-artifact` completes the recovery contract:

```
restored PostgreSQL → node dist/migrate.mjs → packaged API artifact
  → /health 200 → /ready 200
  → GET /v1/external/projects (API-key authenticated) → the restored projects
  → unknown API key → 401
  → no drill secret in the artifact logs
  → node dist/retention.mjs --dry-run / --apply
```

The authenticated read is real application-level evidence: the external
Projects API resolves a Bearer key by SHA-256 hash **against the restored
database**, derives the tenant from that key's row, and returns that
organization's projects — one request exercising restored credential metadata,
restored tenant state, and restored business rows. The unknown-key assertion
proves a restore did not widen authentication.

*Why not a browser-session login?* Session authentication needs a real Argon2id
password hash, which cannot be produced from a SQL fixture without duplicating
the hashing implementation inside the drill. API-key authentication is
deterministic SHA-256, so the drill derives a real hash at run time and
`tooling/restore-drill-fixture.test.ts` pins the assumption that the product
hashes that way.

No development server is involved anywhere in this path.

---

## 6. PITR strategy and evidence

### Strategy

PostgreSQL-native, matching what the repository actually runs (`postgres:16.14-alpine`):

| Element | Choice |
| --- | --- |
| Base backup | `pg_basebackup --format=plain --wal-method=stream --checkpoint=fast` |
| Archiving | `archive_mode=on`, `archive_command='test ! -f /wal_archive/%f && cp %p /wal_archive/%f'` (refuses to overwrite; non-zero on failure) |
| WAL level | `wal_level=replica` |
| Recovery | `recovery.signal` + `restore_command` + `recovery_target_time` + `recovery_target_action=promote`, on an independent server with `archive_mode=off` |

*Rejected alternative:* a backup wrapper (pgBackRest, WAL-G, Barman). Better
production tools, but the evidence would then be about the wrapper's
configuration rather than the database's recoverability, and nothing this
repository deploys would exercise it.

### Evidence

`tooling/db-pitr-drill.sh`, executed 2026-08-24 on macOS with Docker 29.2.0:

```
1/12  wal_level=replica archive_mode=on              (read back from SHOW)
2/12  applied migrations: 13
3/12  archived_count=2, 2 file(s) on the archive volume, no archive failures
4/12  base backup taken (PG_VERSION 16)
5/12  pre-target rows committed (users=1)            AFTER the base backup
6/12  recovery target: 2026-08-24 06:22:34.825498+00
7/12  post-target damage applied (users deleted, projects dropped, marker overwritten)
8/12  target PGDATA seeded from the base backup with recovery.signal
9/12  recovery completed and the target promoted
10/12 the target restored WAL segments from the archive
      the target log records stopping at the recovery target
11/12 pre-target marker recovered = pre-target
      pre-target user recovered = 1
      user rows at the target time (post-target DELETE undone) = 1
      post-target-only row absent = 0
      post-target DROP TABLE undone = t
12/12 all 18 tables present; migration metadata intact = 13;
      seeded role baseline intact = 4; relational read over recovered data = 23
PITR drill PASSED
```

Three properties make this evidence rather than a demonstration:

- **The pre-target rows are written after the base backup**, so recovering them
  is possible *only* by replaying archived WAL. A base-backup-only restore
  would fail step 11.
- **Archived-WAL consumption is asserted from the recovery log**, not inferred.
- **The boundary is checked in both directions** — pre-target present AND
  post-target absent. A recovery that replayed everything, or nothing, fails.

**Status: PITR VERIFIED** — locally, on the PostgreSQL version this repository
runs, against a database carrying the real Orgistry schema.

### Why PITR is not in per-PR CI

The drill starts two servers and waits on archive recovery (~1 minute of mostly
idle time) and cannot be parallelised. The split: the logical backup/restore
drill — what a code change can realistically break — runs on every push and
pull request; the PITR drill validates the recovery *strategy*, which changes
only when the tooling, the pinned image, or the migration baseline changes, and
runs manually plus weekly in `.github/workflows/data-durability.yml`. Command
to execute it: `pnpm drill:pitr`, or Actions → "Data durability" → Run workflow.

---

## 7. Backup security policy

Established in tooling and documented in
[../backup-and-restore.md](../backup-and-restore.md#7-backup-security):

- a backup contains every user and organization record, the full security-event
  history, Argon2id password hashes, and the SHA-256 hashes behind every
  refresh/verification/reset/registration token, invitation, and API key —
  treat it as a credential store;
- backups are never committed (`.gitignore`; the tool refuses to write inside
  `.git`; drills use temporary directories deleted on exit);
- backup CONTENT never reaches any output stream; CI steps print counts, sizes,
  and table names only;
- database credentials never appear in logs, filenames, paths, or the metadata
  sidecar;
- artifacts are `chmod 600` in a `umask 077` directory from creation;
- backups must not be attached to tickets, chats, screen shares, or CI artifact
  bundles.

Stated honestly rather than implemented symbolically:

- **the SHA-256 sidecar is integrity, not encryption and not access control**,
  and `meta.json` records `"encrypted": false`. No repository-level encryption
  was added: a symbolic one would let an unverified claim be reviewed as a
  verified one;
- production backup storage must use encryption at rest — infrastructure this
  repository does not provision (**ORG-PR-001**, open);
- production backup access must be least privilege — dependent on a secrets/
  identity story that does not exist (**ORG-PR-006**, open);
- **backup retention is a distinct policy from application-table retention.**
  How many backups are kept is a recovery-objective decision; `retention.md`
  governs rows inside a live database. Neither bounds the other.

---

## 8. Retention policy matrix

| Category | Table | Column | Default | Floor | Predicate | Index |
| --- | --- | --- | --- | --- | --- | --- |
| `security_events` | `security_events` | `created_at` | 180 d | 30 d | `created_at < now() - window` | `ix_security_events_created_at` |
| `expired_refresh_tokens` | `refresh_tokens` | `expires_at` | 90 d | 7 d | `expires_at < now() - window` | `ix_refresh_tokens_expires_at` (`0012`) |
| `expired_sessions` | `sessions` | `expires_at` | 90 d | 7 d | `expires_at < now() - window` **AND no retained referrer** | `ix_sessions_expires_at`, `ix_refresh_tokens_session_id`, `ix_security_events_session_id` |
| `expired_email_verification_tokens` | `email_verification_tokens` | `expires_at` | 30 d | 1 d | `expires_at < now() - window` | `ix_email_verification_tokens_expires_at` (`0012`) |
| `expired_password_reset_tokens` | `password_reset_tokens` | `expires_at` | 30 d | 1 d | `expires_at < now() - window` | `ix_password_reset_tokens_expires_at` (`0012`) |
| `expired_pending_registrations` | `pending_registrations` | `expires_at` | 30 d | 1 d | `expires_at < now() - window` | `ix_pending_registrations_expires_at` |

Every window is an **Orgistry engineering default**, not a regulatory
requirement. No legal obligation is asserted anywhere.

**Deliberately excluded, on repository evidence:**

| Table | Why |
| --- | --- |
| `invitations` | `schema/invitations.ts`: "Rows are NEVER hard-deleted." Expiry is derived at read time; accepted/revoked rows are the audit trail of who joined an organization. |
| `api_keys` | `schema/api-keys.ts`: revoked, never hard-deleted — the revoked row is what proves a key existed. |
| `users`, `organizations`, `memberships`, `projects` | Account and tenant state. Deletion is a product feature with consent/export/cascade semantics (ORG-PR-043), not a maintenance sweep. |
| `roles`, `permissions`, `role_permissions`, `plans`, `app_meta` | Migration-seeded or bounded reference data with no growth. |

**Checklist categories that do not exist here** — documented rather than
invented: no separate audit table (the audit read path reads
`security_events`); no persistent idempotency store (idempotency is enforced by
database constraints); no persistent email-event/outbox table (the mailer is
synchronous and stores nothing); no job/queue tables.

**Per-plan interaction.** The seeded plan catalog advertises at most 90 days of
`audit_retention_days` (Free 0, Pro 30, Business 90; migration `0005`). The
180-day default is deliberately above that, so cleanup cannot delete history a
plan promises to keep, and a config test pins the relationship. Per-plan
enforcement remains unimplemented — retention is global.

---

## 9. Cleanup command behavior

`apps/api/src/maintenance/` — four files with one responsibility each:
`retention-policy.ts` (the catalog and every predicate), `retention.ts` (the
executor), `retention-cli.ts` (argument surface and report, pure), and
`retention-command.ts` (process wiring). Bundled to `dist/retention.mjs` by
`apps/api/scripts/build.mjs`, so it ships in the same image as the API.

| Property | Behavior |
| --- | --- |
| Modes | `--dry-run` (default, counts only) and `--apply`. **No other flag combination reaches apply mode**, pinned by test over the whole flag space. |
| Selection | `--category=<name>`, repeatable; catalog order is always preserved. |
| Batching | `--batch-size` (default `RETENTION_CLEANUP_BATCH_SIZE`), one bounded batch per transaction, oldest rows first; `--max-batches` caps a category and marks it `truncated`. |
| Rejection | Unknown category, unknown argument, non-numeric/zero/negative/oversized numbers, and `--apply --dry-run` together all exit `2` with usage. Nothing is silently absorbed. |
| Exit codes | `0` clean, `1` a category failed or the run could not start, `2` invalid arguments. |
| Output | Counts, table/column names, day counts, ISO cutoffs. Nothing else is reachable from the summary. |
| Failure isolation | A category that throws is recorded and the run continues; the process still exits non-zero. |
| Configuration | `loadWorkspaceEnv()` + `getConfig()` — the same path as the API, so `<NAME>_FILE` mounted secrets and every production guard apply. |
| Scheduling | None. It is a command; "disabled" is the default state of the system. |

**Bounded-delete SQL and why it is safe.** PostgreSQL has no `DELETE ... LIMIT`,
so rows are chosen by a bounded `SELECT` and deleted by primary key:

```sql
DELETE FROM <table>
 WHERE id IN (SELECT id FROM <table>
               WHERE <retention column> < $cutoff
               ORDER BY <retention column>
               LIMIT $batch)
RETURNING id
```

`ORDER BY` makes each batch the oldest eligible rows (monotonic reruns, index
walk); the subselect is evaluated once inside the batch's transaction so a
concurrent insert cannot widen it; `RETURNING id` yields a real count.

`expired_sessions` is the one category that differs, because `sessions` is the
only retention target with **inbound** foreign keys — `refresh_tokens.session_id`
and `security_events.session_id`, neither cascading. Its rule: **a session is
deleted only when every row that references it is itself past its own retention
cutoff**, each clause using that referrer's own window. Two consequences, both
intended:

- **a refresh token is only ever deleted by its own predicate.** Refresh
  lifetimes are not capped by the session (`auth.service.ts — refresh` mints a
  successor at `now + refreshTokenTtl`), so a token rotated shortly before a
  session ends outlives it and the session becomes eligible first. Holding the
  session back makes the active-token guarantee structural — it does not depend
  on the (true, but remote) fact that `rotateRefreshToken` rejects a token whose
  session has expired before it checks the token's own expiry;
- **audit history is never mutated to make a delete succeed.** Security events
  are retained far longer than sessions (180 d vs 90 d by default), so sessions
  are effectively retained until their events age out. Cascading the delete or
  nulling `security_events.session_id` would each destroy audit fidelity to
  reclaim a session row.

The hold-back is expressed in the `SELECT`, not by skipping rows afterwards, so
a blocked session never consumes a batch slot and never triggers the executor's
short-batch termination early.

**Rejected alternative:** a minimal environment reader for the command (as
`packages/db/src/env.ts` does for migrations). More convenient, but it would
create a second configuration path where a production process could boot with
values no guard had validated. The cost of the chosen design is stated plainly:
under `NODE_ENV=production` the command requires the API's full production
environment, including mail settings it never uses. Run it as a one-shot job
with the same environment and secret mounts as the API.

---

## 10. Retention test evidence

`apps/api/src/maintenance/retention.integration.test.ts` — 15 cases against
live PostgreSQL, all timestamps derived from one fixed reference instant (no
sleeps):

| Property | Case |
| --- | --- |
| Dry-run finds eligible rows | counts match seeded expectations per category |
| Dry-run deletes nothing | row counts unchanged; every category reports 0 batches / 0 deleted |
| Apply deletes expired eligible rows | 6 rows across 5 expired/active fixture pairs |
| Apply preserves active rows | the active half of every pair survives, including the user account |
| Timestamp boundary | a row AT the cutoff survives; one 1 ms older does not (`<`, not `<=`) |
| Second apply is safe | deletes nothing, exit code 0 |
| Batch size honoured | 7 rows, `--batch-size=2 --max-batches=2` → 4 deleted, 2 batches, `truncated=true`; rerun finishes 3 and reports clean |
| Ordering | batches take the oldest rows first |
| Category isolation | `--category` touches only its own table |
| Foreign-key safety | the session sweep clears its refresh tokens even when run alone |
| Non-over-reach | a refresh token still inside its own window survives a full run |
| **Active-token invariant** | an eligible session whose refresh token is NOT independently eligible is held back — neither row deleted, and dry-run agrees with apply |
| **Release** | that session is deleted on a later run once the token ages out |
| **Audit-referrer invariant** | an eligible session still referenced by a RETAINED security event is held back, with `failedCategories = 0` (the SQLSTATE 23503 regression guard) |
| **Release** | that session is deleted once the referencing event ages out |
| **Hold-back does not starve the batch** | a blocked session (oldest of three) consumes no batch slot: `--batch-size=1` still deletes both clean sessions |
| DB failure returns non-zero | unreachable database → every category failed, 0 deleted, exit 1 |
| Sensitive data not emitted | a serialized summary contains no seeded email, token hash, user id, or `argon2id` marker |
| Indexes exist | every category's declared `supportingIndex`, plus both session referrer indexes |
| **Inbound-FK coverage** | the complete set of foreign keys pointing at retention targets matches the reviewed list, so a new referencing table fails a test instead of a production sweep |
| Durable tables untouched | a full run's result set never names `invitations` or `api_keys` |

Plus `retention-cli.test.ts` (17 — flag safety, rejection of dangerous values,
report format, exit codes), `retention-policy.test.ts` (9 — catalog invariants,
durable-table exclusion, cutoff arithmetic, and the shared sessions/
refresh-tokens window the hold-back predicate relies on), and 7 cases in
`packages/config/src/config.test.ts` (defaults, floors, zero/negative
rejection, batch bounds, the plan-retention relationship). **54 retention
tests**, plus 7 drill-fixture drift tests in
`tooling/restore-drill-fixture.test.ts`.

### `audit_retention_days` reconciliation

Verified from source, not inferred. `audit_retention_days` is **modeled
metadata explicitly documented as non-enforced**, in three independent places
that all predate Sprint 25: `packages/contracts/src/plans.ts` (entitlement-key
catalog — *"Modeled policy value … returned, not enforced by a deletion job"*;
and `entitlementValuesSchema` — *"a modeled policy value only — Sprint 7
returns it but does not run a retention/deletion job"*) and
`apps/api/src/modules/entitlements/entitlement.service.ts`
(`AuditEntitlements.retentionDays` — *"not enforced by a deletion job in v1"*),
with the same statement on the read surface in `docs/audit-log.md`. No route,
service, or query reads it to gate or remove data.

Sprint 25 therefore adds **repository-level lifecycle cleanup with a global
window** and leaves the pre-existing non-enforced entitlement semantics
unchanged — it neither honours nor breaks a behavioral contract, because none
existed. ORG-PR-015 asked for retention/cleanup on unbounded tables; that now
exists and is tested, so its closure stands. Per-plan enforcement is a
separate, unclaimed capability and remains a documented limitation. The one
real interaction is presentational and is guarded: the 180-day default sits
above the largest advertised plan value (90), pinned by a config test.

---

## 11. Local validation evidence

Every command below was executed on the final working tree.

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm validate` | **PASS** (exit 0) | typecheck, ESLint, **954 unit tests / 87 files**, **78 web tests / 10 files**, web build, `Schema drift check passed: migrations are in sync with the schema.`, `git diff --check` clean |
| `pnpm validate:integration` | **PASS** (exit 0) | `packages/db` 16 tests / 1 file (migration-from-scratch); `apps/api` **103 tests / 16 files**, including the 21 retention cases. Run against PostgreSQL 16.12 on an alternate host port + Redis |
| `git diff --check` | **PASS** | no whitespace errors |
| `pnpm scan:deps` | **PASS** | `1 high (1 ignored)` prod, `No known vulnerabilities found` dev — the two documented acceptances, unchanged |
| `pnpm scan:deps:local` | **PASS** | osv-scanner: `No issues found` (446 packages) |
| `pnpm scan:secrets` | **PASS** | gitleaks git history: `48 commits scanned`, `no leaks found` |
| gitleaks **working-tree** scan | **PASS** | `gitleaks dir .` → `no leaks found`. Run in addition to the repository's standard command because `gitleaks git .` scans history and would not see uncommitted new files (see §13). Also confirmed: no `.dump`, `.dump.sha256`, or `backups/` path is tracked or present in the tree, and no drill credential appears in any document |
| `actionlint` | **PASS** | exit 0 across all four workflows, including the new `data-durability.yml` |
| `tooling/artifact-smoke.sh` | **PASS** | `SMOKE OK: all artifact checks passed.` |
| `pnpm drill:restore` | **PASS** (exit 0) | data-layer drill: checksum verified, **truncated AND missing artifacts rejected** (`a missing artifact fails (exit 1), names the path, and echoes no credential`; target still at 0 public tables), 18 tables, ledger = 13, all entity counts, join, API-key hash, migration no-op |
| `pnpm drill:restore -- --with-artifact` | **PASS** (exit 0) | adds `/health` 200, `/ready` 200, both restored projects returned by the authenticated API, unknown key 401, no secret in logs, packaged retention dry-run + apply, all seeded entities intact afterwards. The image was rebuilt for this run and verified to carry the refined session predicate |
| `pnpm drill:pitr` | **PASS — PITR VERIFIED** (exit 0) | full 12-step transcript in §6 |
| Migration-from-scratch | **PASS** | `packages/db/src/migrate.integration.test.ts` (16 cases) via `pnpm validate:integration`, after `pnpm db:reset:test` drops `public` + `drizzle` and re-applies the full baseline |
| Populated forward migration | **PASS** | the restore drill applies `0012` to a **populated** restored database and requires the ledger to be unchanged; `pnpm db:migrate` was also applied to the populated local development database |
| Schema-drift validation | **PASS** | `pnpm db:check` (regenerate-and-compare) inside `pnpm validate` |

### Environment note (not a repository failure)

The workspace `.env` points `DATABASE_URL`/`TEST_DATABASE_URL` at
`localhost:5432`, which is not listening on this machine. Integration
validation was therefore run with both URLs overridden to a PostgreSQL
container published on an alternate host port. This is a local environment
limitation, not a repository defect: CI provides `postgres:16.14-alpine` on
5432, and the drills create their own containers and are unaffected either way.
The local server is 16.12 while the pinned client is 16.14 — a
client-newer-than-server combination `pg_dump` supports, and CI runs both at
16.14.

---

## 12. Remote validation evidence

**None yet.** At the time this artifact was written, **remote CI has not run
for this change set** — the work is uncommitted in the working tree, as the
sprint specification requires. No CI run ID, no workflow conclusion, and no
remote artifact exists for it, and none is claimed.

**Sprint 25 is therefore NOT officially complete.** Local repository validation
is complete and green (§11), but the sprint's Definition of Done requires the
remote workflows to pass on the pushed change set. The correct status is:

```
LOCAL SPRINT IMPLEMENTATION READY FOR REMOTE VALIDATION
```

Remote evidence still required before this artifact may record completion:

| Workflow | Required |
| --- | --- |
| `CI` (`ci.yml`) — Validate (offline), Integration (PostgreSQL + Redis), Artifacts (build + smoke) | green on the pushed commit |
| `Security scans` (`security.yml`) — dependency audit + Gitleaks | green on the pushed commit |
| `CodeQL` (`codeql.yml`) | green on the pushed commit |
| `Data durability` (`data-durability.yml`) — the PITR drill | green on a manual dispatch against the pushed ref (it is manual/scheduled, so a push does not trigger it) |

Note that the backup/restore, retention, and artifact-restore evidence is
carried by the existing `CI` jobs rather than a new workflow; only the PITR
drill needs a separate dispatch.

What remote CI will exercise once this is pushed:

| Workflow / job | New coverage |
| --- | --- |
| `ci.yml` → `validate` | The retention unit/config/fixture tests and the schema-drift check over migration `0012`. |
| `ci.yml` → `integration` | The 15 retention integration cases, plus `./tooling/db-restore-drill.sh` (data layer). |
| `ci.yml` → `artifacts` | `./tooling/db-restore-drill.sh --with-artifact` against the freshly built image. |
| `data-durability.yml` | The PITR drill — manual dispatch or the weekly schedule; **not** a required check. |

**Operator follow-up (not repository-controlled):** the Sprint 25 steps run
inside the existing `integration` and `artifacts` jobs, so they inherit those
jobs' required-check configuration. The new `Data durability` workflow is
intentionally not required. If a maintainer later wants it enforced, that is a
GitHub branch-protection change made in repository settings — nothing here
mutates remote configuration.

---

## 13. Security self-review

The final diff was inspected specifically for the failure modes this kind of
work introduces.

| Check | Result |
| --- | --- |
| Credential leakage | Connection URLs are passed by environment variable only; no script echoes one. The metadata sidecar is built from server-side queries, never from URL parsing. The retention summary carries counts only, and an integration test asserts no email/hash/id can appear in it. |
| Unsafe shell expansion | Every script runs `set -euo pipefail`; every expansion is quoted; `pg_start_server` splits docker and server arguments through explicit arrays. The one `sh -c` indirection (`pg_client`) receives only literal command strings from this repository — no untrusted value is interpolated into one. |
| Backup paths containing secrets | Filenames are `orgistry-<timestamp>[-<label>]`; `--label` is validated against `[A-Za-z0-9._-]+`. |
| CI log leakage | The drills print step names, counts, and table names. Backup content is never written to a stream. The artifact stage asserts no drill secret appears in the API logs. |
| Committed backup artifacts | `.gitignore` covers `backups/`, `*.dump`, `*.dump.sha256`; the tool refuses to write inside `.git`; drills delete their artifacts on exit; `git status` confirms none is staged. |
| Destructive cleanup defaults | Dry-run is the default; `--apply` is required; test-pinned across the flag space. |
| Unbounded deletes | Every delete is a `LIMIT`-ed id subselect inside one transaction, with a per-category batch cap. |
| Active-row deletion | Structurally prevented (durable-table denylist test), behaviorally proven (paired expired/active fixtures), and — for the one category with inbound foreign keys — enforced by the predicate itself: a session is deleted only when every referrer is past its own cutoff, so no row is ever deleted as collateral for another row's eligibility. |
| Referential integrity | The complete inbound-FK set on retention targets is asserted by an integration test, so a future referencing table fails CI rather than a production sweep. |
| Missing retention indexes | Every declared `supportingIndex` is asserted to exist in `pg_indexes` by an integration test. |
| Timestamp boundary mistakes | Strict `<` pinned by a case seeding one row at the cutoff and one 1 ms older; cutoffs derive from an explicit `now`, never `Date.now()` inside the executor. |
| PITR false positives | Pre-target rows are written after the base backup (so only WAL replay can recover them); archived-WAL consumption is asserted from the recovery log; the boundary is checked in both directions. |
| Stale documentation | 20 existing documents reconciled against the implementation; the ones that previously said "no backup exists" or "no cleanup exists" now say what is and is not true. |
| Production-readiness overclaims | Classification unchanged at **C**; ORG-PR-005 explicitly left open; every deployment-dependent gap enumerated. |

**Two issues were found and fixed during review.**

**1. A committed hash literal (implementation pass).** A working-tree gitleaks
scan (`gitleaks dir .`, run *in addition* to the repository's standard
`gitleaks git .`, which scans history and cannot see uncommitted files) flagged
the drill's committed 64-hex API-key hash constant as a `generic-api-key`. The
fix was not an allowlist entry: the drill now **derives** that hash at run time
from the fixture secret (`sha256_hex` in `tooling/lib/pg-tools.sh`), so no hash
literal is committed at all, drift between secret and hash is impossible by
construction, and `restore-drill-fixture.test.ts` pins the one assumption this
makes (that the product hashes API-key secrets as plain SHA-256 hex) plus a
guard asserting no 64-hex literal reappears in the fixture file.

**2. The ended-session sweep ignored a second inbound foreign key (refinement
pass) — the most serious defect found in this sprint.** `sessions` has two
referencing columns, `refresh_tokens.session_id` *and*
`security_events.session_id`. The original implementation handled only the
first. Two independent problems followed:

- **It would have failed in production, every run.** Security events are
  retained far longer than sessions (180 d vs 90 d), and a normal login writes
  an event carrying that `session_id`, so essentially every session old enough
  to sweep is still referenced by a retained event. Deleting it raises SQLSTATE
  `23503`. Per-category failure isolation meant this surfaced as a permanently
  failed category and a non-zero exit rather than a crash — a slow-burn defect
  that local fixtures did not reproduce because they never attached a security
  event to a swept session. It was found by deriving the inbound-FK set from
  `pg_constraint` rather than trusting the schema reading, and reproduced by a
  test written to fail before the fix.
- **The refresh-token guarantee rested on a cross-module argument.** The
  original child delete was unconditional, so a session's age could decide the
  fate of a token its own predicate had not selected. That was *safe* — refresh
  lifetimes are not capped by the session, but `rotateRefreshToken` rejects a
  token whose session has expired before it ever checks the token's own expiry,
  so such a token is inert — yet the safety depended on the ordering of two
  checks in a different module, with no test binding them.

Both were fixed by the same conservative change: a session is deleted only when
**every** row referencing it is itself past its own retention cutoff, each
clause using that referrer's own window. The guarantee is now structural,
`ix_security_events_session_id` was added to keep the referrer check
index-backed, and five regression tests pin the behavior (hold-back and release
for each referrer, plus proof that a held-back session does not starve the
batch). The cost — sessions are effectively retained until their security
events age out — is documented in `docs/retention.md` §3.1 rather than hidden
behind a nominal 90-day window.

---

## 14. Scope self-review

The final diff was inspected for scope creep. Nothing in it introduces
deployment infrastructure, cloud IaC, production SMTP or email-provider work,
secrets-provider integration, unrelated product features, queue/worker
architecture, or a production-readiness claim.

Two changes touch files outside the obvious blast radius, and both are
necessary integration points rather than creep:

- `apps/api/scripts/build.mjs` gains one entry point so the retention command
  ships in the image that already ships the migration entrypoint. Without it,
  §14 of the specification ("runnable from the deployable API artifact where
  compatible") could not be satisfied.
- `packages/config/src/schema.ts` and `index.ts` gain the four retention
  values. They are consumed by real cleanup behavior; no dead configuration was
  added.

`infra/compose.production-like.yml` was **not** modified: the drills create
their own containers, which is stricter than reusing a compose stack (no
persistent volume can make a drill pass on the previous run's state).

Existing behavior is untouched. No change was made to registration, email
verification, password recovery, invitations, authorization, quotas, API-edge
hardening, JWT/runtime secret handling, or artifact packaging beyond the added
entry point. The three new indexes are additive; the only edits to
`packages/db/src/schema/auth.ts` are index additions and comment corrections.

---

## 15. Documentation updates

**New (3):**

| Document | Contents |
| --- | --- |
| [../backup-and-restore.md](../backup-and-restore.md) | Persistent-data inventory, backup scope and design choices, the restore drill, artifact compatibility, CI integration, backup security, known limitations, and six runbooks. |
| [../pitr.md](../pitr.md) | Why a logical restore is not PITR, the strategy table, the twelve-check drill with its recorded transcript, the CI cost tradeoff, four runbooks, and the proven/not-proven boundary. |
| [../retention.md](../retention.md) | Schema analysis (covered / deliberately excluded / non-existent), the policy matrix, configuration and its floors, the command contract, transaction and batching safety, eight invariants, test evidence, limitations, and five runbooks. |

**Reconciled (20):** `README.md`, `docs/architecture.md`,
`docs/audit-log.md`, `docs/database-foundation.md`,
`docs/deployment-artifacts.md`, `docs/known-limitations.md`,
`docs/roadmap.md`, `docs/runbook.md`, `docs/security-model.md`,
`docs/validation.md`, and in `docs/production-readiness/`: `README.md`,
`findings-register.md`, `launch-checklist.md`, `production-roadmap.md`,
`production-scorecard.md`, `production-target.md`, `repository-inventory.md`,
`security-assessment.md`, `standards-matrix.md`, and this package.

Knowledge captured that was not previously recorded anywhere: the durability
classification of each store *with its evidence*; that `invitations` and
`api_keys` are intentionally outside retention and why; that the default
security-event window is bound to the plan catalog's largest advertised value;
that the checksum is integrity and explicitly not encryption; and that a
verified PITR drill is a capability rather than a backup posture.

---

## 16. Findings reconciliation

| Finding | Status | Justification |
| --- | --- | --- |
| **ORG-PR-005** | **OPEN — materially advanced** | All four closure preconditions exist (repeatable backup, tested restore, documented operational process, actual PITR validation), but the finding's expected production behavior is *automated encrypted backups + PITR meeting a target RPO/RTO*. Nothing schedules a backup; no artifact is stored remotely or encrypted; no long-lived database archives WAL; no provider-managed PITR exists; archive health is unmonitored; no RPO/RTO is measured. All depend on ORG-PR-001. Closing on capability alone would assert that the backup/DR launch gate is satisfied while no backup runs anywhere. |
| **ORG-PR-015** | **CLOSED** | A retention policy exists (six categories, evidence-backed, with durable tables deliberately excluded); runnable cleanup exists (source mode and deployable artifact); cleanup safety is tested against live PostgreSQL. Documentation alone would have been insufficient, and this is enforcement. Scheduling remains deployment-dependent under ORG-PR-016, which the finding's own remediation anticipated. |
| **ORG-PR-016** | **OPEN** | The maintenance WORK now exists as one-shot commands; the scheduler, metrics, alerting, and concurrency control do not. |
| **ORG-PR-028** | **OPEN** | The recovery MECHANISM now exists (restore and PITR, both tested, plus a pre-migration backup step in the deployment guide); the rehearsal against a real environment does not, and no staging environment exists to rehearse in. |
| **ORG-PR-055** | **OPEN (residual narrowed)** | One of its two durable fixes — retention on `security_events` — now exists and caps how far back a `targetId` scan can reach. The metadata index still does not. |
| **ORG-PR-001** | **OPEN** | Out of scope; untouched. |
| **ORG-PR-002** | **OPEN** | Out of scope; untouched. No email work was performed. |
| **ORG-PR-006** | **OPEN** | Out of scope; untouched. The retention command reuses the existing secret-source seam without extending it. |

---

## 17. Remaining risks and external dependencies

**Repository-controlled (could be addressed here):**

- No concurrency guard between two simultaneous retention runs. They are safe
  (transactional batches over an idempotent predicate) but not prevented.
- Per-plan `audit_retention_days` is still not enforced; retention is global.
- The `targetId` audit filter is still unindexed (ORG-PR-055).
- The PITR drill runs manually and weekly, so a change to the PITR tooling
  merged without running it would not be caught until the next scheduled run.
- The failed-migration runbook is unrehearsed guidance, and is labelled as such.

**Deployment / cloud / provider-dependent (cannot be addressed here):**

- No backup schedule, no encrypted remote backup storage, no lifecycle policy,
  no cross-region copy (ORG-PR-001).
- No continuous WAL archiving on any long-lived database, and no monitoring of
  archive health — a silently failing `archive_command` is the classic way PITR
  stops existing unnoticed (ORG-PR-001, ORG-PR-007).
- No provider-managed PITR window (ORG-PR-001).
- No measured RPO/RTO; DG-5's objectives remain unvalidated (ORG-PR-005).
- No least-privilege backup/restore identity (ORG-PR-006).
- No scheduler, metrics, or failure alerting for the maintenance commands
  (ORG-PR-016, ORG-PR-007).
- No restore rehearsal against production-sized data — by design, there is no
  production data.

---

## 18. Remaining P1 blockers

```
ORG-PR-001 — Production deployment environment, promotion, rollback, automation
ORG-PR-002 — External production email/provider validation
ORG-PR-005 — Backup, PITR, and tested restore capability (deployment half)
ORG-PR-006 — Complete secrets-management and operational rotation capability
```

---

## 19. Final readiness classification

```
C — Ready to continue production implementation
Not ready for staging
Not ready for production
```

Unchanged. Four P1 blockers remain open; under the overriding rule any one of
them is independently disqualifying. Sprint 25 removed the
repository-controlled half of ORG-PR-005 from the critical path and closed
ORG-PR-015 — neither is launch clearance.

---

## 20. Recommended next sprint

**Sprint 26 — Production Deployment Environment, Promotion, and Rollback
(ORG-PR-001).**

It is now the single largest unblocker on the critical path. What remains of
ORG-PR-005 sits entirely behind it — a scheduled, encrypted, remotely-stored
backup and continuous WAL archiving require a real deployment target, as does
any RPO/RTO measurement. The same environment unblocks ORG-PR-006's rehearsed
rotation and ORG-PR-028's bad-migration rehearsal. ORG-PR-002's external-email
validation remains an operator-blocked workstream running alongside, not
inside, that sprint.

---

## 21. Sprint changelog

| Change | Rationale |
| --- | --- |
| Added retention indexes to `packages/db/src/schema/auth.ts`; generated migration `0012` | One index per cleanup predicate that lacked one; additive and index-only. |
| Added four `RETENTION_*` values with hard floors to the config schema, surfaced as `config.retention`, exported `RETENTION_MAX_BATCH_SIZE` | Typed, validated, production-configurable retention with no dead configuration; the shared bound stops the CLI widening what the schema enforces. |
| Added `apps/api/src/maintenance/` (policy, executor, CLI surface, command) | One definition per category; a pure argument/report surface so the operator contract is testable without a database. |
| Added `dist/retention.mjs` to the API build | The maintenance command ships with the deployment it maintains. |
| Added `tooling/lib/pg-tools.sh` | Every PostgreSQL client tool runs from the repository's pinned image; shared by all three drills. |
| Added `tooling/db-backup.sh` | The one backup mechanism, exercised by the drill rather than duplicated in it. |
| Added `tooling/db-restore-drill.sh` (+ fixture and seed SQL) | Backup evidence is the restore, not the dump. |
| Added `tooling/db-pitr-drill.sh` | A logical restore is not PITR; this proves the difference. |
| Switched the drill's API-key hash from a committed literal to a run-time derivation | A working-tree secret scan flagged the constant; deriving it removes the literal and makes drift impossible (see §13). |
| Corrected the artifact-stage `security_events` assertion to match seeded ids | The drill's own 401 test legitimately writes an event; a bare table count was asserting the API did nothing rather than that retention deleted nothing. |
| Added `--` tolerance to the argument parser | `pnpm run <script> -- --apply` forwards a bare `--`. |
| Wired the restore drill into `ci.yml` (both jobs) and added `data-durability.yml` | The cheap drill gates every change; the expensive one validates the strategy. |
| Added `backups/`, `*.dump`, `*.dump.sha256` to `.gitignore` | A backup is a credential-grade artifact. |
| Wrote `backup-and-restore.md`, `pitr.md`, `retention.md`; reconciled 20 existing documents | Documentation evolves with the implementation and describes what the repository actually proves. |

### Refinement pass (final correctness review, same day)

| Change | Rationale |
| --- | --- |
| **Ended-session predicate now requires every referrer to be past its own cutoff** | The sweep handled only `refresh_tokens.session_id` and ignored `security_events.session_id`, so it would have failed with SQLSTATE 23503 on essentially every production run. The same change makes the active-refresh-token guarantee structural instead of dependent on a cross-module argument. See §13. |
| Added `ix_security_events_session_id` (migration `0012` regenerated, still additive and index-only) | The new referrer check would otherwise scan the platform's largest table once per candidate session. `0012` was uncommitted, so it was regenerated rather than stacked — the baseline stays one index migration. |
| Threaded a `RetentionRunContext` (`windows`, `now`) into the category interface | The session predicate needs the referring tables' cutoffs, not just its own. Only `expired_sessions` uses it. |
| Added 5 session-invariant regression tests + an inbound-FK coverage test | Hold-back and release for each referrer; proof a held-back session does not starve a batch; and a guard that fails CI if a future migration adds a reference the cleanup does not know about. |
| Added a shared-window assertion for sessions vs refresh tokens | The hold-back predicate's "past the same cutoff = independently eligible" equivalence is only true while both categories read `endedSessionDays`. |
| Added a MISSING-artifact rejection check to the restore drill | The corrupted-input path was proven; the missing-input path was not. Now asserts non-zero exit, the unopenable path named, no credential echoed, and a still-empty target. |
| Reconciled `audit_retention_days` explicitly, from source | Verified it is modeled, documented-as-non-enforced metadata in three places predating Sprint 25 — so the global window neither honours nor breaks a contract, and ORG-PR-015's closure stands. Recorded in §10, `retention.md`, and the findings register rather than left as an inference. |
| Documented that sessions are effectively retained until their security events age out | An honest consequence of the referential-integrity rule; better stated than hidden behind a nominal 90-day number. |
