# Sprint 28 Closing Artifact — Backup and Recovery Operations

```
Status: COMPLETE
Sprint 28 DoD met:                   YES
ORG-PR-005:                          CLOSED
Off-host storage:                    PROVEN — DigitalOcean Spaces (fra1)
Real-target logical restore:         PASSED   (28 s / 33 s)
Real-target PITR:                    PASSED   (10 s)
Staging ready:                       NO
Production ready:                    NO
```

**Date:** 2026-08-27 · **Target:** `orgistry-staging-01` (DigitalOcean FRA1,
`linux/amd64`) · **Finding:** [ORG-PR-005](findings-register.md#org-pr-005)

This is the **official final Sprint 28 artifact**, finalized in place from the
living evidence package it has been since the sprint began. There is no second
Sprint 28 artifact and none should be created.

---

## 1. Executive summary

Sprint 28 set out to connect the repository-controlled backup and PITR
capability proven in Sprint 25 to the durable external staging-like target
proven in Sprint 27, and to reconcile ORG-PR-005 honestly. **It did.**

The deployed PostgreSQL now archives WAL continuously. Scheduled systemd timers
take encrypted logical backups, ship WAL, check protection, and apply an
artifact lifecycle — all writing to **DigitalOcean Spaces**, a store outside the
droplet's failure boundary. A least-privilege role reads the database and can
write nothing. Backups are encrypted **on the host, before upload**, with a key
the provider never sees.

Both recovery rehearsals were executed **fetching their artifacts back out of
that Space**. A logical backup taken from the deployed database was retrieved,
decrypted, digest-verified, restored into an isolated PostgreSQL, and driven
through the packaged migration entrypoint and the packaged API to `/ready`. A
point-in-time recovery to a chosen timestamp replayed a base backup and 12 WAL
segments the deployed database itself produced, archived, and shipped — verified
in both directions, with archived-WAL consumption asserted from the recovery
log. RPO and RTO were measured, not estimated.

**Real external execution found what no local rehearsal could**, which is the
sprint's most valuable output after the closure itself. An incomplete installed
secret was correctly isolated to credential configuration rather than repository
SigV4 by an independent AWS CLI baseline, so **no object-store code was changed
for it**. Two genuine defects were then found and fixed: a WAL-freshness check
that reported an *idle* database as unhealthy — which through the deployment
protection preflight would have refused deployments to a protected environment —
and the complete absence of transport retry against a Spaces endpoint that
refuses **52% of raw TCP connects**.

**ORG-PR-005 is CLOSED.** Staging readiness and production readiness both remain
**NO**, for reasons this finding never covered.

## 2. Sprint objective

Turn backup *capability* into backup *operations* against the real target, and
reconcile ORG-PR-005 on evidence rather than assertion.

Sprint 28 was explicitly **not** authorised to deliver: production launch or
traffic, DNS cutover, email-provider closure, SPF/DKIM/DMARC, a secrets-manager
platform, automated general-purpose rotation, an observability or alerting
platform, distributed tracing, Kubernetes, multi-region, an HA or managed
database, application features, or any auth/authorization/outbox change. **None
of those were implemented.** See §17.

## 3. The four evidence classes

Kept apart everywhere, because conflating them is the specific way a backup
story becomes dishonest.

| Class | Claim | Status |
| --- | --- | --- |
| **Repository-controlled recovery proof** | the code can back up, restore, and recover to a point in time | **Proven.** Sprint 25 drills unchanged and passing; 86 offline tests over encryption, request signing, transport retry, configuration, catalog, and health rules |
| **Same-host S3 mechanism validation** | the storage code path works end to end | **Proven, and then retired.** A throwaway MinIO on the source host proved the mechanism before real credentials existed. It was **never protection** and has been removed (§16) |
| **Real staging-like off-host evidence** | the deployed database is really backed up to DigitalOcean Spaces and has really been recovered from it | **Proven.** §7–§13 |
| **Production recovery guarantee** | a production database is protected to a measured objective | **Does not exist.** No production database exists |

## 4. Staging-like backup architecture

```text
orgistry-infra-postgres-1  (PostgreSQL 16.14-alpine, named volume, staging-like)
  |
  |-- pg_dump  (role: orgistry_backup, read-only)
  |     -> AES-256-GCM client-side -> DigitalOcean Spaces -> catalog + run state
  |     orgistry-backup.timer, daily 02:30 UTC ±10 min, Persistent=true
  |
  |-- pg_basebackup (role: orgistry_backup, REPLICATION)
  |     -> AES-256-GCM client-side -> DigitalOcean Spaces      (the PITR basis)
  |
  '-- archive_command -> /opt/orgistry/data/wal-archive   (local spool)
        -> AES-256-GCM client-side -> DigitalOcean Spaces
        orgistry-wal-ship.timer, every 2 minutes

  orgistry-backup-health.timer  hourly   backup health + archive health
  orgistry-backup-prune.timer   weekly   artifact lifecycle
```

| Element | Decision |
| --- | --- |
| PostgreSQL source | the **deployed** `orgistry-infra-postgres-1`, unchanged in identity or persistence model |
| Backup execution location | the deployment host, as the operator account, via systemd **user** units |
| Backup schedule | daily logical, 2-minute WAL shipping, hourly health, weekly lifecycle |
| Off-host storage | **DigitalOcean Spaces**, `orgistry-staging-backups`, `fra1` (§5) |
| Encryption | client-side AES-256-GCM before upload (§6) |
| WAL archival | `archive_mode=on` to a bind-mounted local spool, drained off-host by a timer (§8) |
| Restore target model | a throwaway container the rehearsal creates and destroys; never the live database (§10) |
| Retention | 30 days / min 7 logical; 8 days WAL, never past the oldest surviving base backup (§9) |
| Credential model | three separate mode-0600 files; least-privilege database role (§7) |
| Operational owner | the single maintainer operating `orgistry-staging-01` |
| Health / failure visibility | non-zero exits, failed systemd units, the journal — **no alert routing** (§12) |
| Production gaps | §18 |

**PostgreSQL remains the durable source of truth. Redis remains non-durable**,
unchanged from [backup-and-restore.md](../backup-and-restore.md) §1.

**Why no backup platform.** `pgBackRest`, `restic`, and WAL-G are better
production tools. Adopting one would add a supply chain the release process does
not gate, introduce a second recovery architecture beside Sprint 25's, and break
the property Sprint 27 established — that the deployment host carries no npm
dependency closure and cannot build the application. The implementation is
instead a handful of focused modules using only Node built-ins, reusing
`tooling/db-backup.sh` unchanged as the backup path.

## 5. Storage-target decision

| | |
| --- | --- |
| Provider / type | **DigitalOcean Spaces**, S3-compatible object storage |
| Bucket | `orgistry-staging-backups` |
| Region | `fra1` |
| Endpoint | `https://fra1.digitaloceanspaces.com` |
| Prefix | `orgistry/staging-like` |
| Addressing | **path-style** — `https://fra1.digitaloceanspaces.com/<bucket>/<key>`, which Spaces accepts; no provider-specific addressing was required |
| Reason for selection | same provider as the droplet (no new account, no new billing relationship), S3-compatible so the client stays provider-neutral |
| **Off-host property** | a separate service with its own storage and lifecycle. Destroying, rebuilding, or losing `orgistry-staging-01` does not touch it |
| **Host-loss survival** | proven by construction and exercised: both rehearsals recovered using **only** artifacts fetched from the Space |
| Encryption behaviour | client-side AES-256-GCM before upload (§6). Any provider-side encryption is additional and is **not** relied on |
| Access model | one Spaces access key pair, secret in its own mode-0600 file (§7) |
| Retention / lifecycle | tool-side (§9). No provider-side lifecycle rule is configured — none is claimed |
| Cost note | WAL segments are 16 MiB and stored uncompressed by PostgreSQL (`wal_compression` compresses full-page images *inside* a segment, not the file). With `archive_timeout=300s` a busy database can produce ~4.6 GB/day worst case; a provider lifecycle rule is worth adding as a backstop to tool-side pruning |

### Regional resilience — recorded, not claimed

The Space and the droplet are **both in `fra1`**. This **is** off-host storage
and survives loss or deletion of `orgistry-staging-01`, which is what
ORG-PR-005 required. It is **not** evidence of resilience against a DigitalOcean
`fra1` regional outage, and **no multi-region recovery is claimed**. There is
one bucket and no second provider, so the backups have no redundancy beyond
DigitalOcean's own. Recorded as a residual limitation in §18.

### Provider endpoint behaviour worth knowing

On this droplet `fra1.digitaloceanspaces.com` resolves — through the local
resolver, `1.1.1.1`, and `8.8.8.8` alike — to `10.114.15.254`, a **VPC-internal**
address reached over `eth1`. That endpoint refuses a large share of TCP
connects. Measured with a raw socket, entirely outside this codebase:

```
90 samples, one every 0.5s:  ok 43, refused 47  (52%)
refusal bursts (consecutive): [3,3,1,1,6,2,5,4,1,1,1,1,2,2,3,4,2,1,1,1,2]
longest burst: 6 samples = 3.0 seconds
```

There is no alternate public endpoint to prefer. The client therefore retries
transport failures for a bounded window sized from the burst length (§21,
defect 2). After that fix, **20 of 20 consecutive `verify-store` runs succeeded**
at ~1 s each.

## 6. Encryption model

| Property | Value |
| --- | --- |
| Algorithm | AES-256-GCM (authenticated) |
| Applied | client-side, on the source host, **before upload** |
| Key | 32 bytes, generated **on the host** with `openssl rand -hex 32`, mode 0600, never transmitted, never printed |
| Key identity in evidence | HMAC-SHA256 fingerprint, 16 hex — `b184c72b6e8f5a24` |
| Header | authenticated as AES-GCM AAD; carries artifact name, byte count, and the plaintext SHA-256 recorded at backup time |
| Integrity on restore | GCM tag **and** the header's plaintext digest, both verified |
| Decryption proven | yes — both rehearsals decrypt Spaces-fetched artifacts before restoring (§10, §11) |
| Format | `tooling/lib/backup-crypto.mjs`, magic `ORGBK1` |

**Storage-side and client-side encryption are not equivalent and this repository
never says they are.** A provider's encryption at rest decrypts transparently
for every authorised bucket reader; an Orgistry logical backup carries every
user, organization, and audit row plus password, refresh-token, and API-key
hashes. It is encrypted before it leaves the host, with a key DigitalOcean never
sees.

**Failure modes are proven loud** (`tooling/backup-crypto.test.ts`, 17 tests): a
wrong key is refused by identity before any decryption work; a truncated
artifact, a flipped ciphertext bit, and a **same-length header forgery** all
fail; a plaintext whose digest differs from the backup-time value is rejected
even if it decrypted; and the plaintext is not recognisable in the artifact.

**Key-loss risk.** No escrow, no key hierarchy, no re-wrapping. Losing the key
loses every backup encrypted with it.

**Key-rotation limitation.** Manual. The header records which key wrote each
artifact, so a mixed-key store is diagnosable, but nothing rotates it. **This
closes nothing in ORG-PR-006** — and enlarges it, because the key is a new
unrecoverable-loss liability.

## 7. Credential model

| Operation | Identity | Privileges | Location |
| --- | --- | --- | --- |
| Database read for backup | `orgistry_backup` | `LOGIN`, `REPLICATION`, `pg_read_all_data` — **not** superuser, `CREATEROLE`, or `CREATEDB` | `/opt/orgistry/config/backup-database-url` (0600) |
| Off-host write | Spaces access key | write + read + delete in the bucket | id in `backup.env`; secret in `/opt/orgistry/config/backup-store-secret` (0600) |
| Off-host read / restore | **the same key** | — | as above |

Re-verified at closure:

```
orgistry_backup: super=false createrole=false createdb=false repl=true
granted roles: pg_read_all_data
write attempt   -> ERROR: permission denied for table app_meta
```

`REPLICATION` is required by `pg_basebackup` and is admitted by a `pg_hba` rule
scoped to that single role requiring `scram-sha-256` — no wildcard role, no
`trust`.

**Identities are shared where they are shared, and it is stated.** One
object-store key performs both write and restore reads. A read-only restore
identity would be better and needs provider-side bucket policy; the delete
privilege that pruning needs is the one worth constraining first.

**How scheduled jobs receive credentials.** systemd user units set
`ORGISTRY_BACKUP_CONFIG`; the tooling reads each secret from its own file and
**refuses to start if any is group- or world-readable**. No secret is ever a
command-line argument.

**Rotation and its limits.** Database password: one `ALTER ROLE`, one file
write. Object-store key: one file write, then `verify-store`. Encryption key:
generate, then re-encrypt or age out old artifacts. All manual. **No part of
this closes ORG-PR-006.**

## 8. WAL archival evidence

Applied by `tooling/pg-enable-wal-archiving.sh` to the **deployed** database:

| Setting | Value |
| --- | --- |
| `archive_mode` | `on` (required a restart; ledger verified 13 before and after) |
| `archive_command` | `test ! -f /wal-archive/%f && cp %p /wal-archive/%f && chmod 640 /wal-archive/%f` |
| `archive_timeout` | `300s` |
| `wal_compression` | `on` (`pglz`) |
| `wal_level` | `replica` (unchanged) |

Applied with `ALTER SYSTEM`, so they live in `postgresql.auto.conf` **inside the
data volume** and survive a container recreate. The spool is a bind mount
(`/opt/orgistry/data/wal-archive` → `/wal-archive`), owned `70:1000` mode `2770`
(setgid) so PostgreSQL can write and the host-side shipper can read and delete —
all through `docker exec -u 0`, needing no host root.

Observed at closure (a **point-in-time snapshot** — the archive keeps growing,
so the segment count and range advance after this reading; `failed_count` is the
value that must stay at zero):

```
2026-08-27T21:41Z
archive_mode = on   archive_timeout = 5min   wal_compression = pglz
archived_count = 44   failed_count = 0
remote WAL: 17 segments, 000000010000000000000017 .. 000000010000000000000026
```

Every archived segment was produced by the deployed database. **No CI-generated
or locally generated WAL supports any claim here.**

**Why the spool exists.** `archive_command` never touches the network. If
archiving had to reach object storage synchronously, a provider outage — and
this endpoint refuses half its connects — would stall WAL recycling and
eventually fill the data volume: a backup feature taking the database down. The
cost is that the recovery point lags by one shipping interval, which is exactly
the RPO in §13.

**Topology change made, and its blast radius.** One line added to the operator's
backing-services compose file (the WAL spool bind mount); the PostgreSQL
container recreated once and restarted once. A verified logical backup was taken
first. The migration ledger read 13 before and 13 after; the API, `/ready`, and
both public HTTPS origins returned 200 afterwards. The data volume was never
touched.

## 9. Backup artifact lifecycle

Three retentions, deliberately distinct:

```text
application/table retention   docs/retention.md — expired PRODUCT rows. Unrelated to recoverability.
logical backup retention      30 days, and never fewer than the newest 7.
WAL retention                 8 days, and never past the oldest surviving base backup.
```

Sprint 25's application-table cleanup is **not** backup artifact retention and
is not used as such anywhere.

Exercised against the real Space at closure:

```
would delete 0 WAL segment(s) outside the retained recovery window
Lifecycle: always keep the newest 7 logical backups and the newest base backup;
beyond that keep 30 days of backups and 8 days of WAL, never past the oldest
surviving base backup.
```

That `0` **is** the safeguard working: two logical backups exist against a
minimum of seven, so nothing is eligible regardless of age, and the closing
evidence could not be pruned away.

- Local host copies: newest **2** backup sets retained after a successful
  upload ("removed 1 older local backup set(s)" observed).
- Deletion is logged by artifact name and timestamp.
- `prune --dry-run` reports and deletes nothing.
- The newest N logical backups and the newest base backup are never pruned.
- Provider-side lifecycle rules: **not configured**, and none is claimed.

## 10. Real-target logical restore rehearsal — **PASSED (from DigitalOcean Spaces)**

```
runId              20260827T205907Z
started            2026-08-27T20:59:08Z    finished 2026-08-27T20:59:41Z
source artifact    orgistry-20260827T205811Z-scheduled.dump
  taken            2026-08-27T20:58:16Z  from staging-like/orgistry-staging-01
  object           orgistry/staging-like/logical/…-scheduled.dump.enc  (DigitalOcean Spaces)
  encryption key   b184c72b6e8f5a24
  sha256           5152adf405039f8b12671c5a6b04403f33c677bf60f0e45c0f7a1735f2dde2d5
  bytes            54143        applied migrations 13
restore target     orgistry-restore-target-20260827T205907Z  (created and destroyed by the run)
```

Chain executed: **deployed database → logical backup → client-side encryption →
upload to Spaces → retrieval from Spaces → decryption → checksum verification
against the digest recorded at backup time → clean isolated PostgreSQL asserted
empty → `pg_restore --exit-on-error` → verification → packaged migration →
packaged API.**

| Verification | Result |
| --- | --- |
| Retrieved artifact digest matches the catalog | **PASS** |
| Target had 0 public tables before restoring | **PASS** |
| All 18 Orgistry tables present | **PASS** |
| Drizzle migration ledger | **13** |
| Reference data (roles 4, plans 3, permissions 23, grants 56) | **PASS** |
| Tenant rows: organization, 2 users, owner→org→plan→project join (2) | **PASS** |
| API-key hash metadata byte-identical | **PASS** |
| Packaged migration entrypoint re-run | **no-op**, ledger still 13 |
| Packaged API `/health` and `/ready` against the restored database | **200 / 200** |

Durations: off-host retrieval + decrypt 1 s · `pg_restore` 2 s · schema and data
verification 12 s · packaged migration 1 s · API boot to `/ready` 3 s.

**RTO — logical restore: 28 s** (to a verified restored database).
**RTO — service restore: 33 s** (through packaged API `/ready`).

No backup content appears in the evidence record — identities, digests, counts,
and durations only. Staging was never a restore target.

## 11. Real-target PITR rehearsal — **PASSED (from DigitalOcean Spaces)**

```
runId                 20260827T210929Z
source                orgistry-infra-postgres-1   archive_mode on
  archived_count      35 -> 39     archive failures during the rehearsal: 0
recovery basis        orgistry-base-20260827T210930Z.tar.gz   (taken 21:09:30Z)
  object              orgistry/staging-like/basebackup/…tar.gz.enc  (DigitalOcean Spaces)
  WAL range start     00000001000000000000001F
  WAL retrieved       12 segments, 000000010000000000000017 .. 000000010000000000000021
recovery target time  2026-08-27 21:09:36.309411+00
recovery target       orgistry-pitr-target-20260827T210929Z  (created and destroyed by the run)
```

| Required proof | Result |
| --- | --- |
| A pre-target marker state exists | `pitr_rehearsal_marker = pre-target-20260827T210929Z` — **present after recovery** |
| A post-target unwanted state exists before recovery | second marker written, and `proj_restore_drill_beta` **deleted** on the live database |
| Recovery targets a timestamp between them | `21:09:36.309411+00` |
| Recovered target contains the pre-target state | **PASS** |
| Recovered target excludes the post-target state | post-target-only row count **0** — **PASS** |
| Post-target `DELETE` undone | project rows **2** — **PASS** |
| Archived WAL genuinely consumed | recovery log contains `restored log file` — **PASS** |
| Recovery stopped at the target | recovery-stopping line present — **PASS** |
| Schema and migration metadata usable | all 18 tables, ledger **13** — **PASS** |
| No archive failure during the run | `failed_count` unchanged — **PASS** |

Durations: retrieval + decrypt of the base backup and 12 WAL segments **from
Spaces** 5 s · archive recovery and promotion 5 s. **RTO — PITR: 10 s.**

**Effective recovery window:** from the oldest retained base backup forward
through an unbroken WAL chain, bounded by 8-day WAL retention and never pruned
past the oldest surviving base backup.

**Live-database safety.** The live database was never a recovery target;
recovery ran in a container on its own network and volume with
`archive_mode = off`. The deleted rehearsal row was re-inserted on exit —
post-run state `projects=2 users=2 migrations=13 rehearsal_markers=0`,
`beta_present=1`. Zero leftover containers or volumes. `/ready` 200 locally and
over public HTTPS afterwards.

## 12. Scheduler, catalog, and health evidence

### Scheduler

All four units resolve to `/opt/orgistry/config/backup.env`; **none references
the retired mechanism-check config**. Lingering enabled; all four timers
enabled; user units confirmed able to reach the Docker daemon.

A **systemd-executed** logical backup to DigitalOcean Spaces:

```
Starting orgistry-backup.service - Orgistry logical database backup to encrypted off-host storage...
Backing up to /opt/orgistry/backups/orgistry-20260827T205811Z-scheduled.dump
Backup complete: 54143 bytes, 13 applied migrations, server 16.14
Stored orgistry/staging-like/logical/orgistry-20260827T205811Z-scheduled.dump.enc (54423 bytes encrypted)
Local lifecycle: removed 1 older local backup set(s)
Finished orgistry-backup.service.
```

A **timer-triggered** WAL shipment:

```
Starting orgistry-wal-ship.service ...
Shipped 3 WAL segment(s) off-host.
Finished orgistry-wal-ship.service.
```

Remote existence independently confirmed by `HEAD`:

```
present  orgistry/staging-like/logical/orgistry-20260827T205811Z-scheduled.dump.enc        54423 bytes
present  orgistry/staging-like/logical/orgistry-20260827T205811Z-scheduled.dump.meta.json   1161 bytes
```

`systemctl --user list-units --failed` → **0 units**.

### Catalog (derived from the real Space)

A **point-in-time snapshot** taken at closure; logical backups and WAL continue
to accrue on schedule after it.

```
Backup catalog — orgistry-staging-backups/orgistry/staging-like (https://fra1.digitaloceanspaces.com)

Logical backups (2)
  2026-08-27T20:58:16Z  orgistry-20260827T205811Z-scheduled.dump
      source=staging-like/orgistry-staging-01 db=orgistry pg=16.14 migrations=13
      upload=uploaded encrypted=yes(key b184c72b6e8f5a24)
      sha256=5152adf40503… bytes=54143 storedBytes=54423 expires=2026-09-26T20:58:16Z
  2026-08-27T20:46:27Z  orgistry-20260827T204623Z-scheduled.dump  (…)

Base backups (PITR basis) (1)
  2026-08-27T21:09:30Z  orgistry-base-20260827T210930Z.tar.gz
      sha256=7b5659c13244… bytes=4294049 storedBytes=4294328 expires=2026-09-26T21:09:30Z

Archived WAL
  segments=16 bytes=251662864
  range=000000010000000000000017 .. 000000010000000000000025
```

*(Re-read at 21:41Z during the closing review: 17 segments,
`…0017 .. …0026` — the archive advancing on schedule, as expected.)*

### Health (systemd-executed, exit 0)

```
Backup health
  [PASS] logical backup present — 2 recovery point(s) off-host
  [PASS] latest backup is fresh — …-scheduled.dump is 0.0h old (limit 26h)
  [PASS] latest backup is encrypted — key b184c72b6e8f5a24
  [PASS] latest backup has an integrity digest — sha256 recorded at backup time
  [PASS] no interrupted uploads — every metadata document has its artifact
  [PASS] scheduled run recorded — last run succeeded at 2026-08-27T20:58:18Z
  => HEALTHY (0 warning(s))

WAL archive health
  [PASS] archive_mode — on
  [PASS] WAL segments archived — 35 archived
  [PASS] archive_command not failing — no archiver failures recorded
  [PASS] recent WAL archived locally — no WAL pending — the database has written
         nothing since 00000001000000000000001E was archived 1.1m ago
  [PASS] WAL spool drained — no segments awaiting off-host shipment
  [PASS] WAL present off-host — 8 segment(s), …0017 .. …001E
  [PASS] off-host WAL is current — newest off-host segment stored 0.1m ago; no WAL pending
  => HEALTHY (0 warning(s))
```

### Alert boundary — read before relying on it

| Question | Answer |
| --- | --- |
| Where are the logs? | `journalctl --user -u orgistry-*` |
| How does an operator notice a failure? | `systemctl --user list-units --failed`, or the hourly health unit going red |
| How often is protection checked? | hourly |
| What pages someone? | **Nothing.** |

This is backup failure **visibility**, not alerting. **ORG-PR-007 remains open**
and nothing here is production-grade alerting. The integration point for a
future alerting system is the health unit's exit code.

## 13. Recovery objectives

```
staging-like operational measurement — not a production guarantee
```

### RPO

| Component | Value | Kind |
| --- | --- | --- |
| `archive_timeout` | 300 s | configured — the longest a write can sit in an unsealed segment |
| WAL shipping interval | 120 s | configured — `orgistry-wal-ship.timer` |
| Upload | ~2 s | observed |
| **Configured upper bound** | **≈ 7.0 minutes** | sum of the above |
| **Observed — shipping path only** | **72 s, 132 s, 130 s** (three runs) | measured commit → object present in Spaces, **with the segment switch forced**; bounded by the 120 s timer as designed |

**The observed figures are not a measured RPO and must not be quoted as one.**
Forcing the switch removes the `archive_timeout` component entirely, so these
three runs exercise and time the **shipping path** — seal → encrypt → upload →
visible in Spaces — and say nothing about the worst case, where a write sits in
an unsealed segment for up to 300 s before shipping even begins. The two numbers
answer different questions: the **configured upper bound (≈ 7.0 min)** is what to
plan a recovery around; the **observed shipping latency (72–132 s)** is evidence
that the shipping half of that bound behaves as designed. The worst-case
`archive_timeout` component has **not** been independently measured.

**On an idle database the recoverable point stops advancing, and that is
correct.** `archive_timeout` forces a switch only when something was written; a
database taking no writes has nothing to archive and is fully recoverable to its
current state. The health checks account for this explicitly rather than
reporting a healthy environment as stale (§21, defect 1).

### RTO

| Measurement | Value | Boundary |
| --- | --- | --- |
| **Logical restore** | **28 s** | off-host retrieval → decrypt → digest verification → `pg_restore` → schema, migration ledger, and representative data verified |
| **Service restore** | **33 s** | the same, **plus** the packaged migration entrypoint and the packaged API answering `/ready` against the restored database |
| **Point-in-time recovery** | **10 s** | retrieval and decryption of the base backup and 12 WAL segments from Spaces → archive recovery → promotion → verification |

**Two logical boundaries are published together on purpose.** One ends at a
verified database (what a DBA calls recovered), the other at a serving API (what
a user calls recovered). Quoting one when you mean the other is how recovery
estimates go wrong.

**Limitations.** The database is ~8 MB with 13 migrations and a handful of
synthetic rows; both RTOs are dominated by fixed costs (container start, image
load, verification) and **do not extrapolate**. The RPO upper bound is
*configured*, not stress-tested under sustained write load. None of these is an
SLA.

## 14. Deployment integration

Sprint 26/27 mechanics were **refined, not redesigned**. The immutable-release,
manifest, migrate-once, smoke, and rollback model is untouched.

Stage 6, "Backup protection preflight", runs `health` and `wal-health` before
the pre-deployment backup and well before migrations. Revalidated at closure
against the DigitalOcean-backed programme:

| Path | Result |
| --- | --- |
| **Abort** — configuration naming a non-existent bucket | **PASS.** Stopped at stage 6: *"the environment is not currently protected; the deployment was ABORTED before migrations and the target is unchanged"*. Migration ledger **13 before and after**, evidence records **4 before and after**. Nothing migrated, no record written |
| **Verified** — real Spaces-backed protection | **PASS.** `protection verified`, backup taken `21:24:56Z`, migration applied, head `0012_shocking_warbound` verified, running digests verified |
| Host-side smoke | **PASS — 9/9** |
| **Public HTTPS smoke** | **PASS — 9/9** against `https://api-staging.drsvp.com` and `https://staging.drsvp.com` |
| Deployment record | `20260827T212502508Z-91664d0fd639-deploy.json`, `backupPreflight.protection = "verified"` |

Ledger on the target:

```
2026-08-27T10:04:15.026Z  deploy    91664d0fd639  migration=applied  backup=taken    protection=-         smoke=passed
2026-08-27T10:07:13.595Z  deploy    d51c76b5ee6b  migration=applied  backup=taken    protection=-         smoke=passed
2026-08-27T10:08:02.764Z  rollback  91664d0fd639  migration=skipped  backup=skipped  protection=-         smoke=passed
2026-08-27T13:39:44.741Z  deploy    91664d0fd639  migration=applied  backup=taken    protection=verified  smoke=passed
2026-08-27T21:25:02.508Z  deploy    91664d0fd639  migration=applied  backup=taken    protection=verified  smoke=passed
```

## 15. Validation

See §19 for the full matrix with results.

## 16. Mechanism-store retirement

The same-host MinIO store proved the storage code path before real credentials
existed. It was **never protection** and could not be allowed to remain
mistakable for it.

| Action | Result |
| --- | --- |
| Container `orgistry-mechanism-store` | **removed** |
| Data directory `/opt/orgistry/data/mechanism-store` | **removed** — it held encrypted copies of staging backups; root-owned MinIO metadata required a root container to delete, which needed no host sudo |
| `backup-mechanism-check.env` and its credential | **removed** |
| Units referencing the mechanism config | **0** |
| Containers referencing `minio` | **0** |
| Port 9100 listening | **0** |
| Active scheduler config | `ORGISTRY_BACKUP_CONFIG=/opt/orgistry/config/backup.env` (all four units) |

No real DigitalOcean backup or WAL artifact was deleted. The mechanism-check
evidence survives only here, explicitly labelled as mechanism validation.

## 17. Sprint scope review

| Area | Drift? |
| --- | --- |
| Email provider closure | **No.** Untouched |
| Secrets-manager implementation | **No.** New credentials use the existing host-file mechanism; ORG-PR-006 explicitly not closed |
| Full observability | **No.** Health checks only; ORG-PR-007 explicitly not closed |
| Unrelated application features | **No.** No application source changed |
| Unrelated deployment redesign | **No.** One preflight stage; the release/digest/migration/rollback model untouched |
| Object-store redesign | **No.** Two narrow, evidence-driven fixes (§21); addressing model unchanged |

Application code changed: **none**. The only `apps/` or `packages/` interaction
was booting the packaged API image during a rehearsal.

## 18. Residual limitations

None of these was required for ORG-PR-005 closure; all are real.

- **Single region.** Space and droplet both in `fra1`. Survives host loss, not a
  regional outage. One bucket, no second provider.
- **Provider endpoint flakiness.** 52% of raw TCP connects refused, in ≤3 s
  bursts. Mitigated by transport retry; the underlying condition is outside this
  project's control.
- **No provider-managed PITR.** Archiving is self-managed.
- **One object-store identity** for both write and restore reads.
- **Manual encryption-key rotation**, unrecoverable key loss, no escrow
  (**ORG-PR-006**).
- **No alert routing** (**ORG-PR-007**).
- **Staging-scale measurements only** — ~8 MB synthetic database.
- **No provider-side lifecycle rules** configured.
- **Credential setup is unguarded** — a truncated secret surfaces only as
  `SignatureDoesNotMatch`; `verify-store` is the documented first check.
- **The schedule belongs to one account** (systemd user units).
- **Real-target rehearsals are operator-run, not CI-gated.**

## 19. Final validation matrix

### Repository validation

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm validate` | **PASS** | exit 0 — **1118 unit** (96 files) + **94 web** tests; typecheck, lint, web build, schema drift, whitespace |
| `pnpm validate:integration` | **PASS** | exit 0 — db 16, api 103. Run against `localhost:55432`; port 5432 on this workstation is held by an unrelated PostgreSQL |
| `git diff --check` | **PASS** | no whitespace errors |
| `pnpm scan:deps` | **PASS** | exit 0 |
| `pnpm scan:deps:local` | **PASS** | osv-scanner: "No issues found" |
| `pnpm scan:secrets` | **PASS** | gitleaks, 55 commits: no leaks found |
| `gitleaks dir .` (untracked tree) | **PASS** | 16.21 MB: no leaks found |
| `actionlint` | **PASS** | 0 findings |
| `shellcheck -x` (Sprint 28 scripts) | **PASS** | 0 findings at default severity |
| `tooling/artifact-smoke.sh` | **PASS** | "SMOKE OK: all artifact checks passed" |
| `pnpm drill:restore` | **PASS** | "Restore drill PASSED" |
| `pnpm drill:pitr` | **PASS** | "PITR drill PASSED" |
| `pnpm db:retention -- --dry-run` | **PASS** | 6 categories, 0 deleted |
| `pnpm deploy:rehearsal` | **PASS** | exit 0, "DEPLOY REHEARSAL OK" |

### Real DigitalOcean Spaces operational validation

| Check | Result | Evidence |
| --- | --- | --- |
| `verify-store` | **PASS** | write/read/list/delete, exit 0; **20/20** consecutive runs after the transport-retry fix |
| Scheduler re-pointed to `backup.env` | **PASS** | all four units; 0 reference the mechanism config |
| Scheduled backup (systemd-executed) | **PASS** | `orgistry-20260827T205811Z-scheduled.dump` stored encrypted |
| Timer-triggered WAL shipment | **PASS** | "Shipped 3 WAL segment(s) off-host", spool drained to 0 |
| Off-host upload | **PASS** | remote `HEAD` confirms artifact + metadata |
| Off-host retrieval | **PASS** | both rehearsals fetched from the Space |
| Encryption / decryption | **PASS** | key `b184c72b6e8f5a24`; digests verified against backup-time values |
| WAL archival from the deployed DB | **PASS** | `archived_count` 39+, `failed_count` 0 |
| Backup health | **PASS** | HEALTHY, exit 0 |
| WAL archive health | **PASS** | HEALTHY, exit 0 |
| Logical restore rehearsal | **PASS** | RTO 28 s / 33 s |
| PITR rehearsal | **PASS** | RTO 10 s |
| Lifecycle dry run | **PASS** | 0 deletions — the minimum-retention safeguard |
| Deployment protection — abort | **PASS** | aborted at stage 6, ledger and records unchanged |
| Deployment protection — verified | **PASS** | `protection: verified`, smoke 9/9 |
| Public HTTPS smoke | **PASS** | 9/9 |
| Mechanism-store retirement | **PASS** | §16 |

### Remote repository validation — published and complete

The Sprint 28 changes were published and validated remotely.

| | |
| --- | --- |
| Branch | `sprint-28-backup-recovery-operations` |
| Pull request | **#41** → `main`, state OPEN, merge state **CLEAN** |
| Verified head | **`ce2a483c6d6651a113055459fc19deb8c2340e9d`** |
| Local `HEAD` at review time | identical to the PR head (verified, not assumed) |

All **seven required checks passed** at that exact head — 7 successful, 0
failing, 0 pending, 0 skipped, 0 cancelled:

| Check | Workflow | Result | Duration |
| --- | --- | --- | --- |
| `Validate (offline)` | CI | **PASS** | 1m24s |
| `Integration (PostgreSQL + Redis)` | CI | **PASS** | 1m47s |
| `Artifacts (build + smoke)` | CI | **PASS** | 2m00s |
| `Dependency audit (pnpm)` | Security scans | **PASS** | 14s |
| `Secret scan (Gitleaks)` | Security scans | **PASS** | 7s |
| `Analyze (javascript-typescript)` | CodeQL | **PASS** | 1m02s |
| `CodeQL` (rollup) | CodeQL | **PASS** | 3s |

**Remote required-check validation is therefore complete for the published
head.** Three workflows ran on `pull_request` (CI, Security scans, CodeQL);
those carry all seven required checks, and branch-protection ruleset `19769611`
remains active.

### Still owed remotely — Deployment Rehearsal

| Check | Status | Why |
| --- | --- | --- |
| `Deployment rehearsal` at the published head | **NOT RUN** | Sprint 28 changed `tooling/deploy.sh` and `tooling/deploy-evidence.mjs` (the stage-6 protection preflight), and [../validation.md](../validation.md) requires a rehearsal when the deployment tooling changes. `deployment-rehearsal.yml` has **no push trigger** — weekly cron and `workflow_dispatch` only — so it does not fire on a pull request and must be dispatched manually, exactly as in Sprint 27 (run `33065548416`) |

It is **not a required check**, so it does not gate the pull request, and the
deterministic half of the changed tooling *is* covered remotely: the
release-manifest, evidence, and platform-guard unit tests run inside
`pnpm test` and therefore inside the required `Validate (offline)` check, which
passed. The rehearsal also passed **locally** at this change set
(`pnpm deploy:rehearsal`, exit 0). What is missing is the remote run at this
exact head. Dispatch:

```bash
gh workflow run deployment-rehearsal.yml --ref sprint-28-backup-recovery-operations
```

`Data durability` was correctly **not** required: its owned surface —
`tooling/db-backup.sh`, `db-restore-drill.sh`, `db-pitr-drill.sh`,
`tooling/lib/pg-tools.sh`, the restore fixture, and `apps/api/src/maintenance` —
is untouched on this branch, verified by diffing against `main`.

## 20. Security and secret-hygiene review

| Control | Result |
| --- | --- |
| `backup.env`, `backup-store-secret`, `backup-encryption-key`, `backup-database-url` | all **0600**, `daniel:daniel` |
| Credential-shaped matches in 4 hours of backup journals | **0** |
| Credential-shaped matches in the durability evidence records | **0** |
| Database URL in evidence | none — read into a variable, passed only through a container environment variable |
| Object-store secret | own 0600 file; used only as an HMAC key; never in a URL, query string, log, or error |
| Presigned URLs | never used — header authentication only |
| Encryption key | generated on the host, never transmitted; appears only as an HMAC fingerprint |
| Raw backup or WAL artifacts committed | none — `.gitignore` covers `*.enc`, `wal-archive/`, and the three key files |
| Credentials in repository documentation | none |
| Least privilege re-verified | `orgistry_backup` cannot write (`permission denied for table app_meta`) |
| `pnpm scan:secrets` / `gitleaks dir .` | **no leaks found** |

## 21. Defects found by real execution

Three issues, none reachable by the same-host mechanism validation. This is the
argument for validating against reality rather than a model of it.

### Incident 1 — incomplete object-store secret (no code change)

`verify-store` failed with `403 SignatureDoesNotMatch`. Two explanations were
possible: a bad credential, or a SigV4 interoperability defect.

It was settled by measurement. The **official AWS CLI 2.32.9**, run in a
transient container with a mode-0600 credentials file deleted on exit, failed
**identically in both virtual-host and path addressing**:

| Client | Addressing | Operation | Result |
| --- | --- | --- | --- |
| AWS CLI 2.32.9 | virtual-host | ListObjectsV2 | SignatureDoesNotMatch |
| AWS CLI 2.32.9 | path | ListObjectsV2 | SignatureDoesNotMatch |
| `object-store.mjs` | path | PutObject | SignatureDoesNotMatch |

Corroborated by shape: the installed secret was **8 characters** where
DigitalOcean issues **43**. The access key ID had the correct 20-character shape.

**A known-good client failing identically proves the fault is not ours.** The
operator reinstalled a complete pair and the gate passed. **No object-store code
was changed**, and the virtual-host hypothesis was explicitly left untested
rather than acted on — path-style has since been proven to work against Spaces.

### Incident 2 — WAL freshness reported an idle database as unhealthy

The hourly health unit went red with *"last segment archived 388.4m ago, older
than the 15m limit"*. The database was perfectly protected; it had simply taken
no writes, and `archive_timeout` forces a switch only when something is written.

Left alone this would have been worse than noise: with the deployment protection
preflight set to `require`, it would have **refused deployments to a protected
environment**. Manufacturing WAL before each check would have been fabricating
evidence.

**Fix:** the freshness limits now apply only when WAL is actually pending,
determined from the current segment's write offset (a freshly switched segment
carries only a 96-byte page header). An idle database reads
`no WAL pending — nothing left to archive`. Regression-tested in both
directions.

### Incident 3 — no transport retry against an endpoint refusing half its connects

WAL shipment failed with `fetch failed`, whose only actionable content lived in
`error.cause`. Surfacing the cause gave
`connect ECONNREFUSED 10.114.15.254:443`, and a raw-socket probe — no Node, no
our code — measured **47 of 90 connects refused (52%)** in bursts of ≤3 s.

The client had **no retry at all**, which was the real defect: every production
S3 client retries transport failures by default, which is why the AWS CLI
reached the same endpoint without trouble.

**Fix:** a bounded retry covering only the case where **no HTTP response was
produced**, with the body rebuilt per attempt (a file upload's stream is
single-use) and each attempt signed afresh. The window is sized from the
measured burst length, not an attempt count, because the refusals are correlated
in time. **An HTTP status is an answer and is never retried** — a 403 still
fails closed immediately. After the fix: **20/20 `verify-store` runs succeeded**
at ~1 s each.

## 22. Sprint 28 changelog

| # | Implementation | Safety | Validation | External evidence | Docs |
| --- | --- | --- | --- | --- | --- |
| 1 | `backup-crypto.mjs` — AES-256-GCM, authenticated header | fails closed on wrong key, truncation, bit flip, header forgery | 17 tests | — | backup-and-restore §9 |
| 2 | `object-store.mjs` — zero-dependency SigV4 client | header auth only, never presigned | 21 tests incl. 2 AWS vectors | — | backup-and-restore §9 |
| 3 | `backup-config/catalog/health.mjs` | 0600-only secrets; parsed-never-sourced config | 48 tests | — | §12 |
| 4 | `backup-ops.mjs` CLI; `pg-client.mjs` | no secret as an argument; artifact uploaded before its metadata | — | verify-store PASS | §12 |
| 5 | `pg-enable-wal-archiving.sh`; spool bind mount | refuses a non-mounted archive dir; verified backup first | — | archiving ACTIVE, failed_count 0 | pitr §6 |
| 6 | `infra/systemd/` + installer | user units, no root; docker-reachability check | — | timer-driven runs PASS | infra/systemd/README |
| 7 | `backup-restore-rehearsal.sh` | isolated target, empty-target assertion | — | **PASSED from Spaces**, 28 s / 33 s | §10 |
| 8 | `backup-pitr-rehearsal.sh` | live DB never a recovery target; source restored on exit | — | **PASSED from Spaces**, 10 s | §11 |
| 9 | deploy.sh protection preflight | aborts before migrations, target untouched | 37 tests | abort + verified paths PASS | deployment.md |
| 10 | Base-backup provenance in the catalog | — | — | catalog shows db/pg/migrations | §12 |
| 11 | *(no code change)* Credential diagnostic | transient container, credentials never echoed | AWS CLI baseline | isolated to credential config | §21.1 |
| 12 | Idle-database WAL-freshness fix | prevents refusing deployments to a protected environment | 2 regression tests | health HEALTHY on idle DB | §21.2 |
| 13 | Transport retry + error-cause surfacing | retries only when nothing was answered; never an HTTP status | 4 regression tests | 20/20 verify-store | §21.3 |
| 14 | Explicit RTO boundaries in rehearsal evidence | — | — | 28 s vs 33 s reported separately | §13 |
| 15 | Mechanism-store retirement | removes a store mistakable for protection | — | 0 units, 0 containers, 0 port | §16 |
| 16 | Documentation reconciliation | — | — | — | 16 documents |

---

# Closing components

## 23. Implementation summary

What Sprint 28 delivered, in one place.

| Area | Delivered |
| --- | --- |
| **Backup architecture** | The deployed `orgistry-infra-postgres-1` is the only source. Logical backups via the **unchanged** Sprint 25 `tooling/db-backup.sh`; physical base backups via `pg_basebackup`; both encrypted on the host and stored off-host. No parallel recovery architecture was introduced |
| **Scheduler** | Four versioned systemd **user** units (`infra/systemd/`, installed by `tooling/backup-install-systemd.sh`): logical backup daily 02:30 UTC, WAL shipping every 2 min, health hourly, lifecycle weekly. No root; `loginctl enable-linger` makes them survive logout and reboot. The installer verifies a user unit can reach Docker — a failure mode found the hard way |
| **Encryption** | Client-side **AES-256-GCM before upload** (`tooling/lib/backup-crypto.mjs`). Authenticated header carries the artifact name, byte count, and the plaintext digest recorded at backup time. Key is a mode-0600 host file, surfaced only as an HMAC fingerprint (`b184c72b6e8f5a24`) |
| **Credential model** | Three separate mode-0600 files. Database access through `orgistry_backup`: `LOGIN`, `REPLICATION`, `pg_read_all_data`; **not** superuser/`CREATEROLE`/`CREATEDB`, writes verified refused. Replication admitted by a `pg_hba` rule scoped to that one role requiring `scram-sha-256` |
| **Object storage** | **DigitalOcean Spaces**, `orgistry-staging-backups`, `fra1`, prefix `orgistry/staging-like`, path-style addressing, via a zero-dependency AWS SigV4 client (`tooling/lib/object-store.mjs`) using only Node built-ins |
| **WAL archival** | `archive_mode=on`, `archive_timeout=300s`, `wal_compression=on`, applied with `ALTER SYSTEM` so they survive a container recreate. `archive_command` copies to a bind-mounted local spool — never the network — which a timer drains off-host |
| **Health checks** | `backup-ops.mjs health` and `wal-health`: presence, freshness, encryption, integrity digest, interrupted uploads, last scheduled-run outcome, `archive_mode`, archiver failures, spool backlog, off-host WAL presence and currency. Exit non-zero on any failure |
| **Catalog / lifecycle** | Recovery-point inventory derived from the store itself, not a separate ledger. Retention: 30 days / never fewer than the newest 7 logical; 8 days WAL, never past the oldest surviving base backup — kept explicitly distinct from application-table retention |
| **Logical restore** | `tooling/backup-restore-rehearsal.sh` — retrieve from Spaces → decrypt → verify digest → isolated empty PostgreSQL → restore → schema, ledger, reference and tenant data, byte-identical API-key hash → packaged migration no-op → packaged API `/ready` |
| **PITR** | `tooling/backup-pitr-rehearsal.sh` — base backup + staging-produced WAL from Spaces → archive recovery to a chosen timestamp → verified in **both** directions, with archived-WAL consumption and a recovery-stopping line asserted from the log |
| **Deployment integration** | New stage 6 backup protection preflight in `tooling/deploy.sh`; `backupPreflight.protection` on the deployment record; any value but `verified` attaches an explicit limitation. Sprint 26/27 mechanics otherwise untouched |
| **Safety controls** | Restore targets are created by the script and never named by the caller; the connection is never read from the environment; the logical target is asserted empty first; the PITR target runs `archive_mode=off`; the PITR rehearsal re-applies its deleted row on every exit path; all containers, volumes, and decrypted artifacts destroyed on exit |
| **Defects found and fixed** | (1) WAL freshness reported an **idle** database unhealthy — which under `require` would have refused deployments to a protected environment; now gated on WAL actually being pending. (2) The object-store client had **no transport retry** against an endpoint refusing 52% of connects; now a bounded, transport-only retry that never retries an HTTP status. (3) A truncated object-store secret was isolated to **credential configuration, not repository SigV4**, by an independent AWS CLI baseline — **no code was changed for it** |

## 24. Documentation index

What each document is the authoritative answer to.

| Document | Authoritative question it answers |
| --- | --- |
| [../backup-and-restore.md](../backup-and-restore.md) | What is backed up, where it goes, how it is encrypted, who may touch it, what the schedule and lifecycle are, and how an operator takes, inspects, and restores a backup |
| [../pitr.md](../pitr.md) | Why a logical restore is not PITR, how continuous WAL archiving is configured on the deployed database, how a point-in-time recovery is performed and validated, and what the recovery window is |
| [../runbook.md](../runbook.md) | How to operate the **local** development infrastructure — and explicitly where the deployed backup programme's runbooks live instead |
| [../deployment.md](../deployment.md) | The deployment contract: stages and their failure conditions, the configuration contract, the backup protection preflight, the rollback model, and what deployment evidence records |
| [../validation.md](../validation.md) | Every validation command, what it proves, and the boundary between offline repository tests and operational checks that need the real host |
| [../known-limitations.md](../known-limitations.md) | What this project does **not** do, project-wide, in the author's own words rather than a reader's inference |
| [README.md](README.md) | The production-readiness audit's entry point and its per-sprint status history |
| [findings-register.md](findings-register.md) | **The authoritative status of every `ORG-PR-NNN` finding**, including the ORG-PR-005 closure record |
| [production-roadmap.md](production-roadmap.md) | Sequenced phases, what each sprint delivered, and the one recommended next sprint |
| [production-scorecard.md](production-scorecard.md) | Per-domain maturity, the largest remaining gap in each, and confidence |
| [launch-checklist.md](launch-checklist.md) | The stage-by-stage gate list a launch must satisfy, with per-row evidence |
| [production-target.md](production-target.md) | The production profile readiness is judged against, including the DG-5 RPO/RTO decision gate |
| [security-assessment.md](security-assessment.md) | Cross-domain security posture, including the confidentiality/integrity/least-privilege properties of the backup programme |
| [standards-matrix.md](standards-matrix.md) | ASVS / SSDF / SAMM practice-level mappings and where they are unmet |
| [repository-inventory.md](repository-inventory.md) | What exists in the repository and its maturity — including the backup programme's file surface and test surface |
| [sprint-28-artifact-package.md](sprint-28-artifact-package.md) | **This document** — the official Sprint 28 closing evidence and the basis for the ORG-PR-005 closure |
| `infra/systemd/README.md` | Why the schedule uses systemd *user* units, what each unit does, and the alert boundary |
| `infra/backup.env.example` | Every backup configuration key, its meaning, and the secret boundary between the three credential files |

## 25. Confidence assessment

Confidence is stated separately per claim class, because they are not equally
supported and averaging them would mislead.

| Class | Confidence | Basis |
| --- | --- | --- |
| **Repository-controlled implementation** | **High** | 1118 unit + 94 web tests pass; 86 tests cover the backup surface specifically, including both published AWS SigV4 vectors (an external oracle, not a self-generated golden file), the transport-retry contract, the encryption failure modes, and the idle-database health regression. Sprint 25's drills still pass unchanged. `shellcheck`, `actionlint`, and the artifact smoke gate are clean |
| **Staging-like operational execution** | **High** | Not inferred from code: a systemd-executed backup and a timer-triggered WAL shipment both completed against the real Space; remote objects confirmed by `HEAD`; `archived_count` 44 with `failed_count` 0; 20/20 consecutive `verify-store` runs; both deployment protection paths exercised; public HTTPS smoke 9/9 |
| **Recovery correctness** | **High for this dataset** | Both rehearsals recovered from artifacts **fetched back out of Spaces**, not from local copies. PITR was verified in both directions — pre-target state present *and* post-target state absent — with `restored log file` and a recovery-stopping line asserted from the recovery log, so "PITR" cannot have silently degraded into "started a base backup". The live database was verified byte-consistent afterwards. Confidence is high that the *procedure* is correct; it is untested against schema drift, a corrupted base backup, or a partial WAL chain |
| **Security / secret hygiene** | **High** | Zero credential-shaped matches across four hours of backup journals and every evidence record; all four credential files 0600; least privilege re-verified by an actual refused write; header authentication only, never presigned URLs; `pnpm scan:secrets` and a full-tree `gitleaks dir .` both clean. The residual is design, not hygiene: one shared object-store identity and manual key rotation |
| **Production extrapolation** | **Low — and deliberately so** | **Production-scale behaviour has not been measured.** Every figure comes from an ~8 MB synthetic database whose restore time is dominated by fixed costs (container start, image pull, verification) rather than data volume. The RPO upper bound is *configured*, not stress-tested under sustained write load, and its worst-case `archive_timeout` component was never independently timed (§13). Nothing here supports a production SLA, and none is offered |

**High confidence in staging-like recovery is not a production guarantee.** The
closure asserts that the required operational recovery pattern works on the
staging-like target. It asserts nothing about production, which does not exist.

## 26. Remaining risks

The risk-framed view of §18. Only risks that are actually present.

| Risk | Impact if it materialises | Status |
| --- | --- | --- |
| **Space and droplet are both in `fra1`** | A DigitalOcean regional outage takes the database and every backup offline together. Host loss *is* covered; regional loss is not | Accepted. Cross-region storage was not in Sprint 28 scope and is not implied anywhere. Not an ORG-PR-005 condition |
| **No alert routing** (**ORG-PR-007**, open) | A failed backup, a broken `archive_command`, or a filling spool stays invisible until a human looks at `systemctl --user list-units --failed`. Detection latency is bounded only by the hourly check plus human attention | Open finding. The health unit's exit code is the integration point for a future alerting system |
| **Host-local secret handling; no rotation platform** (**ORG-PR-006**, open) | Three credentials are files on one host. The backup encryption key has **no escrow** — losing it renders every stored backup unreadable, which is a data-loss path that the backups themselves cannot protect against | Open finding, enlarged by Sprint 28. Rotation is manual and documented |
| **No production email validation** (**ORG-PR-002**, open) | Registration, verification, and invitation flows fail closed on the target, so staging cannot be exercised end to end | Open finding; the recommended next sprint |
| **Rate-limit alerting residual** (**ORG-PR-009**, open) | A fail-closed limiter in production would not surface to an operator | Open finding; folds into ORG-PR-007 |
| **RPO/RTO measured on a small synthetic dataset** | Real recovery at production volume could be materially slower; a plan built on 28 s could be wrong by orders of magnitude | Explicitly labelled throughout as a staging-like baseline, never as an SLA |
| **Provider endpoint refuses ~52% of TCP connects** | Without the bounded transport retry, roughly half of all scheduled operations would fail. With it, operations succeed — but the provider condition is outside this project's control and could worsen | Mitigated and measured (20/20 after the fix). Permanent HTTP failures still fail on the first attempt |
| **`Deployment rehearsal` has not run remotely at the published head** | A regression in the changed deployment tooling that only manifests in the full rehearsal would not yet have been caught remotely | Reduced, not eliminated: all seven required checks passed at head `ce2a483c6d66`, the changed tooling's unit tests run inside the required `Validate (offline)` check, and the rehearsal passed locally. It is not a required check and must be dispatched manually (§19) |
| **One object-store identity for write and restore reads** | A compromised backup credential can delete backups as well as read them | Accepted; needs provider-side bucket policy to split |
| **Schedule belongs to one account** | Removing the operator account removes the backup schedule | Accepted consequence of needing no root |
| **Rehearsals are operator-run, not CI-gated** | A regression in either rehearsal script is caught only at the next manual run | Accepted; their unit-testable parts are in the offline suite |

## 27. Readiness for the next sprint

```
Sprint 28 DoD:     MET
ORG-PR-005:        CLOSED
staging ready:     NO
production ready:  NO
```

**Recommended next: ORG-PR-002 — external production email provider
validation.**

This follows the evidence rather than the finding numbering. With ORG-PR-001
and ORG-PR-005 closed, the open P1s are ORG-PR-002 and ORG-PR-006, and
ORG-PR-002 is the clearest blocker for a specific reason: **it is the last thing
preventing the staging environment from being exercised end to end.** Today
`MAIL_DRIVER=smtp` points at a plaintext Mailpit sink while the driver requires
implicit TLS, so account email fails closed on the target — correct behaviour,
but it means registration, verification, and invitation flows cannot be walked
through on a real deployment. Every other layer beneath them is now proven:
the deployment pipeline (Sprint 27) and the recovery programme (Sprint 28).
Closing ORG-PR-002 converts staging from *deployed* into *usable*, and it is a
precondition for any honest staging-readiness assessment.

**ORG-PR-006** follows — and Sprint 28 made it larger, not smaller, by adding a
backup encryption key whose loss is unrecoverable and which has no escrow.
**ORG-PR-007/009** follow that, and would give the backup and archive health
checks somewhere to page.

## 28. Final finding state

```
ORG-PR-005: CLOSED
ORG-PR-002: OPEN
ORG-PR-006: OPEN
ORG-PR-007: OPEN
ORG-PR-009: OPEN

staging ready:    NO
production ready: NO
```

**ORG-PR-005 closure, in one paragraph.** The deployed staging-like PostgreSQL
is now protected by a running programme rather than a capability: systemd timers
take encrypted logical backups and ship continuously archived WAL to
**DigitalOcean Spaces** (`orgistry-staging-backups`, `fra1`), a store outside the
source host's failure boundary; a least-privilege role reads the database and
cannot write to it; artifacts are encrypted on the host before upload and their
integrity is checked against a digest recorded at backup time; health checks,
a recovery-point catalog, an artifact lifecycle, and a deployment protection
preflight are in place and exercised; and **both a logical restore and a
point-in-time recovery were performed by retrieving artifacts back out of that
storage**, the latter verified in both directions with archived-WAL consumption
asserted from the recovery log, yielding a measured staging-like RPO and two
measured RTOs. This proves the required **operational recovery pattern on the
staging-like target**. It does **not** mean production recovery has been
exercised — no production database exists — and every measurement is a
staging-like baseline, not a production SLA.

```
SPRINT 28 COMPLETE — OFFICIAL ARTIFACT PACKAGE READY
```
