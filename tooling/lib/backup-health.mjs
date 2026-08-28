/**
 * Backup and WAL-archive health evaluation (Sprint 28, ORG-PR-005).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * These are focused operational CHECKS, not an observability platform. They
 * answer one question each, exit non-zero when the answer is bad, and print a
 * line a human can act on. There is no metrics pipeline, no dashboard, and no
 * alert routing here — ORG-PR-007 remains open and nothing in this module
 * should be described as production-grade alerting.
 *
 * WHY THE CHECKS ARE SHAPED THIS WAY
 * The classic way a backup programme dies is silently: the script keeps
 * exiting 0 while the artifact stops arriving, or `archive_command` starts
 * failing and PostgreSQL simply retries forever. So every check is written
 * against the OUTCOME visible off-host — an artifact really in the bucket, of
 * the expected age, encrypted, with its metadata beside it — rather than
 * against the fact that a job ran.
 *
 * The evaluation is pure so the thresholds and the boundary conditions are
 * testable without a database, a bucket, or a clock.
 */

export const HEALTH_STATUS = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };

function hoursBetween(laterIso, earlierIso) {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 3_600_000;
}

function minutesBetween(laterIso, earlierIso) {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 60_000;
}

function check(name, status, detail) {
  return { name, status, detail };
}

/**
 * Evaluate whether the logical-backup programme is currently protecting the
 * database.
 *
 * `lastRun` is the scheduler's own record of its most recent attempt. It is a
 * WARN rather than a FAIL when absent, because a freshly installed timer that
 * has not fired yet is a real and temporary state — while a recorded FAILED run
 * is a hard failure even if an older artifact is still within its age window.
 */
export function evaluateBackupHealth({ catalog, now, thresholds, lastRun = null }) {
  const checks = [];
  const uploaded = catalog.logical.filter((point) => point.uploadState === 'uploaded');
  const latest = uploaded[0] ?? null;

  checks.push(
    uploaded.length > 0
      ? check('logical backup present', HEALTH_STATUS.pass, `${uploaded.length} recovery point(s) off-host`)
      : check('logical backup present', HEALTH_STATUS.fail, 'no uploaded logical backup exists off-host'),
  );

  if (latest) {
    const ageHours = hoursBetween(now, latest.takenAt);
    checks.push(
      ageHours <= thresholds.backupMaxAgeHours
        ? check(
            'latest backup is fresh',
            HEALTH_STATUS.pass,
            `${latest.id} is ${ageHours.toFixed(1)}h old (limit ${thresholds.backupMaxAgeHours}h)`,
          )
        : check(
            'latest backup is fresh',
            HEALTH_STATUS.fail,
            `${latest.id} is ${ageHours.toFixed(1)}h old, older than the ${thresholds.backupMaxAgeHours}h limit`,
          ),
    );

    checks.push(
      latest.encrypted
        ? check('latest backup is encrypted', HEALTH_STATUS.pass, `key ${latest.encryptionKeyId}`)
        : check('latest backup is encrypted', HEALTH_STATUS.fail, `${latest.id} is stored unencrypted`),
    );

    checks.push(
      latest.plaintextSha256
        ? check('latest backup has an integrity digest', HEALTH_STATUS.pass, 'sha256 recorded at backup time')
        : check('latest backup has an integrity digest', HEALTH_STATUS.fail, 'no sha256 recorded'),
    );
  }

  const orphaned = catalog.logical.filter((point) => point.uploadState === 'orphaned-metadata');
  checks.push(
    orphaned.length === 0
      ? check('no interrupted uploads', HEALTH_STATUS.pass, 'every metadata document has its artifact')
      : check(
          'no interrupted uploads',
          HEALTH_STATUS.fail,
          `${orphaned.length} metadata document(s) with no artifact: ${orphaned.map((point) => point.id).join(', ')}`,
        ),
  );

  if (lastRun === null) {
    checks.push(check('scheduled run recorded', HEALTH_STATUS.warn, 'no scheduled run has been recorded yet'));
  } else if (lastRun.result === 'succeeded') {
    checks.push(check('scheduled run recorded', HEALTH_STATUS.pass, `last run succeeded at ${lastRun.finishedAt}`));
  } else {
    checks.push(
      check(
        'scheduled run recorded',
        HEALTH_STATUS.fail,
        `last run ${lastRun.result} at ${lastRun.finishedAt}: ${lastRun.detail ?? 'no detail recorded'}`,
      ),
    );
  }

  return summarise(checks, {
    latestRecoveryPoint: latest ? { id: latest.id, takenAt: latest.takenAt } : null,
    recoveryPoints: uploaded.length,
  });
}

/**
 * Evaluate whether continuous WAL archival is actually working.
 *
 * `archiver` is a reading of `pg_stat_archiver` from the SOURCE database, plus
 * `walPending` — whether the database has written anything into the current
 * segment that is not yet archived;
 * `spool` describes the on-host directory `archive_command` writes into; and
 * `walWindow` is what the off-host store really holds. All three are needed:
 * archiving can succeed into the spool while shipping is broken, and shipping
 * can look healthy while PostgreSQL has stopped producing segments.
 */
export function evaluateWalArchiveHealth({ archiver, spool, walWindow, now, thresholds }) {
  const checks = [];

  checks.push(
    archiver.archiveMode === 'on'
      ? check('archive_mode', HEALTH_STATUS.pass, 'on')
      : check('archive_mode', HEALTH_STATUS.fail, `archive_mode is "${archiver.archiveMode}" — no WAL is being archived`),
  );

  checks.push(
    archiver.archivedCount > 0
      ? check('WAL segments archived', HEALTH_STATUS.pass, `${archiver.archivedCount} archived`)
      : check('WAL segments archived', HEALTH_STATUS.fail, 'pg_stat_archiver has never archived a segment'),
  );

  // A non-zero failed_count is only a current problem if the most recent
  // FAILURE is newer than the most recent SUCCESS. Transient failures that the
  // archiver has since recovered from must not hold the check red forever.
  if (archiver.failedCount > 0 && archiver.lastFailedTime) {
    const recovered =
      archiver.lastArchivedTime && Date.parse(archiver.lastArchivedTime) > Date.parse(archiver.lastFailedTime);
    checks.push(
      recovered
        ? check(
            'archive_command not failing',
            HEALTH_STATUS.warn,
            `${archiver.failedCount} historical failure(s); last failure ${archiver.lastFailedTime} predates the last success`,
          )
        : check(
            'archive_command not failing',
            HEALTH_STATUS.fail,
            `archive_command is failing: ${archiver.failedCount} failures, last at ${archiver.lastFailedTime} (${archiver.lastFailedWal ?? 'unknown segment'})`,
          ),
    );
  } else {
    checks.push(check('archive_command not failing', HEALTH_STATUS.pass, 'no archiver failures recorded'));
  }

  // WAL freshness is only meaningful when the database has actually produced
  // WAL. `archive_timeout` forces a segment switch only if something was
  // WRITTEN since the last switch, so a genuinely idle database archives
  // nothing and its newest segment ages indefinitely — while remaining fully
  // recoverable, because nothing changed. Enforcing an age limit there reports
  // a healthy environment as broken, which (with the deployment protection
  // preflight set to `require`) would refuse deployments to a protected
  // environment. The age limit is therefore applied only when WAL is pending.
  if (archiver.lastArchivedTime) {
    const ageMinutes = minutesBetween(now, archiver.lastArchivedTime);
    const withinLimit = ageMinutes <= thresholds.walMaxAgeMinutes;
    if (!archiver.walPending) {
      checks.push(
        check(
          'recent WAL archived locally',
          HEALTH_STATUS.pass,
          `no WAL pending — the database has written nothing since ${archiver.lastArchivedWal || 'the last switch'} ` +
            `was archived ${ageMinutes.toFixed(1)}m ago, so there is nothing left to archive`,
        ),
      );
    } else {
      checks.push(
        withinLimit
          ? check(
              'recent WAL archived locally',
              HEALTH_STATUS.pass,
              `last segment archived ${ageMinutes.toFixed(1)}m ago (limit ${thresholds.walMaxAgeMinutes}m)`,
            )
          : check(
              'recent WAL archived locally',
              HEALTH_STATUS.fail,
              `WAL is pending but the last segment was archived ${ageMinutes.toFixed(1)}m ago, ` +
                `older than the ${thresholds.walMaxAgeMinutes}m limit`,
            ),
      );
    }
  }

  // The spool is a hand-off buffer, not storage. A growing backlog means the
  // shipper is failing while PostgreSQL is still succeeding — the failure mode
  // that looks healthiest from inside the database.
  checks.push(
    spool.pendingSegments === 0
      ? check('WAL spool drained', HEALTH_STATUS.pass, 'no segments awaiting off-host shipment')
      : spool.oldestPendingAgeMinutes <= thresholds.walMaxAgeMinutes
        ? check(
            'WAL spool drained',
            HEALTH_STATUS.pass,
            `${spool.pendingSegments} segment(s) pending, oldest ${spool.oldestPendingAgeMinutes.toFixed(1)}m`,
          )
        : check(
            'WAL spool drained',
            HEALTH_STATUS.fail,
            `${spool.pendingSegments} segment(s) pending off-host shipment, oldest ${spool.oldestPendingAgeMinutes.toFixed(1)}m ` +
              `— WAL is being archived locally but is NOT reaching off-host storage`,
          ),
  );

  checks.push(
    walWindow.segments > 0
      ? check(
          'WAL present off-host',
          HEALTH_STATUS.pass,
          `${walWindow.segments} segment(s), ${walWindow.earliestSegment} .. ${walWindow.latestSegment}`,
        )
      : check('WAL present off-host', HEALTH_STATUS.fail, 'no archived WAL exists off-host — there is no PITR window'),
  );

  // Same reasoning as above: an idle database cannot make its off-host archive
  // any newer, so age is only a fault signal when WAL is pending.
  if (walWindow.latestArchivedAt) {
    const ageMinutes = minutesBetween(now, walWindow.latestArchivedAt);
    const limitMinutes = thresholds.walMaxAgeMinutes * 2;
    if (!archiver.walPending) {
      checks.push(
        check(
          'off-host WAL is current',
          HEALTH_STATUS.pass,
          `newest off-host segment stored ${ageMinutes.toFixed(1)}m ago; no WAL pending`,
        ),
      );
    } else {
      checks.push(
        ageMinutes <= limitMinutes
          ? check(
              'off-host WAL is current',
              HEALTH_STATUS.pass,
              `newest off-host segment stored ${ageMinutes.toFixed(1)}m ago`,
            )
          : check(
              'off-host WAL is current',
              HEALTH_STATUS.fail,
              `WAL is pending but the newest off-host segment was stored ${ageMinutes.toFixed(1)}m ago, beyond ${limitMinutes}m`,
            ),
      );
    }
  }

  return summarise(checks, {
    recoveryWindow: {
      earliestArchivedAt: walWindow.earliestArchivedAt || '',
      latestArchivedAt: walWindow.latestArchivedAt || '',
      segments: walWindow.segments,
    },
  });
}

function summarise(checks, extra) {
  const failed = checks.filter((entry) => entry.status === HEALTH_STATUS.fail);
  const warned = checks.filter((entry) => entry.status === HEALTH_STATUS.warn);
  return {
    healthy: failed.length === 0,
    failedCount: failed.length,
    warnedCount: warned.length,
    checks,
    ...extra,
  };
}

/** Render a health result as operator-readable lines. Contains no secret. */
export function renderHealth(title, result) {
  const lines = [title];
  for (const entry of result.checks) {
    lines.push(`  [${entry.status}] ${entry.name} — ${entry.detail}`);
  }
  lines.push(
    result.healthy
      ? `  => HEALTHY (${result.warnedCount} warning(s))`
      : `  => UNHEALTHY (${result.failedCount} failed, ${result.warnedCount} warning(s))`,
  );
  return lines.join('\n');
}
