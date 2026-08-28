/**
 * Backup catalog / recovery-point inventory (Sprint 28, ORG-PR-005).
 *
 * WHAT THIS IS FOR
 * During an incident the first question is never "is the backup script
 * correct?" — it is "what can I actually recover to, and how do I get it?".
 * The catalog answers that from the off-host store itself: it is DERIVED from
 * what is really in the bucket, not from a ledger that could disagree with it.
 * A separate database of backup metadata would be one more thing to keep in
 * sync and one more thing to lose with the host.
 *
 * WHAT IT MUST NEVER CONTAIN
 * No connection string, no credential, no encryption key, and no backup
 * CONTENT. A recovery point names an artifact, its integrity digest, the key
 * FINGERPRINT that will decrypt it, and its lifecycle state. Everything here is
 * safe to paste into a runbook or a sprint artifact.
 *
 * This module is pure: it takes listings and metadata documents and returns
 * structures. Fetching them is the CLI's job, which is what makes the shape of
 * the inventory testable without a network.
 */

export const OBJECT_LAYOUT = {
  logical: 'logical/',
  baseBackup: 'basebackup/',
  wal: 'wal/',
};

export const ENCRYPTED_SUFFIX = '.enc';
export const METADATA_SUFFIX = '.meta.json';

/** The stored name of a logical backup's encrypted artifact and its metadata. */
export function logicalObjectKeys(artifactName) {
  return {
    artifact: `${OBJECT_LAYOUT.logical}${artifactName}${ENCRYPTED_SUFFIX}`,
    metadata: `${OBJECT_LAYOUT.logical}${artifactName}${METADATA_SUFFIX}`,
  };
}

/** The stored name of a base backup (the basis for point-in-time recovery). */
export function baseBackupObjectKeys(baseName) {
  return {
    artifact: `${OBJECT_LAYOUT.baseBackup}${baseName}.tar.gz${ENCRYPTED_SUFFIX}`,
    metadata: `${OBJECT_LAYOUT.baseBackup}${baseName}${METADATA_SUFFIX}`,
  };
}

/** The stored name of one archived WAL segment. */
export function walObjectKey(segmentName) {
  return `${OBJECT_LAYOUT.wal}${segmentName}${ENCRYPTED_SUFFIX}`;
}

/** Recover the WAL segment name from its stored key. */
export function walSegmentName(objectKey) {
  const withoutPrefix = objectKey.slice(objectKey.lastIndexOf('/') + 1);
  return withoutPrefix.endsWith(ENCRYPTED_SUFFIX)
    ? withoutPrefix.slice(0, -ENCRYPTED_SUFFIX.length)
    : withoutPrefix;
}

function addDays(isoTimestamp, days) {
  const base = Date.parse(isoTimestamp);
  if (!Number.isFinite(base)) return '';
  return new Date(base + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Combine one stored metadata document with what the bucket actually holds.
 *
 * `storedObject` is the listing entry for the encrypted artifact, or undefined.
 * A metadata document with no artifact beside it is reported as `orphaned`
 * rather than quietly dropped: it means an upload failed halfway, which an
 * operator needs to see.
 */
export function buildRecoveryPoint({ metadata, storedObject, retentionDays, kind }) {
  const uploadState = storedObject ? 'uploaded' : 'orphaned-metadata';
  return {
    id: metadata.artifact,
    kind,
    takenAt: metadata.created_at ?? '',
    database: metadata.database ?? '',
    sourceEnvironment: metadata.source_environment ?? '',
    sourceHost: metadata.source_host ?? '',
    postgresVersion: metadata.postgres_server_version ?? '',
    appliedMigrations: metadata.applied_migrations ?? null,
    objectKey: storedObject?.key ?? '',
    plaintextSha256: metadata.sha256 ?? '',
    plaintextBytes: metadata.bytes ?? null,
    storedBytes: storedObject?.size ?? null,
    encrypted: metadata.encrypted === true,
    encryptionKeyId: metadata.encryption_key_id ?? '',
    uploadState,
    retentionExpiresAt: metadata.created_at ? addDays(metadata.created_at, retentionDays) : '',
    verification: metadata.verification ?? 'checksum-recorded-at-backup',
    restoreRehearsal: metadata.restore_rehearsal ?? null,
    walRangeStart: metadata.wal_range_start ?? '',
  };
}

const byTakenAtDescending = (left, right) => String(right.takenAt).localeCompare(String(left.takenAt));

/**
 * Summarise the WAL objects in the store into a recovery window.
 *
 * The window is deliberately expressed with the OLDEST retained WAL rather than
 * the oldest base backup: continuous recovery is only possible from a base
 * backup forward THROUGH an unbroken WAL chain, so the earliest segment is the
 * real floor and the newest segment is the real ceiling.
 */
export function summariseWalWindow(walObjects) {
  if (walObjects.length === 0) {
    return { segments: 0, earliestSegment: '', latestSegment: '', earliestArchivedAt: '', latestArchivedAt: '' };
  }
  const sorted = [...walObjects].sort((left, right) => left.key.localeCompare(right.key));
  const byTime = [...walObjects].sort((left, right) =>
    String(left.lastModified).localeCompare(String(right.lastModified)),
  );
  return {
    segments: walObjects.length,
    earliestSegment: walSegmentName(sorted[0].key),
    latestSegment: walSegmentName(sorted[sorted.length - 1].key),
    earliestArchivedAt: byTime[0].lastModified,
    latestArchivedAt: byTime[byTime.length - 1].lastModified,
    bytes: walObjects.reduce((total, object) => total + (object.size || 0), 0),
  };
}

/** Assemble the full inventory an operator reads during an incident. */
export function buildCatalog({ target, logicalPoints, basePoints, walObjects, generatedAt }) {
  return {
    kind: 'orgistry.backup-catalog',
    schemaVersion: 1,
    generatedAt,
    target,
    logical: [...logicalPoints].sort(byTakenAtDescending),
    baseBackups: [...basePoints].sort(byTakenAtDescending),
    wal: summariseWalWindow(walObjects),
  };
}

function shortDigest(value) {
  return value ? `${value.slice(0, 12)}…` : '—';
}

/** Render the catalog as an operator-readable table. Secret-free by construction. */
export function renderCatalog(catalog) {
  const lines = [];
  lines.push(`Backup catalog — ${catalog.target.bucket}/${catalog.target.prefix} (${catalog.target.endpoint})`);
  lines.push(`generated ${catalog.generatedAt}`);
  lines.push('');

  const section = (title, points) => {
    lines.push(`${title} (${points.length})`);
    if (points.length === 0) {
      lines.push('  none');
      return;
    }
    for (const point of points) {
      lines.push(`  ${point.takenAt}  ${point.id}`);
      lines.push(
        `      source=${point.sourceEnvironment || '?'}/${point.sourceHost || '?'} db=${point.database || '?'} ` +
          `pg=${point.postgresVersion || '?'} migrations=${point.appliedMigrations ?? '?'}`,
      );
      lines.push(
        `      object=${point.objectKey || '(missing)'} upload=${point.uploadState} ` +
          `encrypted=${point.encrypted ? `yes(key ${point.encryptionKeyId || '?'})` : 'NO'}`,
      );
      lines.push(
        `      sha256=${shortDigest(point.plaintextSha256)} bytes=${point.plaintextBytes ?? '?'} ` +
          `storedBytes=${point.storedBytes ?? '?'} expires=${point.retentionExpiresAt || '—'}`,
      );
      if (point.restoreRehearsal) {
        lines.push(`      restore-rehearsal=${point.restoreRehearsal}`);
      }
    }
  };

  section('Logical backups', catalog.logical);
  lines.push('');
  section('Base backups (PITR basis)', catalog.baseBackups);
  lines.push('');
  lines.push('Archived WAL');
  if (catalog.wal.segments === 0) {
    lines.push('  none — no point-in-time recovery window exists');
  } else {
    lines.push(`  segments=${catalog.wal.segments} bytes=${catalog.wal.bytes}`);
    lines.push(`  range=${catalog.wal.earliestSegment} .. ${catalog.wal.latestSegment}`);
    lines.push(`  archived=${catalog.wal.earliestArchivedAt} .. ${catalog.wal.latestArchivedAt}`);
  }
  return lines.join('\n');
}
