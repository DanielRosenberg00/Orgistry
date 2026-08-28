#!/usr/bin/env node
/**
 * Backup operations CLI (Sprint 28, ORG-PR-005).
 *
 * ONE entry point for every off-host backup operation, because they all share
 * the same configuration, the same credentials, and the same failure rules.
 * Splitting them into eight scripts would mean eight copies of the loading,
 * masking, and exit-code logic.
 *
 *   backup-ops.mjs verify-store       prove the credentials and bucket work
 *   backup-ops.mjs ship-backup        take a logical backup and store it off-host
 *   backup-ops.mjs ship-base-backup   take a pg_basebackup (the PITR basis)
 *   backup-ops.mjs ship-wal           ship spooled WAL segments off-host
 *   backup-ops.mjs catalog            print the recovery-point inventory
 *   backup-ops.mjs health             is the database currently protected?
 *   backup-ops.mjs wal-health         is continuous WAL archival working?
 *   backup-ops.mjs fetch              retrieve and decrypt one stored object
 *   backup-ops.mjs prune              apply the backup artifact lifecycle
 *
 * EXIT CODES
 *   0  the operation succeeded / the checked thing is healthy
 *   1  the operation failed / the checked thing is UNHEALTHY
 * Every path that could leave protection in doubt exits non-zero. There is no
 * "succeeded with warnings" exit code, because a scheduler cannot act on one.
 *
 * SECRETS
 * No subcommand prints a database URL, an object-store secret, or an encryption
 * key, and none accepts one as a command-line argument — arguments are visible
 * to every account on the host through `ps`. Secrets are read from mode-0600
 * files named by the configuration (tooling/lib/backup-config.mjs).
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { hostname } from 'node:os';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  baseBackupObjectKeys,
  buildCatalog,
  buildRecoveryPoint,
  logicalObjectKeys,
  OBJECT_LAYOUT,
  summariseWalWindow,
  renderCatalog,
  walObjectKey,
  walSegmentName,
} from './lib/backup-catalog.mjs';
import { decryptFile, encryptFile, parseEncryptionKey, sha256File } from './lib/backup-crypto.mjs';
import { describeConfiguration, loadBackupConfiguration } from './lib/backup-config.mjs';
import { evaluateBackupHealth, evaluateWalArchiveHealth, renderHealth } from './lib/backup-health.mjs';
import { createObjectStore } from './lib/object-store.mjs';
import { queryRows, runPostgresClient } from './lib/pg-client.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** WAL segment file names are exactly 24 hex characters; `.backup`/`.history` sit beside them. */
const WAL_FILE_PATTERN = /^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup|\.partial)?$|^[0-9A-F]{8}\.history$/;

/** How many logical backups stay on the source host after a successful upload. */
const DEFAULT_LOCAL_COPIES = 2;

/**
 * Bytes into the current WAL segment below which the database is treated as
 * having written nothing since the last segment switch.
 *
 * A freshly switched segment already contains a WAL page header — 96 bytes on
 * the pinned PostgreSQL 16 — so an offset at that level means "idle", not
 * "unarchived data". The allowance is deliberately generous relative to that
 * header and negligible relative to any real transaction, and being slightly
 * wrong is benign in both directions: a tiny write briefly read as idle is
 * sealed by `archive_timeout` within minutes anyway.
 */
const EMPTY_WAL_SEGMENT_ALLOWANCE_BYTES = 512;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Report a failure and set a non-zero exit code.
 *
 * `cause` is unwrapped deliberately. A transport failure from `fetch` arrives
 * as a bare `TypeError: fetch failed`, whose only actionable content — the
 * socket error, the DNS failure, the reset — lives in `error.cause`. Printing
 * just the message hands an operator a line they cannot act on at 03:00.
 */
function fail(error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? error);
  const causes = [];
  let cause = typeof error === 'string' ? undefined : error?.cause;
  while (cause && causes.length < 3) {
    causes.push(String(cause.message ?? cause));
    cause = cause.cause;
  }
  const detail = causes.length > 0 ? ` (cause: ${causes.join(' <- ')})` : '';
  process.stderr.write(`backup-ops: ${message}${detail}\n`);
  process.exitCode = 1;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        options[name] = true;
      } else {
        options[name] = next;
        index += 1;
      }
    } else {
      options._.push(token);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: tooling/backup-ops.mjs <command> [options]',
    '',
    'Commands:',
    '  verify-store        write, read back, and delete a probe object',
    '  ship-backup         take a logical backup and store it off-host, encrypted',
    '  ship-base-backup    take a pg_basebackup and store it off-host, encrypted',
    '  ship-wal            ship spooled WAL segments off-host, encrypted',
    '  catalog             print the recovery-point inventory',
    '  health              check that the database is currently protected',
    '  wal-health          check that continuous WAL archival is working',
    '  fetch               retrieve and decrypt one stored object',
    '  fetch-wal           retrieve and decrypt every archived WAL segment',
    '  prune               apply the backup artifact lifecycle',
    '',
    'Options:',
    '  --config PATH       backup configuration file (default $ORGISTRY_BACKUP_CONFIG)',
    '  --json              machine-readable output (catalog, health, wal-health)',
    '  --label TEXT        extra filename component for ship-backup',
    '  --key KEY           stored object key for fetch',
    '  --output PATH       destination path for fetch',
    '  --raw               fetch without decrypting',
    '  --since SEGMENT     fetch-wal: skip segments older than this one',
    '  --dry-run           prune: report what would be deleted, delete nothing',
    '  --keep-local N      ship-backup: local copies to retain (default 2)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function loadContext(options) {
  const configPath = options.config ?? process.env.ORGISTRY_BACKUP_CONFIG ?? '';
  const configuration = loadBackupConfiguration(configPath || null);
  const encryptionKey = parseEncryptionKey(configuration.encryptionKey);
  const store = createObjectStore({ ...configuration.store });
  return { configuration, encryptionKey, store, configPath };
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Record the outcome of a scheduled job so a health check can see a FAILED run
 * even when an older artifact is still inside its age window. Without this, a
 * timer that has been failing for a day looks healthy until the freshness
 * threshold expires.
 */
async function recordRunState(configuration, name, state) {
  await ensureDirectory(configuration.stateDir);
  const path = join(configuration.stateDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function readRunState(configuration, name) {
  try {
    return JSON.parse(await readFile(join(configuration.stateDir, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Run a repository script, returning its stdout. Used for tooling/db-backup.sh. */
function runRepositoryScript(scriptPath, args, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(`${scriptPath} exited ${code}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/**
 * Encrypt a local artifact and store it off-host with its metadata.
 *
 * ORDER MATTERS: the encrypted artifact is uploaded FIRST and its presence is
 * confirmed with a HEAD before the metadata document is written. A metadata
 * document that advertises an object which is not there is worse than no
 * metadata at all — it is a recovery point an operator will plan around during
 * an incident and discover is fiction.
 */
async function encryptAndStore({ store, encryptionKey, sourcePath, keys, metadata, workDir }) {
  const plaintextSha256 = await sha256File(sourcePath);
  const encryptedPath = join(workDir, `${keys.artifact.replace(/\//g, '_')}.tmp`);

  try {
    const encrypted = await encryptFile({
      sourcePath,
      destinationPath: encryptedPath,
      key: encryptionKey,
      plaintextSha256,
      plaintextName: metadata.artifact,
    });
    const { size } = await stat(encryptedPath);

    await store.putFile(keys.artifact, encryptedPath, {
      contentSha256: encrypted.encryptedSha256,
      contentLength: size,
    });

    const stored = await store.headObject(keys.artifact);
    if (!stored) {
      throw new Error(`upload of ${keys.artifact} reported success but the object is not readable back`);
    }
    if (stored.bytes !== size) {
      throw new Error(`stored ${keys.artifact} is ${stored.bytes} bytes, expected ${size}`);
    }

    const storedMetadata = {
      ...metadata,
      sha256: plaintextSha256,
      encrypted: true,
      encryption: 'client-side AES-256-GCM before upload (tooling/lib/backup-crypto.mjs)',
      encryption_key_id: encrypted.keyId,
      encrypted_sha256: encrypted.encryptedSha256,
      encrypted_bytes: size,
      object_key: store.keyFor(keys.artifact),
    };
    await store.putBuffer(keys.metadata, Buffer.from(`${JSON.stringify(storedMetadata, null, 2)}\n`, 'utf8'));

    return { plaintextSha256, encryptedSha256: encrypted.encryptedSha256, encryptedBytes: size, storedMetadata };
  } finally {
    await rm(encryptedPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Prove the configured credentials can really write, read, and delete in the
 * bucket — before a scheduled job depends on it at 03:00.
 */
async function commandVerifyStore(options) {
  const { configuration, store } = loadContext(options);
  const described = describeConfiguration(configuration);
  log(`Object store: ${described.store.bucket}/${described.store.prefix} at ${described.store.endpoint} (${described.store.region})`);
  log(`Credential sources: ${JSON.stringify(described.credentialSources)}`);

  const probeKey = `_probe/${nowIso().replace(/[:]/g, '')}-${process.pid}.txt`;
  const body = Buffer.from(`orgistry backup store probe ${nowIso()}\n`, 'utf8');

  await store.putBuffer(probeKey, body, { contentType: 'text/plain' });
  log(`  write   OK  ${store.keyFor(probeKey)}`);

  const readBack = await store.getText(probeKey);
  if (readBack !== body.toString('utf8')) {
    throw new Error('probe object read back with different content than was written');
  }
  log('  read    OK');

  const listed = await store.list('_probe/');
  if (!listed.some((object) => object.key === store.keyFor(probeKey))) {
    throw new Error('probe object was written but does not appear in a bucket listing');
  }
  log(`  list    OK  (${listed.length} object(s) under _probe/)`);

  await store.deleteObject(probeKey);
  if (await store.headObject(probeKey)) {
    throw new Error('probe object still exists after delete');
  }
  log('  delete  OK');
  log('Object store is writable, readable, listable, and deletable with the configured credentials.');
}

/** Take a logical backup with the REAL repository backup script and store it off-host. */
async function commandShipBackup(options) {
  const { configuration, encryptionKey, store } = loadContext(options);
  const startedAt = nowIso();
  const keepLocal = Number(options['keep-local'] ?? DEFAULT_LOCAL_COPIES);

  try {
    await ensureDirectory(configuration.backupDir);

    const scriptArguments = ['--output-dir', configuration.backupDir];
    if (configuration.databaseDockerNetwork) {
      scriptArguments.push('--docker-network', configuration.databaseDockerNetwork);
    }
    if (options.label) scriptArguments.push('--label', String(options.label));

    // The URL is handed over by ENVIRONMENT, never as an argument.
    const stdout = await runRepositoryScript(join(REPO_ROOT, 'tooling', 'db-backup.sh'), scriptArguments, {
      BACKUP_DATABASE_URL: configuration.databaseUrl,
    });

    const dumpPath = stdout.trim().split('\n').pop();
    if (!dumpPath || !dumpPath.endsWith('.dump')) {
      throw new Error('tooling/db-backup.sh did not report an artifact path');
    }
    const artifactName = dumpPath.slice(dumpPath.lastIndexOf('/') + 1);
    const metadataPath = `${dumpPath.slice(0, -'.dump'.length)}.meta.json`;
    const localMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));

    const keys = logicalObjectKeys(artifactName);
    const result = await encryptAndStore({
      store,
      encryptionKey,
      sourcePath: dumpPath,
      keys,
      workDir: configuration.backupDir,
      metadata: {
        ...localMetadata,
        source_environment: configuration.environment,
        source_host: hostname(),
        backup_kind: 'logical',
      },
    });

    log(`Stored ${store.keyFor(keys.artifact)} (${result.encryptedBytes} bytes encrypted)`);

    const removed = await pruneLocalCopies(configuration.backupDir, keepLocal);
    if (removed.length > 0) log(`Local lifecycle: removed ${removed.length} older local backup set(s)`);

    await recordRunState(configuration, 'last-backup-run', {
      result: 'succeeded',
      startedAt,
      finishedAt: nowIso(),
      artifact: artifactName,
      objectKey: store.keyFor(keys.artifact),
      encryptionKeyId: result.storedMetadata.encryption_key_id,
    });
  } catch (error) {
    await recordRunState(configuration, 'last-backup-run', {
      result: 'failed',
      startedAt,
      finishedAt: nowIso(),
      detail: String(error.message ?? error),
    });
    throw error;
  }
}

/**
 * Delete all but the newest `keep` local backup SETS (dump + checksum + meta).
 *
 * Local copies are a convenience for a fast restore, not the store. Keeping
 * every one of them fills the host's disk, which is a way to take the database
 * down with a backup programme.
 */
async function pruneLocalCopies(backupDir, keep) {
  if (!Number.isFinite(keep) || keep < 0) throw new Error('--keep-local must be a non-negative number');
  const entries = await readdir(backupDir).catch(() => []);
  const dumps = entries.filter((name) => name.endsWith('.dump')).sort();
  const doomed = dumps.slice(0, Math.max(0, dumps.length - keep));
  for (const name of doomed) {
    const base = name.slice(0, -'.dump'.length);
    await rm(join(backupDir, name), { force: true });
    await rm(join(backupDir, `${name}.sha256`), { force: true });
    await rm(join(backupDir, `${base}.meta.json`), { force: true });
  }
  return doomed;
}

/** Take a physical base backup — the basis every point-in-time recovery starts from. */
async function commandShipBaseBackup(options) {
  const { configuration, encryptionKey, store } = loadContext(options);
  const startedAt = nowIso();
  await ensureDirectory(configuration.backupDir);

  const stamp = startedAt.replace(/[-:]/g, '');
  const baseName = `orgistry-base-${stamp}`;
  const localPath = join(configuration.backupDir, `${baseName}.tar.gz`);

  try {
    // -Ft -z streams a compressed tar to stdout; -Xfetch embeds the WAL needed
    // to make THIS backup self-consistent. Recovery PAST the backup still comes
    // from the archive, which is what the PITR rehearsal proves.
    const output = createWriteStream(localPath, { mode: 0o600 });
    // Observe the stream BEFORE starting the transfer. Attaching a 'close'
    // listener afterwards races: the piped stream can already have closed by
    // the time pg_basebackup's container exits, and the listener would then
    // wait for an event that has already happened — forever.
    const outputSettled = finished(output).catch(() => {});
    await runPostgresClient({
      command: 'pg_basebackup --dbname "$ORGISTRY_PG_URL" --format=tar --gzip --wal-method=fetch --pgdata=- --no-password',
      databaseUrl: configuration.databaseUrl,
      dockerNetwork: configuration.databaseDockerNetwork,
      stdoutStream: output,
    });
    await outputSettled;

    const { size } = await stat(localPath);
    if (size === 0) throw new Error('pg_basebackup produced an empty archive');

    // Provenance the catalog shows beside every other recovery point. Asked for
    // in one round trip and tolerant of failure: a base backup that exists is
    // worth more than one rejected because a provenance query did not answer.
    const [provenance] = await queryRows({
      statement: `SELECT pg_walfile_name(pg_current_wal_lsn())
               || '|' || current_database()
               || '|' || (SELECT count(*)::text FROM drizzle.__drizzle_migrations)
               || '|' || current_setting('server_version')`,
      databaseUrl: configuration.databaseUrl,
      dockerNetwork: configuration.databaseDockerNetwork,
    }).catch(() => [['']]);
    const [walStart, databaseName, migrationCount, serverVersion] = String(provenance?.[0] ?? '').split('|');

    const keys = baseBackupObjectKeys(baseName);
    const result = await encryptAndStore({
      store,
      encryptionKey,
      sourcePath: localPath,
      keys,
      workDir: configuration.backupDir,
      metadata: {
        artifact: `${baseName}.tar.gz`,
        created_at: startedAt,
        backup_kind: 'base',
        format: 'pg_basebackup tar+gzip, --wal-method=fetch',
        source_environment: configuration.environment,
        source_host: hostname(),
        database: databaseName ?? '',
        postgres_server_version: serverVersion ?? '',
        applied_migrations: migrationCount ? Number(migrationCount) : null,
        bytes: size,
        wal_range_start: walStart ?? '',
      },
    });

    log(`Stored ${store.keyFor(keys.artifact)} (${result.encryptedBytes} bytes encrypted)`);
    await recordRunState(configuration, 'last-base-backup-run', {
      result: 'succeeded',
      startedAt,
      finishedAt: nowIso(),
      artifact: `${baseName}.tar.gz`,
      objectKey: store.keyFor(keys.artifact),
    });
  } catch (error) {
    await recordRunState(configuration, 'last-base-backup-run', {
      result: 'failed',
      startedAt,
      finishedAt: nowIso(),
      detail: String(error.message ?? error),
    });
    throw error;
  } finally {
    // The base backup is large and its off-host copy is the one that matters.
    await rm(localPath, { force: true });
  }
}

/**
 * Ship every WAL segment PostgreSQL has archived into the local spool.
 *
 * The spool exists so `archive_command` never blocks on the network: PostgreSQL
 * copies a segment to a local directory (fast, and it cannot fail because a
 * bucket is briefly unreachable), and this job moves it off-host. A segment is
 * deleted from the spool ONLY after its stored object has been read back, so a
 * failed shipment simply retries on the next run.
 */
async function commandShipWal(options) {
  const { configuration, encryptionKey, store } = loadContext(options);
  const startedAt = nowIso();

  if (!configuration.walSpoolDir) {
    throw new Error('ORGISTRY_BACKUP_WAL_SPOOL_DIR is not configured — there is no WAL spool to ship');
  }

  let shipped = 0;
  try {
    const entries = (await readdir(configuration.walSpoolDir).catch(() => []))
      .filter((name) => WAL_FILE_PATTERN.test(name))
      .sort();

    for (const segment of entries) {
      const spoolPath = join(configuration.walSpoolDir, segment);
      const encryptedPath = `${spoolPath}.enc.tmp`;
      const plaintextSha256 = await sha256File(spoolPath);
      try {
        const encrypted = await encryptFile({
          sourcePath: spoolPath,
          destinationPath: encryptedPath,
          key: encryptionKey,
          plaintextSha256,
          plaintextName: segment,
        });
        const { size } = await stat(encryptedPath);
        const key = walObjectKey(segment);
        await store.putFile(key, encryptedPath, { contentSha256: encrypted.encryptedSha256, contentLength: size });
        const stored = await store.headObject(key);
        if (!stored || stored.bytes !== size) {
          throw new Error(`WAL segment ${segment} did not read back from the store at the expected size`);
        }
        await rm(spoolPath, { force: true });
        shipped += 1;
      } finally {
        await rm(encryptedPath, { force: true });
      }
    }

    log(`Shipped ${shipped} WAL segment(s) off-host.`);
    await recordRunState(configuration, 'last-wal-ship', {
      result: 'succeeded',
      startedAt,
      finishedAt: nowIso(),
      shipped,
    });
  } catch (error) {
    await recordRunState(configuration, 'last-wal-ship', {
      result: 'failed',
      startedAt,
      finishedAt: nowIso(),
      shipped,
      detail: String(error.message ?? error),
    });
    throw error;
  }
}

/** Build the catalog by reading what is really in the bucket. */
async function readCatalog(configuration, store) {
  const [logicalObjects, baseObjects, walObjects] = await Promise.all([
    store.list(OBJECT_LAYOUT.logical),
    store.list(OBJECT_LAYOUT.baseBackup),
    store.list(OBJECT_LAYOUT.wal),
  ]);

  const collect = async (objects, kind, retentionDays) => {
    const metadataObjects = objects.filter((object) => object.key.endsWith('.meta.json'));
    const points = [];
    for (const metadataObject of metadataObjects) {
      const relativeKey = metadataObject.key.slice(store.keyFor('').length);
      const document = await store.getText(relativeKey);
      if (!document) continue;
      const metadata = JSON.parse(document);
      const storedObject = objects.find((object) => object.key === metadata.object_key);
      points.push(buildRecoveryPoint({ metadata, storedObject, retentionDays, kind }));
    }
    return points;
  };

  return buildCatalog({
    target: store.describeTarget(),
    logicalPoints: await collect(logicalObjects, 'logical', configuration.retention.logicalDays),
    basePoints: await collect(baseObjects, 'base', configuration.retention.logicalDays),
    walObjects: walObjects.filter((object) => object.key.endsWith('.enc')),
    generatedAt: nowIso(),
  });
}

async function commandCatalog(options) {
  const { configuration, store } = loadContext(options);
  const catalog = await readCatalog(configuration, store);
  log(options.json ? JSON.stringify(catalog, null, 2) : renderCatalog(catalog));
}

async function commandHealth(options) {
  const { configuration, store } = loadContext(options);
  const catalog = await readCatalog(configuration, store);
  const result = evaluateBackupHealth({
    catalog,
    now: nowIso(),
    thresholds: configuration.thresholds,
    lastRun: await readRunState(configuration, 'last-backup-run'),
  });
  log(options.json ? JSON.stringify(result, null, 2) : renderHealth('Backup health', result));
  if (!result.healthy) process.exitCode = 1;
}

/**
 * Read `pg_stat_archiver` and the archive settings from the SOURCE database.
 *
 * Timestamps come back as epoch SECONDS rather than formatted text. A
 * `to_char` format string is full of characters that mean something to both
 * SQL and a shell, and getting one of them wrong produces a plausible-looking
 * value rather than an error — which is exactly what an operational check must
 * not do. A number cannot be mis-formatted.
 */
async function readArchiverState(configuration) {
  const [row] = await queryRows({
    statement: `SELECT current_setting('archive_mode')
             || '|' || archived_count::text
             || '|' || coalesce(extract(epoch from last_archived_time)::text, '')
             || '|' || failed_count::text
             || '|' || coalesce(extract(epoch from last_failed_time)::text, '')
             || '|' || coalesce(last_failed_wal, '')
             || '|' || coalesce(last_archived_wal, '')
             || '|' || pg_walfile_name(pg_current_wal_lsn())
             || '|' || (pg_walfile_name_offset(pg_current_wal_lsn())).file_offset::text
        FROM pg_stat_archiver`,
    databaseUrl: configuration.databaseUrl,
    dockerNetwork: configuration.databaseDockerNetwork,
  });

  const [
    archiveMode,
    archivedCount,
    archivedEpoch,
    failedCount,
    failedEpoch,
    lastFailedWal,
    lastArchivedWal,
    currentWalFile,
    currentWalOffset,
  ] = String(row?.[0] ?? '').split('|');

  const toIso = (epochSeconds) =>
    epochSeconds ? new Date(Number(epochSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';

  return {
    archiveMode,
    archivedCount: Number(archivedCount || 0),
    lastArchivedTime: toIso(archivedEpoch),
    failedCount: Number(failedCount || 0),
    lastFailedTime: toIso(failedEpoch),
    lastFailedWal,
    lastArchivedWal,
    currentWalFile,
    pendingWalBytes: Number(currentWalOffset || 0),
    walPending: Number(currentWalOffset || 0) > EMPTY_WAL_SEGMENT_ALLOWANCE_BYTES,
  };
}

/** Describe the local spool: how many segments are waiting, and for how long. */
async function readSpoolState(configuration) {
  if (!configuration.walSpoolDir) return { pendingSegments: 0, oldestPendingAgeMinutes: 0 };
  const entries = (await readdir(configuration.walSpoolDir).catch(() => [])).filter((name) =>
    WAL_FILE_PATTERN.test(name),
  );
  let oldest = Date.now();
  for (const name of entries) {
    const { mtimeMs } = await stat(join(configuration.walSpoolDir, name));
    oldest = Math.min(oldest, mtimeMs);
  }
  return {
    pendingSegments: entries.length,
    oldestPendingAgeMinutes: entries.length === 0 ? 0 : (Date.now() - oldest) / 60_000,
  };
}

async function commandWalHealth(options) {
  const { configuration, store } = loadContext(options);
  const walObjects = (await store.list(OBJECT_LAYOUT.wal)).filter((object) => object.key.endsWith('.enc'));
  const result = evaluateWalArchiveHealth({
    archiver: await readArchiverState(configuration),
    spool: await readSpoolState(configuration),
    walWindow: summariseWalWindow(walObjects),
    now: nowIso(),
    thresholds: configuration.thresholds,
  });
  log(options.json ? JSON.stringify(result, null, 2) : renderHealth('WAL archive health', result));
  if (!result.healthy) process.exitCode = 1;
}

/** Retrieve one stored object, decrypting it unless `--raw` was asked for. */
async function commandFetch(options) {
  const { encryptionKey, store } = loadContext(options);
  if (!options.key || options.key === true) throw new Error('--key is required');
  if (!options.output || options.output === true) throw new Error('--output is required');

  const output = resolve(String(options.output));
  await ensureDirectory(dirname(output));

  if (options.raw) {
    await store.getFile(String(options.key), output);
    log(`Fetched ${store.keyFor(String(options.key))} -> ${output} (still encrypted)`);
    return;
  }

  const encryptedPath = `${output}.enc.tmp`;
  try {
    await store.getFile(String(options.key), encryptedPath);
    const { header } = await decryptFile({ sourcePath: encryptedPath, destinationPath: output, key: encryptionKey });
    log(`Fetched and decrypted ${store.keyFor(String(options.key))} -> ${output}`);
    log(`  artifact ${header.plaintextName}, ${header.plaintextBytes} bytes, digest verified against backup time`);
  } finally {
    await rm(encryptedPath, { force: true });
  }
}

/**
 * Retrieve and decrypt every archived WAL segment into one directory.
 *
 * A point-in-time recovery needs the whole unbroken chain from the base backup
 * forward, so this fetches the archive wholesale rather than segment by
 * segment. The output directory is what a recovery target's `restore_command`
 * reads from, which is why the segments land under their ORIGINAL names — a
 * `restore_command` looks a segment up by name and nothing else.
 */
async function commandFetchWal(options) {
  const { encryptionKey, store } = loadContext(options);
  if (!options.output || options.output === true) throw new Error('--output is required (a directory)');
  const destination = resolve(String(options.output));
  await ensureDirectory(destination);

  const objects = (await store.list(OBJECT_LAYOUT.wal)).filter((object) => object.key.endsWith('.enc'));
  const since = typeof options.since === 'string' ? options.since : '';

  let fetched = 0;
  for (const object of objects) {
    const segment = walSegmentName(object.key);
    // WAL segment names sort lexicographically in write order, so a plain
    // comparison is the correct "everything from here onwards" filter.
    if (since && segment.length === since.length && segment < since) continue;

    const encryptedPath = join(destination, `${segment}.enc.tmp`);
    try {
      await store.getFile(walObjectKey(segment), encryptedPath);
      await decryptFile({ sourcePath: encryptedPath, destinationPath: join(destination, segment), key: encryptionKey });
      fetched += 1;
    } finally {
      await rm(encryptedPath, { force: true });
    }
  }
  log(`Retrieved and decrypted ${fetched} WAL segment(s) into ${destination}`);
}

/**
 * Apply the backup artifact lifecycle.
 *
 * Two safety properties, both deliberate:
 *   * `logicalMinimum` recovery points are ALWAYS kept regardless of age, so a
 *     misconfigured retention window can never leave the environment with no
 *     backup at all.
 *   * WAL is never pruned past the oldest RETAINED base backup. Deleting WAL
 *     that a surviving base backup still needs silently destroys the recovery
 *     window while every artifact still appears to be present.
 */
async function commandPrune(options) {
  const { configuration, store } = loadContext(options);
  const dryRun = Boolean(options['dry-run']);
  const catalog = await readCatalog(configuration, store);
  const olderThanLogicalWindow = Date.now() - configuration.retention.logicalDays * 86_400_000;

  // `slice(minimum)` protects the newest N recovery points unconditionally.
  // Both lists are already newest-first.
  const expendableLogical = catalog.logical
    .slice(configuration.retention.logicalMinimum)
    .filter((point) => Date.parse(point.takenAt) < olderThanLogicalWindow);
  const expendableBases = catalog.baseBackups
    .slice(1)
    .filter((point) => Date.parse(point.takenAt) < olderThanLogicalWindow);

  const deletePoint = async (point, keys, kind) => {
    log(`${dryRun ? 'would delete' : 'deleting'} ${kind} ${point.id} (taken ${point.takenAt})`);
    if (dryRun) return;
    await store.deleteObject(keys.artifact);
    await store.deleteObject(keys.metadata);
  };

  for (const point of expendableLogical) {
    await deletePoint(point, logicalObjectKeys(point.id), 'logical backup');
  }
  for (const point of expendableBases) {
    await deletePoint(point, baseBackupObjectKeys(point.id.replace(/\.tar\.gz$/, '')), 'base backup');
  }

  // WAL older than the oldest SURVIVING base backup is unusable for recovery,
  // but WAL that a surviving base backup still needs must never be deleted —
  // that would destroy the recovery window while every artifact still looks
  // present. The cutoff is therefore the EARLIER of the two boundaries.
  const survivingBases = catalog.baseBackups.filter((point) => !expendableBases.includes(point));
  const oldestSurvivingBaseAt =
    survivingBases.length > 0
      ? Date.parse(survivingBases[survivingBases.length - 1].takenAt)
      : Number.POSITIVE_INFINITY;
  const walCutoff = Math.min(Date.now() - configuration.retention.walDays * 86_400_000, oldestSurvivingBaseAt);

  const walObjects = (await store.list(OBJECT_LAYOUT.wal)).filter((object) => object.key.endsWith('.enc'));
  let prunedWal = 0;
  for (const object of walObjects) {
    if (Date.parse(object.lastModified) >= walCutoff) continue;
    prunedWal += 1;
    if (!dryRun) await store.deleteObject(walObjectKey(walSegmentName(object.key)));
  }
  log(`${dryRun ? 'would delete' : 'deleted'} ${prunedWal} WAL segment(s) outside the retained recovery window`);

  log(
    `Lifecycle: always keep the newest ${configuration.retention.logicalMinimum} logical backups and the newest base ` +
      `backup; beyond that keep ${configuration.retention.logicalDays} days of backups and ` +
      `${configuration.retention.walDays} days of WAL, never past the oldest surviving base backup.`,
  );
  if (!dryRun) {
    await recordRunState(configuration, 'last-prune-run', {
      result: 'succeeded',
      finishedAt: nowIso(),
      logicalDeleted: expendableLogical.length,
      baseDeleted: expendableBases.length,
      walDeleted: prunedWal,
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const COMMANDS = {
  'verify-store': commandVerifyStore,
  'ship-backup': commandShipBackup,
  'ship-base-backup': commandShipBaseBackup,
  'ship-wal': commandShipWal,
  catalog: commandCatalog,
  health: commandHealth,
  'wal-health': commandWalHealth,
  fetch: commandFetch,
  'fetch-wal': commandFetchWal,
  prune: commandPrune,
};

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const commandName = options._[0];

  if (!commandName || options.help) {
    log(usage());
    return;
  }
  const command = COMMANDS[commandName];
  if (!command) {
    fail(`unknown command "${commandName}"\n\n${usage()}`);
    return;
  }

  try {
    await command(options);
  } catch (error) {
    // Error messages from this tooling are written to be actionable and are
    // audited to contain no credential; the stack is suppressed because it adds
    // nothing an operator can act on during an incident, but the cause chain is
    // kept because that is where a transport failure explains itself.
    fail(error);
  }
}

// Unhandled stream/`fetch` rejections must not exit 0 and look like success.
process.on('unhandledRejection', (reason) => {
  fail(`unhandled rejection: ${String(reason)}`);
  process.exit(1);
});

// Run only when invoked as a program. The module is also imported by
// tooling/backup-ops.test.ts, which must not execute a command as a side effect
// of loading it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { parseArguments, pruneLocalCopies, WAL_FILE_PATTERN };
