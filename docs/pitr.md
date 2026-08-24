# Point-in-Time Recovery (PITR)

The PostgreSQL recovery strategy Orgistry can actually demonstrate, the drill
that demonstrates it, and the boundary between that evidence and a production
PITR capability.

Companion documents: [backup-and-restore.md](backup-and-restore.md) (logical
backup and restore), [retention.md](retention.md).

Finding: [ORG-PR-005](production-readiness/findings-register.md#org-pr-005).

---

## 1. Why a logical restore is not PITR

A `pg_dump`/`pg_restore` cycle recovers the state of the database **at the
moment the dump was taken**. Nothing else. If a destructive change lands
between two backups, a logical restore can only take you back to the earlier
backup — every legitimate write after it is lost.

Point-in-time recovery answers a different question: *restore the database to
an arbitrary instant*. That requires three things working together:

1. a **base backup** — a physical copy of the data directory;
2. **continuous WAL archiving** — every write-ahead-log segment retained from
   the base backup onward;
3. **archive recovery with a target** — replaying archived WAL on top of the
   base backup and stopping at a chosen `recovery_target_time`.

**Contract — the PITR evidence boundary.** Documentation that calls a logical
restore "PITR", or a drill that reaches its target without consuming archived
WAL, is false evidence. The drill below is built so neither can pass silently.

---

## 2. Strategy

Orgistry runs stock PostgreSQL 16 (`postgres:16.14-alpine`, pinned by digest
in `infra/docker-compose.yml`, `infra/compose.production-like.yml`, and
`tooling/lib/pg-tools.sh`). The repository-controlled PITR strategy is
therefore PostgreSQL-native:

| Element | Choice | Rationale |
| --- | --- | --- |
| Base backup | `pg_basebackup --format=plain --wal-method=stream --checkpoint=fast` | The standard physical backup. `--wal-method=stream` includes the WAL needed to reach a consistent point, so the base backup is self-consistent before any archive replay. |
| WAL archiving | `archive_mode=on` with `archive_command='test ! -f /wal_archive/%f && cp %p /wal_archive/%f'` | The documented safe form: it refuses to overwrite an existing segment and returns non-zero on failure, so a broken archive shows up in `pg_stat_archiver` instead of silently losing WAL. |
| WAL level | `wal_level=replica` | The minimum level that supports archiving and physical recovery. |
| Recovery | `recovery.signal` + `restore_command` + `recovery_target_time` + `recovery_target_action=promote` | The PostgreSQL 12+ archive-recovery mechanism. Settings are appended to the target's `postgresql.auto.conf`. |
| Target isolation | A separate container, a separate data volume, `archive_mode=off` | The recovery target must never write back into the source's WAL archive, and must never be confused with the source. |

The drill deliberately uses PostgreSQL's own mechanism rather than a wrapper
(pgBackRest, WAL-G, Barman). Those are better production tools, but adding one
here would make the evidence about the wrapper's configuration rather than
about the database's recoverability, and it would not be exercised by anything
this repository actually deploys.

---

## 3. The drill

```bash
pnpm drill:pitr            # full drill, cleans up afterwards
pnpm drill:pitr -- --keep  # leave containers and volumes for inspection
```

`tooling/db-pitr-drill.sh`. Requires Docker and a pnpm workspace install (the
drill applies the real Orgistry migration baseline, so the recovered database
is a real Orgistry database rather than an empty PostgreSQL instance).

### The twelve checks

The drill is built so that each numbered step can only pass for the right
reason:

| # | Step | What makes it real evidence |
| --- | --- | --- |
| 1 | Source starts with `wal_level=replica`, `archive_mode=on` | Read back from `SHOW`, not assumed from the command line. |
| 2 | Orgistry migration baseline applied | The recovered database must be a usable Orgistry database, not an empty one. |
| 3 | **WAL archival verified working** | `pg_switch_wal()`, then `pg_stat_archiver.archived_count > 0`, `last_failed_wal IS NULL`, **and** files present on the archive volume. Configuration alone is not accepted as evidence. |
| 4 | Base backup taken | `pg_basebackup` into a separate volume; `PG_VERSION` read back. |
| 5 | **Pre-target state written AFTER the base backup** | This is the crux. Those rows exist *only* in archived WAL, so recovering them is impossible without replaying the archive. |
| 6 | Recovery target recorded | `SELECT now()` after the pre-target commit, followed by a deliberate 2-second separation. |
| 7 | Destructive post-target state written | `DELETE FROM users`, `DROP TABLE projects`, a marker overwritten, and a post-target-only row inserted — the shape of a real incident. |
| 8 | Independent target initialized | A fresh volume seeded from the base backup, with `recovery.signal` and recovery settings; `archive_mode=off`. |
| 9 | Recovery runs and promotes | Polled until `pg_is_in_recovery()` returns false. |
| 10 | **Archived WAL proven consumed** | The target's log must contain `restored log file` **and** a recovery-stopping-at-target line. Without this a "PITR" could be nothing more than starting a base backup. |
| 11 | **State sits exactly at the target** | Pre-target marker and user present; post-target-only row absent; the `DELETE` undone (row count back to the pre-target value); the `DROP TABLE` undone. |
| 12 | Schema intact and usable | Every Orgistry table present, the migration ledger matching the source, the seeded role baseline intact, and a real relational read executed. |

### Recorded local evidence

Executed on 2026-08-24 (macOS, Docker 29.2.0, `postgres:16.14-alpine`):

```
== 1/12 Starting the SOURCE PostgreSQL with WAL archiving enabled
  ok  wal_level=replica archive_mode=on
== 2/12 Applying the Orgistry migration baseline to the source
  ok  applied migrations: 13
== 3/12 Verifying WAL archival is actually working
  ok  archived_count=2, 2 file(s) on the archive volume, no archive failures
== 4/12 Taking a base backup (pg_basebackup)
  ok  base backup taken (PG_VERSION 16)
== 5/12 Writing PRE-TARGET state (exists only in archived WAL)
  ok  pre-target rows committed (users=1)
== 6/12 Recording the recovery target time
  ok  recovery target: 2026-08-24 06:22:34.825498+00
== 7/12 Writing DESTRUCTIVE post-target state
  ok  post-target damage applied (users deleted, projects dropped, marker overwritten)
== 8/12 Initializing an independent TARGET from the base backup
  ok  target PGDATA seeded from the base backup with recovery.signal
== 9/12 Recovering to the target time
  ok  recovery completed and the target promoted
== 10/12 Proving archived WAL was consumed
  ok  the target restored WAL segments from the archive
  ok  the target log records stopping at the recovery target
== 11/12 Verifying the recovered state sits exactly at the target
  ok  pre-target marker recovered = pre-target
  ok  pre-target user recovered = 1
  ok  user rows at the target time (post-target DELETE undone) = 1
  ok  post-target-only row absent = 0
  ok  post-target DROP TABLE undone = t
== 12/12 Verifying the recovered Orgistry schema is intact and usable
  ok  migration metadata intact = 13
  ok  seeded role baseline intact = 4
  ok  relational read over recovered data = 23
== PITR drill PASSED
```

**Status: PITR VERIFIED** — locally, on the PostgreSQL version this repository
runs, against a database carrying the real Orgistry schema. See §6 for what
that does and does not license.

### Recorded remote evidence (`Data durability` on `main`)

The same drill was dispatched on GitHub Actions after Sprint 25 merged, so the
evidence is not confined to one developer's machine:

| Field | Value |
| --- | --- |
| Workflow | `Data durability` (`.github/workflows/data-durability.yml`) |
| Branch | `main` · Event `workflow_dispatch` |
| Run | [32702918307](https://github.com/DanielRosenberg00/Orgistry/actions/runs/32702918307) |
| Job | `PITR drill (base backup + WAL archive + recovery target)` — `97357955641` |
| Result | **PASS**, 42 s |

Its behavioral assertions match the local transcript, with the boundary proven
in both directions on a clean runner:

```
ok  archived_count=2, 2 file(s) on the archive volume, no archive failures
ok  recovery target: 2026-08-24 07:45:25.13389+00
ok  the target restored WAL segments from the archive
ok  the target log records stopping at the recovery target
ok  user rows at the target time (post-target DELETE undone) = 1
ok  post-target-only row absent = 0
ok  post-target DROP TABLE undone = t
ok  migration metadata intact = 13
== PITR drill PASSED
```

---

## 4. Why PITR is not in normal CI

The drill starts two PostgreSQL servers, enables archiving, takes a base
backup, and then **waits** for archive recovery to reach a target and promote.
That wait is roughly a minute of mostly-idle time per run and cannot be
parallelised away.

The split:

- **Every push and pull request** (`.github/workflows/ci.yml`) runs the logical
  backup/restore drill. That is what a code change — a schema edit, a migration,
  a tooling change — can realistically break.
- **Manual and weekly** (`.github/workflows/data-durability.yml`) runs the PITR
  drill. It validates the recovery *strategy*, which changes only when the
  tooling, the pinned PostgreSQL image, or the migration baseline changes.

Run it on demand before merging any change to `tooling/db-pitr-drill.sh`,
`tooling/lib/pg-tools.sh`, the pinned PostgreSQL image, or the migration
baseline:

```
GitHub → Actions → "Data durability" → Run workflow
```

or locally with `pnpm drill:pitr`.

The measured cost of the first remote run was **42 s**, so the tradeoff is
smaller than originally estimated. It is still kept off the per-PR path
deliberately — a gate earns its place by how often the thing it guards changes,
and `ci.yml` already runs three jobs on every pull request. The residual is
real and is recorded as such: a PITR-tooling change merged without a dispatch
is not caught until the weekly run.

---

## 5. Runbooks

### Perform a PITR recovery

**Labelled: rehearsed locally by `tooling/db-pitr-drill.sh`; NOT rehearsed
against real infrastructure.** The steps below are exactly what the drill
executes.

1. **Stop writing to the damaged database.** Take the application out of
   rotation. PITR recovers to a point in the past; writes accepted after that
   point will be lost, and writes accepted *during* the recovery decision make
   the target time harder to choose.
2. **Choose the recovery target time** (see below). Record it in UTC with a
   timezone offset, e.g. `2026-08-24 06:22:34.825498+00`.
3. **Provision a NEW server.** Never recover over the damaged data directory —
   the damaged one is evidence, and a failed recovery attempt on it leaves you
   with nothing.
4. **Seed the new data directory from the most recent base backup taken before
   the target time.** Ownership `postgres:postgres`, mode `700`.
5. **Append recovery settings** to `postgresql.auto.conf`:

   ```
   restore_command = 'cp /wal_archive/%f %p'
   recovery_target_time = '<target>'
   recovery_target_action = 'promote'
   archive_mode = 'off'
   ```

6. **Create `recovery.signal`** in the data directory. Without it the server
   starts normally and replays nothing.
7. **Start the server** with the WAL archive mounted read-only.
8. **Watch the log.** You must see `restored log file` lines and a
   recovery-stopping line. If you see neither, the archive is not reachable and
   the server has come up as a plain base-backup copy — stop and fix the
   archive before trusting anything it contains.
9. **Verify before cutting over** (see below).
10. **Cut over** by repointing `DATABASE_URL` at the recovered server and
    returning the application to rotation.

### Choose a PITR recovery target time

- **Aim just before the damage, not just after the last good write.** Every
  second you add risks including the destructive statement; every second you
  remove discards legitimate work. When in doubt, recover earlier — you can
  recover a second time to a later target, but you cannot un-apply a
  destructive statement you replayed.
- **Find the boundary from the audit trail.** `security_events.created_at`
  records authenticated mutations; the audit read path
  ([audit-log.md](audit-log.md)) narrows it to one organization. For a bad
  migration, use the deployment timestamp.
- **Use an explicit timezone.** `recovery_target_time` is interpreted in the
  server's timezone if you omit one, which is exactly the kind of ambiguity an
  incident does not need.
- **Confirm the target is inside the archive window.** The target must be at or
  after the end of the base backup you are recovering from, and every WAL
  segment between them must exist in the archive.

### Validate a PITR recovery

Before cutting over, on the recovered server:

```bash
psql "$RECOVERED_URL" -c 'SELECT pg_is_in_recovery();'                     -- must be f
psql "$RECOVERED_URL" -c 'SELECT count(*) FROM drizzle.__drizzle_migrations;'
psql "$RECOVERED_URL" -c "SELECT count(*) FROM roles WHERE key IN ('owner','admin','member','viewer');"
psql "$RECOVERED_URL" -c "SELECT to_regclass('public.users') IS NOT NULL;"
```

Then check the boundary in both directions — this is the part that is easy to
skip and the only part that proves the recovery landed where you intended:

- a record you know existed **before** the target is present;
- a record you know was created **after** the target is absent;
- the destructive change you were recovering from is undone.

Finally, prove the application can use it:

```bash
DATABASE_URL="$RECOVERED_URL" pnpm db:migrate     # must be a no-op
```

or, with the deployable artifact, boot it against the recovered database and
check `/health` and `/ready` — the pattern
`tooling/db-restore-drill.sh --with-artifact` automates for logical restores.

### Investigate a failed PITR

| Symptom | Likely cause |
| --- | --- |
| Server starts but no `restored log file` lines | `recovery.signal` missing, or `restore_command` cannot see the archive (path, mount, permissions). |
| `requested recovery stop point is before consistent recovery point` | The target time is earlier than the end of the base backup. Use an older base backup. |
| Recovery never promotes | The target time is later than the last archived WAL — the segment covering it was never archived. Check `pg_stat_archiver` on the source. |
| `could not restore file ... from archive` mid-recovery | A gap in the archive. Every segment from the base backup to the target must be present; a gap makes recovery past it impossible. |
| Recovered data includes the damage | The target time was after the destructive statement. Recover again to an earlier target. |

---

## 6. What this proves — and what it does not

Three statements, kept distinct — conflating them is the specific way PITR
documentation becomes dishonest:

```
LOCAL PITR VERIFIED                        — pnpm drill:pitr
REMOTE REPOSITORY-CONTROLLED PITR VERIFIED — Data durability run 32702918307 on main
PRODUCTION PITR NOT VERIFIED               — nothing below is in place
```

**Proven, repository-controlled:**

- Orgistry's schema and data recover correctly through PostgreSQL-native PITR.
- WAL archiving works and archived WAL is genuinely consumed during recovery.
- A recovery target boundary is honoured in both directions.
- The recovered database is schema-valid, migration-consistent, and queryable.
- The procedure above is executable and has been executed — on a developer
  machine **and** on GitHub Actions against `main`, so it does not depend on
  one host's local state.

The remote run is **not** a production recovery rehearsal. It recovers a
fixture-sized database inside throwaway containers the workflow creates and
destroys. No production database, no continuous archive, no provider recovery
window, and no recovery-time measurement is involved.

**Not proven — deployment- and provider-dependent:**

- **No continuous WAL archiving runs anywhere.** The drill enables archiving
  for its own lifetime. No long-lived Orgistry database archives WAL, because
  no long-lived Orgistry database exists (**ORG-PR-001**, open).
- **No durable archive storage.** The drill archives to a throwaway Docker
  volume it deletes afterwards. Production needs durable, encrypted, retained,
  ideally off-host WAL storage.
- **No provider-managed PITR.** A managed PostgreSQL's own continuous backup
  and PITR window has not been configured or evidenced.
- **No measured RPO or RTO.** The drill recovers a fixture-sized database in
  seconds. That number tells you nothing about a production-sized recovery, and
  no recovery objective has been validated against real infrastructure
  ([production-target.md](production-readiness/production-target.md)).
- **No monitoring of archive health.** In production, a silently failing
  `archive_command` is the classic way PITR stops existing without anyone
  noticing. Alerting on `pg_stat_archiver.last_failed_time` is required and is
  out of scope here (**ORG-PR-016** and monitoring, open).

**PITR capability is verified. Production PITR is not.**
[ORG-PR-005](production-readiness/findings-register.md#org-pr-005) therefore
stays **OPEN**: its repository-controlled half is complete and evidenced, and
it remains a production blocker on the deployment-dependent half above, which
depends on ORG-PR-001. The finding entry records exactly which half is which.
