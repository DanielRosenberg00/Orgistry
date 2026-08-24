/**
 * Deployment evidence model (Sprint 26, ORG-PR-001).
 *
 * A deployment record answers five questions for one environment, without
 * access to the deployment host:
 *
 *   1. Exactly what code and container digests are running here?
 *   2. What public runtime configuration was applied to them?
 *   3. What release authorised those digests, and what gate runs authorised
 *      that release?
 *   4. What exact digests — and matching configuration — would an application
 *      rollback restore?
 *   5. Did migrations, the backup preflight, and smoke actually succeed?
 *
 * It is deliberately separate from the release manifest
 * (tooling/lib/release-manifest.mjs): a manifest records what a BUILD produced
 * and can only contain build-time facts; a record adds what a DEPLOYMENT
 * observed — migration outcome, backup preflight, smoke result, and the
 * rollback target that was known good at that moment.
 *
 * Records are append-only. `tooling/deploy.sh` writes one per deployment
 * attempt, including failed ones: a record whose smoke failed is evidence, and
 * silently dropping it would make the ledger describe a tidier history than
 * actually happened.
 *
 * Nothing in a record is secret. The same credential guard the release
 * manifest uses is applied here, because these files are copied into pull
 * requests, issue threads, and sprint artifacts.
 */

import { createHash } from 'node:crypto';
import { findEmbeddedCredential } from './release-manifest.mjs';

export const DEPLOYMENT_RECORD_KIND = 'orgistry.deployment-record';
export const DEPLOYMENT_RECORD_SCHEMA_VERSION = 1;

export const DEPLOYMENT_MODES = ['deploy', 'rollback'];
export const MIGRATION_RESULTS = ['applied', 'skipped', 'failed'];
export const BACKUP_PREFLIGHT_RESULTS = ['taken', 'skipped', 'unavailable', 'failed'];
export const SMOKE_RESULTS = ['passed', 'failed', 'not-run'];

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Identity of the PUBLIC browser configuration a deployment applied.
 *
 * Since the Sprint 26 refinement the web image is environment-neutral and its
 * API origin arrives at runtime, so "what is running here?" is only half an
 * answer without "and how was it configured?". The fingerprint gives rollback a
 * single value to compare; the values themselves are recorded because they are
 * public by definition and useless when hidden.
 *
 * Only known-public keys may be passed. The record-level credential guard is
 * the backstop, and `assertPublicConfigIsPublic` is the specific check.
 */
export const PUBLIC_CONFIG_KEYS = ['apiBaseUrl', 'csrfHeaderName', 'mailpitUrl'];

export function buildPublicConfigIdentity(values) {
  assertPublicConfigIsPublic(values);
  // Canonical (key-sorted) JSON so an unchanged configuration always yields the
  // same fingerprint regardless of how it was assembled.
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]])),
  );
  return {
    values: { ...values },
    fingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  };
}

/** Refuse any key outside the published public-configuration contract. */
export function assertPublicConfigIsPublic(values) {
  const unexpected = Object.keys(values).filter((key) => !PUBLIC_CONFIG_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `public configuration identity may only contain ${PUBLIC_CONFIG_KEYS.join(', ')}; got ${unexpected.join(', ')}`,
    );
  }
}

/**
 * Reduce a release manifest to the authorization facts a deployment record
 * keeps: what kind of release it was, whether it was deployable, how its source
 * was addressed, and which gate runs authorised it. Copied rather than
 * referenced so a record stays readable on its own.
 */
function summariseAuthorization(manifest) {
  const summary = {
    releaseType: manifest.release.type,
    deployable: manifest.release.deployable,
    provenance: manifest.source.provenance,
  };
  if (manifest.source.workingTreeDigest !== undefined) {
    summary.workingTreeDigest = manifest.source.workingTreeDigest;
  }
  if (manifest.gates !== undefined) {
    summary.gateHeadSha = manifest.gates.headSha;
    summary.gateRuns = manifest.gates.required.map((gate) => ({
      check: gate.check,
      runId: gate.runId,
      conclusion: gate.conclusion,
    }));
  }
  return summary;
}

/**
 * Build a deployment record from a release manifest plus the outcomes the
 * deployment observed.
 *
 * `rollbackTarget` is the record that was current BEFORE this deployment (or
 * null for the first deployment into an environment); only its release
 * identity is copied, so the ledger never nests unboundedly.
 */
export function buildDeploymentRecord({
  environment,
  mode,
  actor,
  deployedAt,
  manifest,
  manifestFile,
  migration,
  backupPreflight,
  smoke,
  runtimeDigests,
  publicConfig,
  rollbackTarget = null,
  limitations = [],
}) {
  return {
    schemaVersion: DEPLOYMENT_RECORD_SCHEMA_VERSION,
    kind: DEPLOYMENT_RECORD_KIND,
    environment,
    mode,
    actor,
    deployedAt,
    release: {
      commit: manifest.source.commit,
      ref: manifest.source.ref,
      builtAt: manifest.source.builtAt,
      apiReference: manifest.images.api.reference,
      apiDigest: manifest.images.api.digest,
      webReference: manifest.images.web.reference,
      webDigest: manifest.images.web.digest,
      migrationHead: manifest.migrations.head,
      // The manifest is copied next to the record, so a rollback can redeploy
      // a previous release without reaching back to a registry API or a
      // workflow artifact that may have expired.
      manifestFile,
    },
    // What authorised these digests, kept with the deployment rather than only
    // in the manifest, so one record answers "who said this was releasable?".
    authorization: summariseAuthorization(manifest),
    // The public browser configuration this deployment applied. Deployment
    // state, never artifact identity.
    publicConfig,
    migration,
    backupPreflight,
    smoke,
    // Observed on the target after the containers started — this is what makes
    // "what is running here?" an answer rather than an intention. A member is
    // null when that service was never started (a deployment that failed at
    // the migration stage has no running containers to observe).
    runtimeDigests,
    rollbackTarget,
    limitations,
  };
}

/** Reduce a record to the identity a later rollback needs. */
export function toRollbackTarget(record) {
  if (record === null) {
    return null;
  }
  return {
    commit: record.release.commit,
    apiReference: record.release.apiReference,
    webReference: record.release.webReference,
    manifestFile: record.release.manifestFile,
    // Restoring old digests under today's configuration is not the same
    // deployment. Recording the configuration that was in effect lets a
    // rollback say so out loud instead of silently changing two things at once.
    publicConfigFingerprint: record.publicConfig?.fingerprint ?? null,
    deployedAt: record.deployedAt,
  };
}

function requireEnum(issues, value, allowed, label) {
  if (!allowed.includes(value)) {
    issues.push(`${label} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
}

function requireNonEmptyString(issues, value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} must be a non-empty string`);
  }
}

/** Validate a deployment record. Returns every problem rather than the first. */
export function validateDeploymentRecord(record) {
  const issues = [];

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, issues: ['deployment record must be a JSON object'] };
  }
  if (record.kind !== DEPLOYMENT_RECORD_KIND) {
    issues.push(`kind must be "${DEPLOYMENT_RECORD_KIND}"`);
  }
  if (record.schemaVersion !== DEPLOYMENT_RECORD_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${DEPLOYMENT_RECORD_SCHEMA_VERSION}`);
  }

  requireNonEmptyString(issues, record.environment, 'environment');
  requireNonEmptyString(issues, record.actor, 'actor');
  requireEnum(issues, record.mode, DEPLOYMENT_MODES, 'mode');

  if (typeof record.deployedAt !== 'string' || new Date(record.deployedAt).toISOString() !== record.deployedAt) {
    issues.push('deployedAt must be an ISO-8601 UTC timestamp');
  }

  const release = record.release;
  if (release === null || typeof release !== 'object') {
    issues.push('release must be an object');
  } else {
    requireNonEmptyString(issues, release.commit, 'release.commit');
    requireNonEmptyString(issues, release.manifestFile, 'release.manifestFile');
    for (const field of ['apiDigest', 'webDigest']) {
      if (typeof release[field] !== 'string' || !DIGEST_PATTERN.test(release[field])) {
        issues.push(`release.${field} must be a sha256 digest`);
      }
    }
    for (const field of ['apiReference', 'webReference']) {
      if (typeof release[field] !== 'string' || !release[field].includes('@sha256:')) {
        issues.push(`release.${field} must be a digest-pinned image reference`);
      }
    }
  }

  requireEnum(issues, record.migration?.result, MIGRATION_RESULTS, 'migration.result');
  requireEnum(issues, record.backupPreflight?.result, BACKUP_PREFLIGHT_RESULTS, 'backupPreflight.result');
  requireEnum(issues, record.smoke?.result, SMOKE_RESULTS, 'smoke.result');

  // A skipped or unavailable preflight is legitimate; an unexplained one is
  // not. The reason is the whole value of recording it.
  if (
    ['skipped', 'unavailable', 'failed'].includes(record.backupPreflight?.result) &&
    (typeof record.backupPreflight.reason !== 'string' || record.backupPreflight.reason.length === 0)
  ) {
    issues.push('backupPreflight.reason is required whenever the preflight did not take a backup');
  }
  if (
    record.migration?.result === 'skipped' &&
    (typeof record.migration.reason !== 'string' || record.migration.reason.length === 0)
  ) {
    issues.push('migration.reason is required whenever migrations were skipped');
  }

  const authorization = record.authorization;
  if (authorization === null || typeof authorization !== 'object') {
    issues.push('authorization must record what authorised this release');
  } else {
    requireNonEmptyString(issues, authorization.releaseType, 'authorization.releaseType');
    requireNonEmptyString(issues, authorization.provenance, 'authorization.provenance');
    if (typeof authorization.deployable !== 'boolean') {
      issues.push('authorization.deployable must be a boolean');
    }
    // A deployable release must name the gate runs that authorised it; a
    // rehearsal must not pretend to have any.
    if (authorization.deployable === true && !Array.isArray(authorization.gateRuns)) {
      issues.push('authorization.gateRuns must list the gate runs that authorised a deployable release');
    }
    if (authorization.deployable === false && authorization.gateRuns !== undefined) {
      issues.push('authorization.gateRuns must be absent for a release that was not deployable');
    }
  }

  const publicConfig = record.publicConfig;
  if (publicConfig === null || typeof publicConfig !== 'object') {
    issues.push('publicConfig must record the public browser configuration this deployment applied');
  } else {
    if (typeof publicConfig.fingerprint !== 'string' || !DIGEST_PATTERN.test(publicConfig.fingerprint)) {
      issues.push('publicConfig.fingerprint must be a sha256 fingerprint of the applied configuration');
    }
    if (publicConfig.values === null || typeof publicConfig.values !== 'object') {
      issues.push('publicConfig.values must be an object');
    } else {
      const unexpected = Object.keys(publicConfig.values).filter(
        (key) => !PUBLIC_CONFIG_KEYS.includes(key),
      );
      if (unexpected.length > 0) {
        issues.push(
          `publicConfig.values may only contain public keys (${PUBLIC_CONFIG_KEYS.join(', ')}); got ${unexpected.join(', ')}`,
        );
      }
    }
  }

  const runtimeDigests = record.runtimeDigests;
  if (runtimeDigests === null || typeof runtimeDigests !== 'object') {
    issues.push('runtimeDigests must be an object with `api` and `web` members');
  } else {
    for (const service of ['api', 'web']) {
      const digest = runtimeDigests[service];
      if (digest !== null && (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest))) {
        issues.push(`runtimeDigests.${service} must be a sha256 digest, or null when the service was never started`);
      }
    }
    // Smoke passing means both services answered over HTTP, so both must have
    // an observed digest. Without this, a record could claim a validated
    // deployment while leaving the "what is running?" question unanswered.
    if (record.smoke?.result === 'passed' && (runtimeDigests.api === null || runtimeDigests.web === null)) {
      issues.push('runtimeDigests.api and runtimeDigests.web are required when smoke passed');
    }
  }

  if (!Array.isArray(record.limitations)) {
    issues.push('limitations must be an array (empty is fine, absent is not)');
  }

  const credential = findEmbeddedCredential(record);
  if (credential !== null) {
    issues.push(
      `${credential.path} looks like ${credential.reason}; deployment evidence must contain no secrets`,
    );
  }

  return { valid: issues.length === 0, issues };
}

const byDeployedAtAscending = (left, right) => left.deployedAt.localeCompare(right.deployedAt);

/**
 * Releases an operator has already rolled AWAY from, identified by the release
 * a rollback record superseded.
 *
 * A rollback happens because the release that was running is bad. The ledger
 * cannot know WHY it was bad — its smoke may well have passed, since a release
 * can serve /health perfectly while being wrong — so "smoke passed" alone is
 * not enough to make a release a rollback target again.
 */
function releasesRolledAwayFrom(records) {
  const ordered = [...records].sort(byDeployedAtAscending);
  const rolledAwayFrom = new Set();
  ordered.forEach((record, index) => {
    if (record.mode === 'rollback' && index > 0) {
      rolledAwayFrom.add(ordered[index - 1].release.apiReference);
    }
  });
  return rolledAwayFrom;
}

/**
 * Select the release an application rollback should restore.
 *
 * "Previous known-good" means all of: smoke actually passed, it is not the
 * release currently deployed, it is not a release already rolled away from,
 * and it is the most recent of whatever remains.
 *
 * Returning null is a legitimate answer — it means the environment has no
 * earlier release left to fall back to, and the operator must fix forward or
 * recover. That is far better than silently redeploying the release the last
 * rollback was escaping from.
 */
export function selectRollbackTarget(records, currentRecord) {
  const currentApiReference = currentRecord?.release?.apiReference ?? null;
  const rolledAwayFrom = releasesRolledAwayFrom(records);

  return (
    records
      .filter((record) => record.smoke?.result === 'passed')
      .filter((record) => record.release.apiReference !== currentApiReference)
      .filter((record) => !rolledAwayFrom.has(record.release.apiReference))
      .sort((left, right) => right.deployedAt.localeCompare(left.deployedAt))[0] ?? null
  );
}
