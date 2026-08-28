# Orgistry backup scheduler units (Sprint 28, ORG-PR-005)

These are the **versioned** definitions of every scheduled backup operation.
`tooling/backup-install-systemd.sh` renders them onto a deployment host; nothing
here is edited on the host, so what runs there is reviewable here.

## Why systemd *user* units

The deployment target's operator account has **no passwordless sudo**, and a
backup programme that can only be installed by escalating privileges is a
backup programme that will not be reinstalled after the host is rebuilt. User
units need no root at all, and `loginctl enable-linger <user>` makes them start
at boot and survive logout — which is the only durability property a scheduler
actually needs here.

The tradeoff is recorded honestly in `docs/backup-and-restore.md`: user units
are owned by one account. If that account is removed, the schedule goes with it.

## Units

| Unit | Cadence | What it does |
| --- | --- | --- |
| `orgistry-backup.timer` | daily, 02:30 UTC (±10 min jitter) | full logical backup, encrypted, stored off-host |
| `orgistry-wal-ship.timer` | every 2 minutes | moves spooled WAL segments off-host, encrypted |
| `orgistry-backup-health.timer` | hourly | fails the unit when the database is not protected |
| `orgistry-backup-prune.timer` | weekly, Sunday 04:10 UTC | applies the artifact lifecycle |

Every service is `Type=oneshot` and every one of them exits non-zero on failure,
so `systemctl --user list-units --failed` is the single place an operator looks.

## Alert boundary — read this before relying on it

A failed unit is visible in `systemctl --user list-units --failed` and in
`journalctl --user -u <unit>`. **Nothing pages anyone.** This is deliberate and
in scope: Sprint 28 delivers backup failure *visibility*, not alert routing.
Production-grade alerting is ORG-PR-007 and remains open.

## Placeholders

`@ORGISTRY_TOOLING_DIR@` and `@ORGISTRY_BACKUP_CONFIG@` are substituted by the
installer. They are placeholders rather than defaults so a half-installed unit
fails immediately instead of silently backing up the wrong thing.
