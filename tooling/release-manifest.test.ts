import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import {
  buildReleaseManifest,
  findEmbeddedCredential,
  readMigrationBaseline,
  validateReleaseManifest,
} from './lib/release-manifest.mjs';
// @ts-expect-error plain .mjs module without type declarations
import { REQUIRED_GATES } from './lib/release-gates.mjs';

/**
 * The release manifest is the contract between "what CI built and authorised"
 * and "what a target runs" (Sprint 26). These tests pin the invariants a
 * deployment relies on, so a future edit that loosens one fails here rather
 * than on a deployment host:
 *
 *   - image references are digest-pinned, never tag-pinned;
 *   - the image tag IS the source commit;
 *   - the migration head is derived from the repository, not supplied;
 *   - an image identity carries NO deployment configuration, which is what
 *     keeps one web digest promotable between environments;
 *   - a published release proves the required checks passed for its own commit;
 *   - a rehearsal can never masquerade as deployable, and never carries
 *     fabricated gate identities;
 *   - nothing credential-shaped can be recorded in a manifest.
 *
 * `readMigrationBaseline` is exercised against the REAL journal on purpose: a
 * fixture journal would prove the parser works while saying nothing about the
 * repository's actual migration baseline being readable.
 */

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const API_DIGEST = `sha256:${'a'.repeat(64)}`;
const WEB_DIGEST = `sha256:${'b'.repeat(64)}`;
const TREE_DIGEST = `sha256:${'c'.repeat(64)}`;

function makeGateEvidence(commit = COMMIT): Record<string, any> {
  return {
    headSha: commit,
    verifiedAt: '2026-08-24T09:05:00.000Z',
    required: REQUIRED_GATES.map((gate: any, index: number) => ({
      check: gate.check,
      workflow: gate.workflow,
      workflowFile: gate.workflowFile,
      runId: String(32700000000 + index),
      runAttempt: '1',
      conclusion: 'success',
      headSha: commit,
      url: `https://github.com/example/orgistry/actions/runs/${32700000000 + index}`,
    })),
  };
}

function makePublished(overrides: Record<string, any> = {}): Record<string, any> {
  return buildReleaseManifest({
    releaseType: 'published',
    provenance: 'commit',
    commit: COMMIT,
    ref: 'refs/heads/main',
    builtAt: '2026-08-24T09:00:00.000Z',
    api: { repository: 'ghcr.io/example/orgistry-api', tag: COMMIT, digest: API_DIGEST },
    web: { repository: 'ghcr.io/example/orgistry-web', tag: COMMIT, digest: WEB_DIGEST },
    gates: makeGateEvidence(),
    build: { artifactSmoke: 'passed', workflow: 'Release', runId: '123' },
    ...overrides,
  });
}

function makeRehearsal(overrides: Record<string, any> = {}): Record<string, any> {
  return buildReleaseManifest({
    releaseType: 'rehearsal',
    provenance: 'working-tree',
    workingTreeDigest: TREE_DIGEST,
    commit: COMMIT,
    ref: 'refs/heads/main',
    builtAt: '2026-08-24T09:00:00.000Z',
    api: { repository: '127.0.0.1:5001/orgistry-api', tag: COMMIT, digest: API_DIGEST },
    web: { repository: '127.0.0.1:5001/orgistry-web', tag: COMMIT, digest: WEB_DIGEST },
    build: { artifactSmoke: 'not-run' },
    ...overrides,
  });
}

describe('readMigrationBaseline', () => {
  it('reads the head, count, and journal timestamp from the repository journal', () => {
    const baseline = readMigrationBaseline();
    expect(baseline.head).toMatch(/^[0-9]{4}_[a-z0-9_]+$/);
    expect(baseline.count).toBeGreaterThan(0);
    expect(Number.isInteger(baseline.appliedAtMs)).toBe(true);
  });
});

describe('buildReleaseManifest', () => {
  it('always produces digest-form image references', () => {
    const manifest = makePublished();
    expect(manifest.images.api.reference).toBe(`ghcr.io/example/orgistry-api@${API_DIGEST}`);
    expect(manifest.images.web.reference).toBe(`ghcr.io/example/orgistry-web@${WEB_DIGEST}`);
  });

  it('records no deployment configuration on an image identity', () => {
    // The property that makes one web digest promotable: an image says what it
    // IS, never where it runs.
    expect(Object.keys(makePublished().images.web).sort()).toEqual([
      'digest',
      'reference',
      'repository',
      'tag',
    ]);
  });

  it('derives the migration identity instead of accepting it', () => {
    const manifest = makePublished();
    const baseline = readMigrationBaseline();
    expect(manifest.migrations.head).toBe(baseline.head);
    expect(manifest.migrations.count).toBe(baseline.count);
    expect(manifest.migrations.artifact).toBe('api-image');
  });

  it('marks a published release deployable and a rehearsal not deployable', () => {
    expect(makePublished().release).toEqual({ type: 'published', deployable: true });
    expect(makeRehearsal().release).toEqual({ type: 'rehearsal', deployable: false });
  });

  it('omits the build block entirely when there is no build provenance', () => {
    const manifest = makeRehearsal({ build: null });
    expect('build' in manifest).toBe(false);
  });
});

describe('validateReleaseManifest', () => {
  it('accepts a published manifest produced by the builder', () => {
    expect(validateReleaseManifest(makePublished())).toEqual({ valid: true, issues: [] });
  });

  it('accepts a working-tree rehearsal manifest', () => {
    expect(validateReleaseManifest(makeRehearsal())).toEqual({ valid: true, issues: [] });
  });

  it('rejects a tag-pinned image reference', () => {
    const manifest = makePublished();
    manifest.images.api.reference = `ghcr.io/example/orgistry-api:${COMMIT}`;
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('may never resolve an image by tag');
  });

  it('rejects an image tag that is not the source commit', () => {
    const manifest = makePublished();
    manifest.images.web.tag = 'latest';
    expect(validateReleaseManifest(manifest).valid).toBe(false);
  });

  it('rejects deployment configuration smuggled into an image identity', () => {
    const manifest = makePublished();
    manifest.images.web.apiBaseUrl = 'https://api.example.test';
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('must not describe where it is deployed');
  });

  it('rejects a malformed digest', () => {
    const manifest = makePublished();
    manifest.images.api.digest = 'sha256:not-a-digest';
    expect(validateReleaseManifest(manifest).valid).toBe(false);
  });

  it('rejects a short commit', () => {
    const manifest = makePublished();
    manifest.source.commit = '0123456';
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain(
      '40-character lowercase git SHA',
    );
  });

  it('rejects a non-ISO build timestamp', () => {
    const manifest = makePublished();
    manifest.source.builtAt = '24 August 2026';
    expect(validateReleaseManifest(manifest).valid).toBe(false);
  });

  it('refuses a manifest carrying a credential-bearing URL', () => {
    const manifest = makePublished();
    manifest.source.ref = 'postgres://orgistry:hunter2@db.internal:5432/orgistry';
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('must contain no secrets');
  });
});

describe('provenance invariants', () => {
  it('refuses a published release built from a working tree', () => {
    const manifest = makePublished();
    manifest.source.provenance = 'working-tree';
    manifest.source.workingTreeDigest = TREE_DIGEST;
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('may not be built from a working tree');
  });

  it('requires a working-tree manifest to carry a content fingerprint', () => {
    const manifest = makeRehearsal();
    delete manifest.source.workingTreeDigest;
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain('workingTreeDigest');
  });

  it('refuses a working-tree fingerprint on commit provenance', () => {
    const manifest = makeRehearsal({ provenance: 'commit', workingTreeDigest: null });
    manifest.source.workingTreeDigest = TREE_DIGEST;
    expect(validateReleaseManifest(manifest).valid).toBe(false);
  });

  it('refuses a rehearsal that claims to be deployable', () => {
    const manifest = makeRehearsal();
    manifest.release.deployable = true;
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('must never disagree');
  });

  it('refuses a rehearsal carrying gate evidence', () => {
    // A rehearsal has no GitHub run behind it; inventing one would be worse
    // than having none at all.
    const manifest = makeRehearsal();
    manifest.gates = makeGateEvidence();
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('fabricated run identities');
  });
});

describe('gate evidence invariants', () => {
  it('refuses a published release with no gate evidence', () => {
    const manifest = makePublished();
    delete manifest.gates;
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain(
      'must carry `gates` evidence',
    );
  });

  it('refuses gate evidence recorded for a different commit', () => {
    const manifest = makePublished({ gates: makeGateEvidence(OTHER_COMMIT) });
    const { valid, issues } = validateReleaseManifest(manifest);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('authorises nothing');
  });

  it('refuses a single gate that ran against another commit', () => {
    const manifest = makePublished();
    manifest.gates.required[2].headSha = OTHER_COMMIT;
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain(
      "not this release's commit",
    );
  });

  it('refuses a gate whose conclusion is not success', () => {
    const manifest = makePublished();
    manifest.gates.required[0].conclusion = 'failure';
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain(
      'only success authorises a release',
    );
  });

  it('refuses a missing required check', () => {
    const manifest = makePublished();
    const dropped = manifest.gates.required.pop();
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain(
      `missing the required check "${dropped.check}"`,
    );
  });

  it('refuses a non-numeric run identifier', () => {
    const manifest = makePublished();
    manifest.gates.required[1].runId = 'probably-fine';
    expect(validateReleaseManifest(manifest).issues.join(' ')).toContain('numeric GitHub run ID');
  });
});

describe('findEmbeddedCredential', () => {
  it('finds a credential-bearing URL anywhere in a record', () => {
    const found = findEmbeddedCredential({ nested: { list: ['redis://user:pw@cache:6379'] } });
    expect(found).not.toBeNull();
    expect(found.path).toBe('$.nested.list[0]');
  });

  it('finds an inline credential assignment', () => {
    expect(findEmbeddedCredential({ note: 'JWT_SECRET=abc123' })).not.toBeNull();
  });

  it('allows prose that names a variable without carrying its value', () => {
    expect(
      findEmbeddedCredential({ reason: 'no DATABASE_URL was configured for this host' }),
    ).toBeNull();
  });

  it('allows ordinary release identities', () => {
    expect(findEmbeddedCredential(makePublished())).toBeNull();
  });
});
