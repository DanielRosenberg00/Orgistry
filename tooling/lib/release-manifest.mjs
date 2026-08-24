/**
 * Release manifest model (Sprint 26, ORG-PR-001).
 *
 * A release manifest is the immutable IDENTITY of one build: the source commit
 * it came from, the exact registry digests published for it, and the migration
 * baseline baked into those images. Deployment consumes a manifest; it never
 * derives image identity from a tag, a branch, or a local build.
 *
 * WHY THIS IS A SEPARATE RECORD FROM DEPLOYMENT EVIDENCE
 * A manifest is written once, at build time, and never again — so it can only
 * hold facts that exist at build time. Everything a deployment learns (which
 * environment, whether migrations ran, whether smoke passed, what the rollback
 * target was) is recorded separately by tooling/lib/deploy-evidence.mjs. The
 * split exists so no field ever has to be invented: a build-time record with a
 * `deploymentResult` field would either lie or be permanently null.
 *
 * The migration identity is DERIVED here from the repository's Drizzle journal
 * rather than passed in, so a manifest cannot claim a migration head the images
 * do not contain.
 *
 * Nothing in a manifest is secret, and `validateReleaseManifest` enforces that
 * actively (see `findEmbeddedCredential`) — manifests are uploaded as workflow
 * artifacts, copied to deployment hosts, and pasted into evidence.
 *
 * SCHEMA 2 (Sprint 26 refinement) made three corrections:
 *
 *   1. `images.web.apiBaseUrl` is GONE. The browser's API origin is runtime
 *      deployment configuration, not artifact identity, so one web digest is
 *      promotable between environments (docs/deployment.md, "Runtime public
 *      configuration"). A manifest describes what an artifact IS, never where
 *      it is deployed.
 *   2. `release.type` + `source.provenance` make a development rehearsal
 *      impossible to mistake for a deployable release. A dirty working tree can
 *      never claim commit-addressed provenance.
 *   3. `gates` records the required checks that authorised publication, tied to
 *      the exact source commit. A published release without them is invalid.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_GATES } from './release-gates.mjs';

/**
 * The check names a published release must prove, taken from the gate module
 * so the required-check contract exists in exactly one place.
 */
const REQUIRED_GATE_CHECKS = REQUIRED_GATES.map((gate) => gate.check);

export const RELEASE_MANIFEST_KIND = 'orgistry.release-manifest';
export const RELEASE_MANIFEST_SCHEMA_VERSION = 2;

/**
 * What kind of release a manifest describes.
 *
 * `published`  a real release from the publication workflow: clean
 *              commit-addressed source, required gates proven, deployable.
 * `rehearsal`  local rehearsal output: never deployable to a real environment,
 *              never carries GitHub gate evidence, and says so in the document
 *              itself rather than only in a log line.
 */
export const RELEASE_TYPES = ['published', 'rehearsal'];

/**
 * How the source bytes that produced the images are addressed.
 *
 * `commit`        exactly the recorded commit — the only provenance a
 *                 deployable release may claim.
 * `working-tree`  a developer's uncommitted tree based on that commit. It is
 *                 NOT byte-identical to the commit, so it carries a content
 *                 fingerprint instead and can never be deployable.
 */
export const SOURCE_PROVENANCE = ['commit', 'working-tree'];

/** The migration artifact IS the API image, run with a different command. */
export const MIGRATION_ARTIFACT = 'api-image';
export const MIGRATION_ENTRYPOINT = 'node dist/migrate.mjs';

/** Accepted values for build-time artifact-smoke evidence. */
export const ARTIFACT_SMOKE_RESULTS = ['passed', 'not-run'];

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MIGRATION_HEAD_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;
/** OCI repository names are lowercase; a host:port prefix is allowed. */
const REPOSITORY_PATTERN = /^[a-z0-9._:-]+(\/[a-z0-9._-]+)+$/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_JOURNAL_PATH = join(
  REPO_ROOT,
  'packages/db/migrations/meta/_journal.json',
);

/**
 * Read the migration baseline identity from the Drizzle journal.
 *
 * `head` is the last journal entry's tag (the migration a fully migrated
 * database ends on) and `count` is how many migrations that baseline contains.
 * Both are what `node dist/migrate.mjs` will have applied when it exits 0, so
 * a deployment can compare them against the database it just migrated.
 */
export function readMigrationBaseline(journalPath = MIGRATION_JOURNAL_PATH) {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const entries = journal.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Migration journal ${journalPath} contains no entries`);
  }
  const head = entries[entries.length - 1];
  if (typeof head.tag !== 'string' || typeof head.when !== 'number') {
    throw new Error(
      `Migration journal ${journalPath} has a malformed final entry`,
    );
  }
  return {
    head: head.tag,
    count: entries.length,
    // Drizzle stores this exact value as `created_at` in its ledger table, so
    // a deployment can verify the applied head without parsing SQL files.
    appliedAtMs: head.when,
  };
}

/**
 * Assemble one image identity. `reference` is always the digest form — the
 * only form a deployment is allowed to run (see docs/deployment.md,
 * "Build once, promote by digest").
 *
 * An image identity carries no environment configuration. That is the whole
 * point: both images are environment-neutral, so the same digests are promoted
 * rather than rebuilt.
 */
function buildImageIdentity({ repository, tag, digest }) {
  return { repository, tag, digest, reference: `${repository}@${digest}` };
}

/**
 * Build a release manifest from the identities a build genuinely knows.
 *
 * `build` is optional and must only carry values the caller actually has: a
 * local build has no workflow run, so it passes none, and the field is omitted
 * rather than filled with a placeholder.
 */
export function buildReleaseManifest({
  releaseType,
  provenance,
  commit,
  ref,
  builtAt,
  workingTreeDigest = null,
  api,
  web,
  gates = null,
  build = null,
  journalPath = MIGRATION_JOURNAL_PATH,
}) {
  const baseline = readMigrationBaseline(journalPath);
  const source = { provenance, commit, ref, builtAt };
  if (workingTreeDigest !== null) {
    source.workingTreeDigest = workingTreeDigest;
  }

  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_MANIFEST_KIND,
    // Deployability is a stated property of the document, not something a
    // reader has to infer from which optional fields happen to be present.
    release: { type: releaseType, deployable: releaseType === 'published' },
    source,
    images: {
      api: buildImageIdentity(api),
      web: buildImageIdentity(web),
    },
    migrations: {
      head: baseline.head,
      count: baseline.count,
      appliedAtMs: baseline.appliedAtMs,
      artifact: MIGRATION_ARTIFACT,
      entrypoint: MIGRATION_ENTRYPOINT,
    },
  };
  if (gates !== null) {
    manifest.gates = gates;
  }
  if (build !== null) {
    manifest.build = build;
  }
  return manifest;
}

/** Walk every string in a JSON-ish value, yielding `[path, value]` pairs. */
function* iterateStrings(value, path = '$') {
  if (typeof value === 'string') {
    yield [path, value];
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      yield* iterateStrings(item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield* iterateStrings(item, `${path}.${key}`);
    }
  }
}

/**
 * Credential shapes that must never appear in a manifest or in evidence.
 *
 * Both patterns require an actual VALUE, not merely a credential-ish word: a
 * skip reason may legitimately say "no database URL was configured", and
 * failing that would push operators toward vaguer evidence.
 */
const CREDENTIAL_PATTERNS = [
  // A URL carrying inline credentials, e.g. postgres://user:password@host/db.
  { name: 'a URL with embedded credentials', pattern: /:\/\/[^/\s:@]+:[^/\s@]+@/ },
  {
    name: 'an inline credential assignment',
    pattern:
      /\b(password|passwd|secret|api[_-]?key|JWT_SECRET|JWT_PREVIOUS_SECRET|SMTP_PASSWORD|DATABASE_URL|REDIS_URL)\b\s*[=:]\s*\S/i,
  },
];

/**
 * Find the first credential-shaped string in a record, or null.
 *
 * This is a structural guard, not a secret scanner: it cannot recognise an
 * arbitrary high-entropy value. Its job is to fail loudly if someone extends
 * a manifest or an evidence record with a field that carries a connection
 * string or a credential — the mistakes that are actually plausible here.
 */
export function findEmbeddedCredential(record) {
  for (const [path, value] of iterateStrings(record)) {
    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) {
        return { path, reason: name };
      }
    }
  }
  return null;
}

function requireString(issues, record, path, label) {
  const value = path.split('.').reduce((current, key) => current?.[key], record);
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} (${path}) must be a non-empty string`);
    return null;
  }
  return value;
}

function validateImage(issues, image, name, expectedTag) {
  if (image === null || typeof image !== 'object') {
    issues.push(`images.${name} must be an object`);
    return;
  }
  const { repository, tag, digest, reference } = image;
  if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository)) {
    issues.push(
      `images.${name}.repository must be a lowercase registry path (got ${JSON.stringify(repository)})`,
    );
  }
  if (tag !== expectedTag) {
    issues.push(
      `images.${name}.tag must equal source.commit — the image tag IS the commit SHA (got ${JSON.stringify(tag)})`,
    );
  }
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    issues.push(
      `images.${name}.digest must be a sha256 digest (got ${JSON.stringify(digest)})`,
    );
    return;
  }
  if (reference !== `${repository}@${digest}`) {
    issues.push(
      `images.${name}.reference must be "<repository>@<digest>" — a deployment may never resolve an image by tag`,
    );
  }

  // Guard against environment configuration creeping back into artifact
  // identity. A field like `apiBaseUrl` here (schema 1 had one) is exactly what
  // made the web image unpromotable; deployment configuration belongs to the
  // deployment, not to the image.
  const allowedKeys = ['repository', 'tag', 'digest', 'reference'];
  const unexpected = Object.keys(image).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    issues.push(
      `images.${name} carries non-identity field(s) ${unexpected.join(', ')} — an image identity must not describe where it is deployed`,
    );
  }
}

/**
 * Validate the required-gate evidence that authorised a published release.
 *
 * Two rules carry the weight:
 *
 *   * every recorded gate must have concluded `success` FOR THE RELEASE'S OWN
 *     COMMIT — evidence from a neighbouring commit authorises nothing;
 *   * a rehearsal manifest must carry NO gate evidence at all, because no
 *     GitHub run authorised it and inventing run IDs is worse than having none.
 */
function validateGates(issues, manifest, releaseType, commit) {
  const gates = manifest.gates;

  if (releaseType === 'rehearsal') {
    if (gates !== undefined) {
      issues.push(
        'a rehearsal manifest must not carry gate evidence — no GitHub run authorised it, and fabricated run identities are never acceptable',
      );
    }
    return;
  }
  if (releaseType !== 'published') {
    return;
  }

  if (gates === null || typeof gates !== 'object') {
    issues.push('a published release must carry `gates` evidence for the required checks');
    return;
  }
  if (gates.headSha !== commit) {
    issues.push(
      `gates.headSha must equal source.commit — gate evidence for a different commit authorises nothing (got ${JSON.stringify(gates.headSha)})`,
    );
  }
  if (typeof gates.verifiedAt !== 'string' || new Date(gates.verifiedAt).toISOString() !== gates.verifiedAt) {
    issues.push('gates.verifiedAt must be an ISO-8601 UTC timestamp');
  }
  if (!Array.isArray(gates.required) || gates.required.length === 0) {
    issues.push('gates.required must list the required checks that authorised this release');
    return;
  }

  const recordedChecks = new Set();
  for (const gate of gates.required) {
    if (gate === null || typeof gate !== 'object') {
      issues.push('each entry in gates.required must be an object');
      continue;
    }
    recordedChecks.add(gate.check);
    if (gate.conclusion !== 'success') {
      issues.push(`gate "${gate.check}" concluded ${JSON.stringify(gate.conclusion)}; only success authorises a release`);
    }
    if (gate.headSha !== commit) {
      issues.push(`gate "${gate.check}" ran against ${JSON.stringify(gate.headSha)}, not this release's commit`);
    }
    if (typeof gate.runId !== 'string' || !/^[0-9]+$/.test(gate.runId)) {
      issues.push(`gate "${gate.check}" must record the numeric GitHub run ID that produced it`);
    }
    if (typeof gate.workflowFile !== 'string' || gate.workflowFile.length === 0) {
      issues.push(`gate "${gate.check}" must name the workflow file it came from`);
    }
  }

  // The contract is the full set, not "some checks passed".
  for (const required of REQUIRED_GATE_CHECKS) {
    if (!recordedChecks.has(required)) {
      issues.push(`gates.required is missing the required check "${required}"`);
    }
  }
}

/**
 * Validate a release manifest.
 *
 * Returns `{ valid, issues }` rather than throwing, so a caller can report
 * every problem at once. Structure only: this deliberately does NOT compare the
 * manifest against the local migration journal, because a manifest is validated
 * on deployment hosts and in workflows that may be on a different commit than
 * the one it describes. The applied-vs-declared migration check belongs to the
 * deployment (tooling/deploy.sh), which has the database in front of it.
 */
export function validateReleaseManifest(manifest) {
  const issues = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, issues: ['manifest must be a JSON object'] };
  }
  if (manifest.kind !== RELEASE_MANIFEST_KIND) {
    issues.push(`kind must be "${RELEASE_MANIFEST_KIND}" (got ${JSON.stringify(manifest.kind)})`);
  }
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION} (got ${JSON.stringify(manifest.schemaVersion)})`,
    );
  }

  const releaseType = manifest.release?.type;
  if (!RELEASE_TYPES.includes(releaseType)) {
    issues.push(`release.type must be one of ${RELEASE_TYPES.join(', ')} (got ${JSON.stringify(releaseType)})`);
  }
  if (manifest.release?.deployable !== (releaseType === 'published')) {
    issues.push(
      'release.deployable must be true for a published release and false for a rehearsal — the two must never disagree',
    );
  }

  const commit = requireString(issues, manifest, 'source.commit', 'source commit');
  if (commit !== null && !COMMIT_PATTERN.test(commit)) {
    issues.push('source.commit must be a full 40-character lowercase git SHA');
  }
  requireString(issues, manifest, 'source.ref', 'source ref');
  const builtAt = requireString(issues, manifest, 'source.builtAt', 'build timestamp');
  if (builtAt !== null && new Date(builtAt).toISOString() !== builtAt) {
    issues.push('source.builtAt must be an ISO-8601 UTC timestamp (e.g. 2026-08-24T09:00:00.000Z)');
  }

  const provenance = manifest.source?.provenance;
  if (!SOURCE_PROVENANCE.includes(provenance)) {
    issues.push(`source.provenance must be one of ${SOURCE_PROVENANCE.join(', ')} (got ${JSON.stringify(provenance)})`);
  }
  // A working tree is not byte-identical to its base commit, so it must carry
  // its own content fingerprint and can never claim to be deployable.
  if (provenance === 'working-tree') {
    if (typeof manifest.source.workingTreeDigest !== 'string' || !DIGEST_PATTERN.test(manifest.source.workingTreeDigest)) {
      issues.push('source.workingTreeDigest must be a sha256 fingerprint of the uncommitted tree');
    }
    if (releaseType === 'published') {
      issues.push(
        'a published release may not be built from a working tree — its images would not be the recorded commit',
      );
    }
  } else if (manifest.source?.workingTreeDigest !== undefined) {
    issues.push('source.workingTreeDigest is only meaningful when source.provenance is working-tree');
  }

  if (manifest.images === null || typeof manifest.images !== 'object') {
    issues.push('images must be an object with `api` and `web` entries');
  } else {
    validateImage(issues, manifest.images.api, 'api', manifest.source?.commit);
    validateImage(issues, manifest.images.web, 'web', manifest.source?.commit);
  }

  const migrations = manifest.migrations;
  if (migrations === null || typeof migrations !== 'object') {
    issues.push('migrations must be an object');
  } else {
    if (typeof migrations.head !== 'string' || !MIGRATION_HEAD_PATTERN.test(migrations.head)) {
      issues.push(`migrations.head must be a migration tag such as 0012_example (got ${JSON.stringify(migrations.head)})`);
    }
    if (!Number.isInteger(migrations.count) || migrations.count < 1) {
      issues.push('migrations.count must be a positive integer');
    }
    if (!Number.isInteger(migrations.appliedAtMs) || migrations.appliedAtMs < 1) {
      issues.push('migrations.appliedAtMs must be the head migration\'s journal timestamp in milliseconds');
    }
    if (migrations.artifact !== MIGRATION_ARTIFACT) {
      issues.push(`migrations.artifact must be "${MIGRATION_ARTIFACT}" — migrations run from the API image, not a separate artifact`);
    }
    if (migrations.entrypoint !== MIGRATION_ENTRYPOINT) {
      issues.push(`migrations.entrypoint must be "${MIGRATION_ENTRYPOINT}"`);
    }
  }

  if (manifest.build !== undefined) {
    if (manifest.build === null || typeof manifest.build !== 'object') {
      issues.push('build, when present, must be an object');
    } else if (!ARTIFACT_SMOKE_RESULTS.includes(manifest.build.artifactSmoke)) {
      issues.push(
        `build.artifactSmoke must be one of ${ARTIFACT_SMOKE_RESULTS.join(', ')} — it records whether the artifact gate actually ran for this build`,
      );
    }
  }

  validateGates(issues, manifest, releaseType, commit);

  const credential = findEmbeddedCredential(manifest);
  if (credential !== null) {
    issues.push(
      `${credential.path} looks like ${credential.reason}; a release manifest must contain no secrets`,
    );
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Read a dotted field path out of a manifest (or any JSON record).
 *
 * Shell callers use this instead of a JSON parser dependency; an unknown path
 * returns `undefined` so the caller can fail with its own message.
 */
export function readField(record, fieldPath) {
  return fieldPath
    .split('.')
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), record);
}
