#!/usr/bin/env node
//
// Release manifest CLI (Sprint 26, ORG-PR-001).
//
// A thin command wrapper around tooling/lib/release-manifest.mjs — the model,
// its invariants, and its tests live there.
//
// Usage:
//   release-manifest.mjs generate --output PATH \
//       --release-type published|rehearsal \
//       --provenance commit|working-tree \
//       --commit SHA --ref REF \
//       --api-repository REPO --api-digest sha256:... \
//       --web-repository REPO --web-digest sha256:... \
//       --artifact-smoke passed|not-run \
//       [--working-tree-digest sha256:...]   (required for working-tree) \
//       [--gates PATH]                       (required for published) \
//       [--built-at ISO8601] \
//       [--workflow NAME --run-id ID --run-attempt N --repository OWNER/REPO]
//
//   release-manifest.mjs validate PATH
//   release-manifest.mjs read PATH --field images.api.reference
//
// `generate` derives the migration head from the repository's Drizzle journal
// and always writes digest-form image references; the image TAG is the commit
// SHA. `validate` is the gate a deployment runs before it touches a target.
// `read` exists so shell callers need no JSON parser.
//
// A manifest states its own deployability. `--release-type published` requires
// clean commit provenance AND gate evidence proving the required checks passed
// for that exact commit; `--release-type rehearsal` is never deployable to a
// real environment and may not carry gate evidence at all.
//
// This command never accepts, prints, or stores a secret. `validate` actively
// refuses a manifest containing anything credential-shaped.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ARTIFACT_SMOKE_RESULTS,
  RELEASE_TYPES,
  SOURCE_PROVENANCE,
  buildReleaseManifest,
  readField,
  validateReleaseManifest,
} from './lib/release-manifest.mjs';

function die(message) {
  console.error(`release-manifest: ${message}`);
  process.exit(1);
}

/** Parse `--flag value` pairs into a plain object keyed by flag name. */
function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      die(`unexpected argument "${argument}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`option ${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
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

function readManifestFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`cannot read ${path}: ${error.message}`);
  }
}

function reportIssues(path, issues) {
  console.error(`release-manifest: ${path} is not a valid release manifest:`);
  for (const issue of issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

function commandGenerate(argv) {
  const options = parseOptions(argv);
  const outputPath = requireOption(options, 'output');
  const artifactSmoke = requireOption(options, 'artifact-smoke');
  if (!ARTIFACT_SMOKE_RESULTS.includes(artifactSmoke)) {
    die(`--artifact-smoke must be one of ${ARTIFACT_SMOKE_RESULTS.join(', ')}`);
  }

  const releaseType = requireOption(options, 'release-type');
  if (!RELEASE_TYPES.includes(releaseType)) {
    die(`--release-type must be one of ${RELEASE_TYPES.join(', ')}`);
  }
  const provenance = requireOption(options, 'provenance');
  if (!SOURCE_PROVENANCE.includes(provenance)) {
    die(`--provenance must be one of ${SOURCE_PROVENANCE.join(', ')}`);
  }

  let workingTreeDigest = null;
  if (provenance === 'working-tree') {
    workingTreeDigest = requireOption(options, 'working-tree-digest');
  } else if (options['working-tree-digest'] !== undefined) {
    die('--working-tree-digest is only valid with --provenance working-tree');
  }

  // Gate evidence is read from a file produced by tooling/release-gates.mjs.
  // It is never assembled from flags, so no caller can hand-write a run ID.
  let gates = null;
  if (options.gates !== undefined) {
    if (releaseType !== 'published') {
      die('--gates is only valid for --release-type published');
    }
    gates = readManifestFile(options.gates);
  } else if (releaseType === 'published') {
    die('--gates is required for --release-type published (produced by release-gates.mjs verify)');
  }

  // Workflow provenance is recorded only when the caller genuinely has it. A
  // local build passes none of these and the `build` block is omitted rather
  // than filled with placeholders.
  const build = { artifactSmoke };
  for (const [flag, field] of [
    ['workflow', 'workflow'],
    ['run-id', 'runId'],
    ['run-attempt', 'runAttempt'],
    ['repository', 'repository'],
  ]) {
    if (options[flag] !== undefined) {
      build[field] = options[flag];
    }
  }

  const manifest = buildReleaseManifest({
    releaseType,
    provenance,
    workingTreeDigest,
    commit: requireOption(options, 'commit'),
    ref: requireOption(options, 'ref'),
    builtAt: options['built-at'] ?? new Date().toISOString(),
    api: {
      repository: requireOption(options, 'api-repository'),
      tag: requireOption(options, 'commit'),
      digest: requireOption(options, 'api-digest'),
    },
    web: {
      repository: requireOption(options, 'web-repository'),
      tag: requireOption(options, 'commit'),
      digest: requireOption(options, 'web-digest'),
    },
    gates,
    build,
  });

  const { valid, issues } = validateReleaseManifest(manifest);
  if (!valid) {
    reportIssues('the generated manifest', issues);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(outputPath);
}

function commandValidate(argv) {
  const [path, ...rest] = argv;
  if (path === undefined || rest.length > 0) {
    die('usage: release-manifest.mjs validate PATH');
  }
  const manifest = readManifestFile(path);
  const { valid, issues } = validateReleaseManifest(manifest);
  if (!valid) {
    reportIssues(path, issues);
  }
  console.log(
    `release-manifest: ${path} is valid — ${manifest.release.type} release, ` +
      `${manifest.source.provenance} provenance, commit ${manifest.source.commit}, ` +
      `migration head ${manifest.migrations.head}, ` +
      `deployable: ${manifest.release.deployable}`,
  );
}

function commandRead(argv) {
  const [path, ...rest] = argv;
  if (path === undefined) {
    die('usage: release-manifest.mjs read PATH --field DOTTED.PATH');
  }
  const options = parseOptions(rest);
  const fieldPath = requireOption(options, 'field');
  const value = readField(readManifestFile(path), fieldPath);
  if (value === undefined || value === null) {
    die(`${path} has no value at "${fieldPath}"`);
  }
  console.log(String(value));
}

const [command, ...argv] = process.argv.slice(2);
switch (command) {
  case 'generate':
    commandGenerate(argv);
    break;
  case 'validate':
    commandValidate(argv);
    break;
  case 'read':
    commandRead(argv);
    break;
  default:
    die('usage: release-manifest.mjs <generate|validate|read> [options]');
}
