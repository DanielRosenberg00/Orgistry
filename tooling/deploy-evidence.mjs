#!/usr/bin/env node
//
// Deployment evidence CLI (Sprint 26, ORG-PR-001).
//
// Owns the on-disk deployment ledger for one environment. The model and its
// invariants live in tooling/lib/deploy-evidence.mjs; this file is the command
// surface tooling/deploy.sh and tooling/deploy-rollback.sh call.
//
// Ledger layout (--dir <root>, one subtree per environment):
//
//   <root>/<environment>/records/<timestamp>-<commit12>-<mode>.json
//   <root>/<environment>/releases/<commit>-<apiDigest12>.json   (manifest copy)
//   <root>/<environment>/current.json                           (newest record)
//
// The manifest copy is what makes an application rollback self-contained: the
// exact digests of every previously deployed release stay on the deployment
// host, so a rollback never depends on a registry API, a workflow artifact
// that may have expired, or an operator remembering a SHA.
//
// Usage:
//   deploy-evidence.mjs record --dir DIR --environment E --mode deploy|rollback \
//       --actor A --manifest PATH \
//       --migration-result applied|skipped|failed [--migration-reason R] \
//       [--migration-verified-head H] [--migration-applied-count N] \
//       --backup-result taken|skipped|unavailable|failed [--backup-reason R] \
//       [--backup-artifact NAME] [--backup-recovery-point ISO] \
//       [--backup-protection verified|degraded-accepted|not-configured|disabled] \
//       --smoke-result passed|failed|not-run [--smoke-checks N] \
//       --runtime-api-digest D --runtime-web-digest D \
//       --public-api-base-url URL [--public-csrf-header-name N] [--public-mailpit-url URL] \
//       [--limitation TEXT ...]
//
//   deploy-evidence.mjs rollback-target --dir DIR --environment E [--field NAME]
//   deploy-evidence.mjs current --dir DIR --environment E [--field DOTTED.PATH]
//   deploy-evidence.mjs validate PATH
//
// No command accepts or emits a secret; `record` refuses to write a record
// that contains anything credential-shaped.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  buildDeploymentRecord,
  buildPublicConfigIdentity,
  selectRollbackTarget,
  toRollbackTarget,
  validateDeploymentRecord,
} from './lib/deploy-evidence.mjs';
import { readField, validateReleaseManifest } from './lib/release-manifest.mjs';

/** Options that may be repeated; every other flag takes a single value. */
const REPEATABLE_OPTIONS = new Set(['limitation']);

function die(message) {
  console.error(`deploy-evidence: ${message}`);
  process.exit(1);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      die(`unexpected argument "${argument}"`);
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`option ${argument} requires a value`);
    }
    if (REPEATABLE_OPTIONS.has(name)) {
      options[name] = [...(options[name] ?? []), value];
    } else if (options[name] !== undefined) {
      die(`option ${argument} was given more than once`);
    } else {
      options[name] = value;
    }
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    die(`--${name} is required`);
  }
  return value;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`cannot read ${path}: ${error.message}`);
  }
}

function environmentPaths(options) {
  const root = requireOption(options, 'dir');
  const environment = requireOption(options, 'environment');
  const base = join(root, environment);
  return {
    environment,
    base,
    records: join(base, 'records'),
    releases: join(base, 'releases'),
    current: join(base, 'current.json'),
  };
}

/** Every record in the ledger, oldest first. Missing directory = no history. */
function readRecords(recordsDir) {
  let names;
  try {
    names = readdirSync(recordsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => readJsonFile(join(recordsDir, name)));
}

function readCurrentRecord(currentPath) {
  try {
    return JSON.parse(readFileSync(currentPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Filesystem-safe stamp: 2026-08-24T09:12:33.101Z -> 20260824T091233101Z. */
function compactTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/[-:]/g, '').replace('.', '');
}

function optionalInteger(options, name) {
  const raw = options[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    die(`--${name} must be a non-negative integer`);
  }
  return value;
}

/** Resolve an observed runtime digest, where the literal `none` means null. */
function runtimeDigest(options, name) {
  const value = requireOption(options, name);
  return value === 'none' ? null : value;
}

/** Drop undefined members so absent facts are absent, not null. */
function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function commandRecord(argv) {
  const options = parseOptions(argv);
  const paths = environmentPaths(options);

  const manifestPath = requireOption(options, 'manifest');
  const manifest = readJsonFile(manifestPath);
  const manifestCheck = validateReleaseManifest(manifest);
  if (!manifestCheck.valid) {
    die(`refusing to record a deployment of an invalid release manifest (${manifestPath}): ${manifestCheck.issues.join('; ')}`);
  }

  const deployedAt = options['deployed-at'] ?? new Date().toISOString();
  const commit = manifest.source.commit;
  const apiDigestShort = manifest.images.api.digest.slice('sha256:'.length, 'sha256:'.length + 12);
  const manifestFile = join('releases', `${commit}-${apiDigestShort}.json`);

  const existingRecords = readRecords(paths.records);

  const record = buildDeploymentRecord({
    environment: paths.environment,
    mode: requireOption(options, 'mode'),
    actor: requireOption(options, 'actor'),
    deployedAt,
    manifest,
    manifestFile,
    migration: compact({
      result: requireOption(options, 'migration-result'),
      reason: options['migration-reason'],
      verifiedHead: options['migration-verified-head'],
      appliedCount: optionalInteger(options, 'migration-applied-count'),
    }),
    backupPreflight: compact({
      result: requireOption(options, 'backup-result'),
      reason: options['backup-reason'],
      artifact: options['backup-artifact'],
      recoveryPoint: options['backup-recovery-point'],
      // Sprint 28: whether the environment's ongoing backup programme was
      // verified healthy at deployment time. A pre-deployment backup proves a
      // recovery point exists for THIS deployment; this proves the environment
      // was actually protected when the deployment happened. Different claims.
      protection: options['backup-protection'],
    }),
    smoke: compact({
      result: requireOption(options, 'smoke-result'),
      checks: optionalInteger(options, 'smoke-checks'),
    }),
    runtimeDigests: {
      // `none` is the explicit spelling for "this service was never started",
      // which a deployment that failed before starting containers must be able
      // to record without inventing a digest.
      api: runtimeDigest(options, 'runtime-api-digest'),
      web: runtimeDigest(options, 'runtime-web-digest'),
    },
    // Deployment-scoped PUBLIC browser configuration. The builder refuses any
    // key outside the published public contract, so a secret cannot be recorded
    // here even by mistake.
    publicConfig: buildPublicConfigIdentity({
      apiBaseUrl: requireOption(options, 'public-api-base-url'),
      csrfHeaderName: options['public-csrf-header-name'] ?? 'x-orgistry-csrf',
      mailpitUrl: options['public-mailpit-url'] ?? 'http://localhost:8025',
    }),
    limitations: options.limitation ?? [],
  });

  // The rollback target is resolved against the history that existed BEFORE
  // this deployment, excluding the release now being deployed.
  record.rollbackTarget = toRollbackTarget(selectRollbackTarget(existingRecords, record));

  const check = validateDeploymentRecord(record);
  if (!check.valid) {
    die(`refusing to write an invalid deployment record: ${check.issues.join('; ')}`);
  }

  mkdirSync(paths.records, { recursive: true });
  mkdirSync(paths.releases, { recursive: true });
  copyFileSync(manifestPath, join(paths.base, manifestFile));

  const recordPath = join(
    paths.records,
    `${compactTimestamp(deployedAt)}-${commit.slice(0, 12)}-${record.mode}.json`,
  );
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(recordPath, serialized, 'utf8');
  writeFileSync(paths.current, serialized, 'utf8');
  console.log(recordPath);
}

function commandRollbackTarget(argv) {
  const options = parseOptions(argv);
  const paths = environmentPaths(options);
  const current = readCurrentRecord(paths.current);
  const target = selectRollbackTarget(readRecords(paths.records), current);

  if (target === null) {
    die(
      `no previous known-good release is recorded for environment "${paths.environment}" — ` +
        'an application rollback needs at least one earlier deployment whose smoke passed',
    );
  }

  const manifestPath = join(paths.base, target.release.manifestFile);
  // One named field per call (`--field apiImage`), or the whole object as JSON.
  // Shell callers read individual fields rather than `eval`ing assignments, so
  // no value here can ever be interpreted as a command.
  const fields = {
    commit: target.release.commit,
    apiImage: target.release.apiReference,
    webImage: target.release.webReference,
    manifestPath,
    deployedAt: target.deployedAt,
    // The public configuration that was in effect for that release, so a
    // rollback can report whether it is restoring digests only, or digests
    // under a configuration that has since changed.
    publicConfigFingerprint: target.publicConfig?.fingerprint ?? null,
    publicApiBaseUrl: target.publicConfig?.values?.apiBaseUrl ?? null,
  };

  if (options.field === undefined) {
    console.log(JSON.stringify(fields, null, 2));
    return;
  }
  const value = readField(fields, options.field);
  if (value === undefined || value === null) {
    die(`the resolved rollback target has no value at "${options.field}"`);
  }
  console.log(String(value));
}

function commandCurrent(argv) {
  const options = parseOptions(argv);
  const paths = environmentPaths(options);
  const current = readCurrentRecord(paths.current);
  if (current === null) {
    die(`no deployment has been recorded for environment "${paths.environment}"`);
  }
  if (options.field === undefined) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  const value = readField(current, options.field);
  if (value === undefined || value === null) {
    die(`current deployment record has no value at "${options.field}"`);
  }
  console.log(String(value));
}

function commandValidate(argv) {
  const [path, ...rest] = argv;
  if (path === undefined || rest.length > 0) {
    die('usage: deploy-evidence.mjs validate PATH');
  }
  const { valid, issues } = validateDeploymentRecord(readJsonFile(path));
  if (!valid) {
    console.error(`deploy-evidence: ${path} is not a valid deployment record:`);
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }
  console.log(`deploy-evidence: ${basename(path)} is valid`);
}

const [command, ...argv] = process.argv.slice(2);
switch (command) {
  case 'record':
    commandRecord(argv);
    break;
  case 'rollback-target':
    commandRollbackTarget(argv);
    break;
  case 'current':
    commandCurrent(argv);
    break;
  case 'validate':
    commandValidate(argv);
    break;
  default:
    die('usage: deploy-evidence.mjs <record|rollback-target|current|validate> [options]');
}
