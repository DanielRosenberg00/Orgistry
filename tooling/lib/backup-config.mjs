/**
 * Backup programme configuration (Sprint 28, ORG-PR-005).
 *
 * ONE configuration file describes the whole backup programme for ONE
 * environment: where the database is, where artifacts are staged locally, which
 * off-host bucket receives them, which key encrypts them, and how long anything
 * is kept. The scheduler, the health checks, the catalog, and both rehearsals
 * all read it, so an operator changes a retention window or a bucket in exactly
 * one place.
 *
 * SECRET BOUNDARY — the reason values are split the way they are
 * The configuration file itself is NOT a secret store. The database URL, the
 * object-store secret key, and the encryption key each live in their OWN
 * mode-0600 file, named by a `*_FILE` variable. That keeps the configuration
 * file diffable, reviewable, and safe to quote in an operator runbook, and it
 * matches the host's existing convention (`/opt/orgistry/config/postgres-password`,
 * `jwt-secret`). Inline values are accepted for CI and rehearsal use, where the
 * values are throwaway.
 *
 * Nothing here logs a value. `describeConfiguration()` returns the non-secret
 * subset that evidence and health output are allowed to contain, and it is the
 * only shape those callers may print.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Defaults chosen to be safe rather than convenient — see docs/backup-and-restore.md. */
export const BACKUP_DEFAULTS = {
  storePathStyle: true,
  retainLogicalDays: 30,
  retainLogicalMinimum: 7,
  retainWalDays: 8,
  backupMaxAgeHours: 26,
  walMaxAgeMinutes: 15,
};

/**
 * Parse a KEY=VALUE configuration file.
 *
 * Identical semantics to `deploy_load_config` in tooling/lib/deploy-common.sh:
 * a strict subset of shell that is PARSED, never sourced, so an operator
 * configuration file cannot execute anything as a side effect of a backup run.
 */
export function parseConfigFile(text, sourceLabel = 'configuration') {
  const values = {};
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;

    const separator = line.indexOf('=');
    if (separator === -1) {
      throw new Error(`${sourceLabel}:${index + 1} is not a KEY=VALUE line`);
    }
    const key = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`${sourceLabel}:${index + 1} has an invalid key "${key}" (expected UPPER_SNAKE_CASE)`);
    }
    let value = line.slice(separator + 1);
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });
  return values;
}

/**
 * Read a secret out of its own file.
 *
 * Refuses a group- or world-readable file. A backup programme whose credentials
 * are readable by every account on the host is not a credential boundary, and
 * discovering that during an incident is too late.
 */
export function readSecretFile(path, description) {
  const absolute = resolve(path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new Error(`${description} file not found at ${absolute}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `${description} file ${absolute} is group- or world-readable (mode ${(stats.mode & 0o777).toString(8)}); ` +
        'run: chmod 600 ' + absolute,
    );
  }
  const value = readFileSync(absolute, 'utf8').trim();
  if (value === '') throw new Error(`${description} file ${absolute} is empty`);
  return value;
}

function requiredValue(values, name) {
  const value = values[name];
  if (!value) throw new Error(`${name} is not set in the backup configuration`);
  return value;
}

function positiveNumber(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}")`);
  }
  return parsed;
}

function booleanValue(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'on' || raw === 'true') return true;
  if (raw === 'off' || raw === 'false') return false;
  throw new Error(`${name} must be "on" or "off" (got "${raw}")`);
}

/**
 * Resolve one secret from either a `*_FILE` variable or an inline variable.
 *
 * The file form is what a real environment uses. The inline form exists for CI
 * and rehearsals, where the value is generated per-run and thrown away; it is
 * accepted rather than encouraged, and the resolved SOURCE is reported so
 * evidence can state which form was in use without revealing the value.
 */
function resolveSecret(values, baseName, description) {
  const filePath = values[`${baseName}_FILE`];
  if (filePath) return { value: readSecretFile(filePath, description), source: 'file' };
  const inline = values[baseName];
  if (inline) return { value: inline, source: 'inline' };
  throw new Error(`${baseName}_FILE (preferred) or ${baseName} must be set for ${description}`);
}

/**
 * Build the resolved configuration.
 *
 * `values` normally comes from `parseConfigFile` merged over `process.env`, so
 * a single variable can be overridden for a one-off run without editing the
 * file — which is how the rehearsals point at a throwaway prefix.
 */
export function resolveBackupConfiguration(values) {
  const environment = requiredValue(values, 'ORGISTRY_BACKUP_ENVIRONMENT');
  if (!/^[a-z][a-z0-9-]*$/.test(environment)) {
    throw new Error(
      `ORGISTRY_BACKUP_ENVIRONMENT must be a lowercase dashed name (got "${environment}") — ` +
        'it namespaces every stored object and must be stable for the life of the environment',
    );
  }

  const database = resolveSecret(values, 'ORGISTRY_BACKUP_DATABASE_URL', 'backup database URL');
  const encryptionKey = resolveSecret(values, 'ORGISTRY_BACKUP_ENCRYPTION_KEY', 'backup encryption key');
  const storeSecret = resolveSecret(
    values,
    'ORGISTRY_BACKUP_STORE_SECRET_ACCESS_KEY',
    'object-store secret access key',
  );

  return {
    environment,
    databaseUrl: database.value,
    databaseUrlSource: database.source,
    databaseDockerNetwork: values.ORGISTRY_BACKUP_DATABASE_DOCKER_NETWORK ?? '',
    backupDir: resolve(requiredValue(values, 'ORGISTRY_BACKUP_DIR')),
    walSpoolDir: values.ORGISTRY_BACKUP_WAL_SPOOL_DIR ? resolve(values.ORGISTRY_BACKUP_WAL_SPOOL_DIR) : '',
    stateDir: resolve(values.ORGISTRY_BACKUP_STATE_DIR ?? `${requiredValue(values, 'ORGISTRY_BACKUP_DIR')}/state`),
    encryptionKey: encryptionKey.value,
    encryptionKeySource: encryptionKey.source,
    store: {
      endpoint: requiredValue(values, 'ORGISTRY_BACKUP_STORE_ENDPOINT'),
      region: requiredValue(values, 'ORGISTRY_BACKUP_STORE_REGION'),
      bucket: requiredValue(values, 'ORGISTRY_BACKUP_STORE_BUCKET'),
      prefix: values.ORGISTRY_BACKUP_STORE_PREFIX || `orgistry/${environment}`,
      accessKeyId: requiredValue(values, 'ORGISTRY_BACKUP_STORE_ACCESS_KEY_ID'),
      secretAccessKey: storeSecret.value,
      forcePathStyle: booleanValue(values, 'ORGISTRY_BACKUP_STORE_PATH_STYLE', BACKUP_DEFAULTS.storePathStyle),
    },
    storeSecretSource: storeSecret.source,
    retention: {
      logicalDays: positiveNumber(values, 'ORGISTRY_BACKUP_RETAIN_LOGICAL_DAYS', BACKUP_DEFAULTS.retainLogicalDays),
      logicalMinimum: positiveNumber(
        values,
        'ORGISTRY_BACKUP_RETAIN_LOGICAL_MIN',
        BACKUP_DEFAULTS.retainLogicalMinimum,
      ),
      walDays: positiveNumber(values, 'ORGISTRY_BACKUP_RETAIN_WAL_DAYS', BACKUP_DEFAULTS.retainWalDays),
    },
    thresholds: {
      backupMaxAgeHours: positiveNumber(
        values,
        'ORGISTRY_BACKUP_MAX_AGE_HOURS',
        BACKUP_DEFAULTS.backupMaxAgeHours,
      ),
      walMaxAgeMinutes: positiveNumber(
        values,
        'ORGISTRY_BACKUP_WAL_MAX_AGE_MINUTES',
        BACKUP_DEFAULTS.walMaxAgeMinutes,
      ),
    },
  };
}

/** Load configuration from a file, letting the environment override single values. */
export function loadBackupConfiguration(configPath, environmentOverrides = process.env) {
  const fromFile = configPath ? parseConfigFile(readFileSync(configPath, 'utf8'), configPath) : {};
  const merged = { ...fromFile };
  for (const [key, value] of Object.entries(environmentOverrides)) {
    if (key.startsWith('ORGISTRY_BACKUP_') && value) merged[key] = value;
  }
  return resolveBackupConfiguration(merged);
}

/**
 * The subset of configuration that may appear in logs, health output, and
 * operator evidence. Every field here is non-secret by construction; the secret
 * fields are represented by their SOURCE, never their value.
 */
export function describeConfiguration(configuration) {
  return {
    environment: configuration.environment,
    backupDir: configuration.backupDir,
    walSpoolDir: configuration.walSpoolDir || '(not configured)',
    store: {
      endpoint: configuration.store.endpoint,
      region: configuration.store.region,
      bucket: configuration.store.bucket,
      prefix: configuration.store.prefix,
      addressing: configuration.store.forcePathStyle ? 'path' : 'virtual-host',
    },
    credentialSources: {
      databaseUrl: configuration.databaseUrlSource,
      encryptionKey: configuration.encryptionKeySource,
      objectStoreSecret: configuration.storeSecretSource,
    },
    retention: configuration.retention,
    thresholds: configuration.thresholds,
  };
}
