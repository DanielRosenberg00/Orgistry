import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import {
  buildDeploymentRecord,
  buildPublicConfigIdentity,
  selectRollbackTarget,
  validateDeploymentRecord,
} from './lib/deploy-evidence.mjs';
// @ts-expect-error plain .mjs module without type declarations
import { buildReleaseManifest } from './lib/release-manifest.mjs';

/**
 * The deployment ledger answers two operational questions (Sprint 26,
 * ORG-PR-001): what is running in this environment, and what would a rollback
 * restore. These tests pin the rules that keep those answers trustworthy:
 *
 *   - a record cannot claim a validated deployment without observed digests;
 *   - it records the PUBLIC runtime configuration that was applied, and cannot
 *     record anything outside the public contract;
 *   - it records what authorised the release it deployed;
 *   - a skipped backup preflight must carry a reason;
 *   - the rollback target is the most recent release whose smoke passed, that
 *     is neither currently deployed nor already rolled away from — the rule
 *     that stops a rollback from restoring the release the last rollback was
 *     escaping.
 */

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

function makeManifest(commit: string, digestSeed: string): Record<string, any> {
  return buildReleaseManifest({
    releaseType: 'rehearsal',
    provenance: 'commit',
    commit,
    ref: 'refs/heads/main',
    builtAt: '2026-08-24T09:00:00.000Z',
    api: {
      repository: 'ghcr.io/example/orgistry-api',
      tag: commit,
      digest: `sha256:${digestSeed.repeat(64).slice(0, 64)}`,
    },
    web: {
      repository: 'ghcr.io/example/orgistry-web',
      tag: commit,
      digest: `sha256:${digestSeed.repeat(64).slice(0, 64)}`,
    },
  });
}

const PUBLIC_CONFIG = buildPublicConfigIdentity({
  apiBaseUrl: 'https://api.example.test',
  csrfHeaderName: 'x-orgistry-csrf',
  mailpitUrl: 'http://localhost:8025',
});

function makeRecord(overrides: Record<string, any> = {}): Record<string, any> {
  const manifest = overrides.manifest ?? makeManifest(COMMIT_A, '1');
  return buildDeploymentRecord({
    environment: 'rehearsal-local',
    mode: 'deploy',
    actor: 'rehearsal',
    deployedAt: '2026-08-24T10:00:00.000Z',
    manifest,
    manifestFile: 'releases/example.json',
    migration: { result: 'applied', verifiedHead: manifest.migrations.head },
    backupPreflight: { result: 'taken', artifact: 'orgistry-20260824-pre-deploy.dump' },
    smoke: { result: 'passed', checks: 9 },
    runtimeDigests: { api: manifest.images.api.digest, web: manifest.images.web.digest },
    publicConfig: PUBLIC_CONFIG,
    limitations: [],
    ...overrides,
  });
}

describe('validateDeploymentRecord', () => {
  it('accepts a complete record', () => {
    expect(validateDeploymentRecord(makeRecord())).toEqual({ valid: true, issues: [] });
  });

  it('requires observed digests when smoke passed', () => {
    const record = makeRecord({ runtimeDigests: { api: null, web: null } });
    const { valid, issues } = validateDeploymentRecord(record);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('required when smoke passed');
  });

  it('allows absent digests when nothing was started', () => {
    const record = makeRecord({
      runtimeDigests: { api: null, web: null },
      migration: { result: 'failed' },
      smoke: { result: 'not-run' },
    });
    expect(validateDeploymentRecord(record).valid).toBe(true);
  });

  it('refuses an unexplained backup skip', () => {
    const record = makeRecord({ backupPreflight: { result: 'skipped' } });
    const { valid, issues } = validateDeploymentRecord(record);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('backupPreflight.reason is required');
  });

  it('refuses an unexplained migration skip', () => {
    const record = makeRecord({ migration: { result: 'skipped' } });
    expect(validateDeploymentRecord(record).valid).toBe(false);
  });

  it('refuses a record carrying a credential', () => {
    const record = makeRecord();
    record.limitations = ['operator note: SMTP_PASSWORD=hunter2 was rotated'];
    const { valid, issues } = validateDeploymentRecord(record);
    expect(valid).toBe(false);
    expect(issues.join(' ')).toContain('must contain no secrets');
  });
});

describe('selectRollbackTarget', () => {
  const releaseA = makeRecord({ deployedAt: '2026-08-24T10:00:00.000Z' });
  const releaseB = makeRecord({
    manifest: makeManifest(COMMIT_B, '2'),
    deployedAt: '2026-08-24T11:00:00.000Z',
  });

  it('returns the most recent other release whose smoke passed', () => {
    const target = selectRollbackTarget([releaseA, releaseB], releaseB);
    expect(target.release.commit).toBe(COMMIT_A);
  });

  it('never selects a release whose smoke failed', () => {
    const failed = makeRecord({
      manifest: makeManifest(COMMIT_B, '3'),
      deployedAt: '2026-08-24T12:00:00.000Z',
      smoke: { result: 'failed' },
      runtimeDigests: { api: null, web: null },
    });
    const target = selectRollbackTarget([releaseA, failed], failed);
    expect(target.release.commit).toBe(COMMIT_A);
  });

  it('never selects the release currently deployed', () => {
    expect(selectRollbackTarget([releaseA], releaseA)).toBeNull();
  });

  it('returns null when the environment has no earlier good deployment', () => {
    expect(selectRollbackTarget([], releaseA)).toBeNull();
  });

  it('does not offer a release that was already rolled away from', () => {
    // After rolling back from B to A the ledger holds A, B, and the rollback
    // record (A again). B's smoke passed — a release can serve /health
    // perfectly and still be the reason for the rollback — so only the
    // rolled-away-from rule stops the next rollback from restoring it.
    const rollbackToA = makeRecord({
      mode: 'rollback',
      deployedAt: '2026-08-24T12:00:00.000Z',
      migration: { result: 'skipped', reason: 'rollback' },
    });
    expect(selectRollbackTarget([releaseA, releaseB, rollbackToA], rollbackToA)).toBeNull();
  });

  it('keeps offering older releases after a rollback', () => {
    const releaseC = makeRecord({
      manifest: makeManifest(COMMIT_B, '4'),
      deployedAt: '2026-08-24T12:00:00.000Z',
    });
    const rollbackToB = makeRecord({
      manifest: makeManifest(COMMIT_B, '2'),
      mode: 'rollback',
      deployedAt: '2026-08-24T13:00:00.000Z',
      migration: { result: 'skipped', reason: 'rollback' },
    });
    // C was rolled away from; B is current; A remains available.
    const target = selectRollbackTarget([releaseA, releaseB, releaseC, rollbackToB], rollbackToB);
    expect(target.release.commit).toBe(COMMIT_A);
  });
});

describe('public configuration identity', () => {
  it('fingerprints the applied configuration deterministically', () => {
    const first = buildPublicConfigIdentity({
      apiBaseUrl: 'https://api.example.test',
      csrfHeaderName: 'x-orgistry-csrf',
      mailpitUrl: 'http://localhost:8025',
    });
    // Same values, different key order: the fingerprint must not move, or
    // rollback would report a configuration change that never happened.
    const second = buildPublicConfigIdentity({
      mailpitUrl: 'http://localhost:8025',
      apiBaseUrl: 'https://api.example.test',
      csrfHeaderName: 'x-orgistry-csrf',
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the fingerprint when the API origin changes', () => {
    const staging = buildPublicConfigIdentity({
      apiBaseUrl: 'https://api.staging.example.test',
      csrfHeaderName: 'x-orgistry-csrf',
      mailpitUrl: 'http://localhost:8025',
    });
    expect(staging.fingerprint).not.toBe(PUBLIC_CONFIG.fingerprint);
  });

  it('refuses a key outside the public contract', () => {
    expect(() =>
      buildPublicConfigIdentity({ apiBaseUrl: 'https://api.example.test', jwtSecret: 'leaked' }),
    ).toThrow(/may only contain/);
  });

  it('is required on every record, and must stay inside the public contract', () => {
    const withoutConfig = makeRecord();
    delete withoutConfig.publicConfig;
    expect(validateDeploymentRecord(withoutConfig).issues.join(' ')).toContain('publicConfig');

    const smuggled = makeRecord();
    smuggled.publicConfig = {
      fingerprint: PUBLIC_CONFIG.fingerprint,
      values: { apiBaseUrl: 'https://api.example.test', smtpPassword: 'leaked' },
    };
    expect(validateDeploymentRecord(smuggled).issues.join(' ')).toContain('may only contain public keys');
  });
});

describe('release authorization', () => {
  it('records the release type, provenance, and deployability it deployed', () => {
    const record = makeRecord();
    expect(record.authorization.releaseType).toBe('rehearsal');
    expect(record.authorization.deployable).toBe(false);
    expect(record.authorization.provenance).toBe('commit');
  });

  it('carries the gate run identities of a deployable release', () => {
    const manifest = makeManifest(COMMIT_A, '1');
    manifest.release = { type: 'published', deployable: true };
    manifest.gates = {
      headSha: COMMIT_A,
      verifiedAt: '2026-08-24T09:05:00.000Z',
      required: [{ check: 'Validate (offline)', runId: '32700000001', conclusion: 'success' }],
    };
    const record = makeRecord({ manifest });
    expect(record.authorization.gateRuns).toEqual([
      { check: 'Validate (offline)', runId: '32700000001', conclusion: 'success' },
    ]);
    expect(validateDeploymentRecord(record).valid).toBe(true);
  });

  it('refuses gate runs on a record whose release was not deployable', () => {
    const record = makeRecord();
    record.authorization.gateRuns = [{ check: 'Validate (offline)', runId: '1', conclusion: 'success' }];
    expect(validateDeploymentRecord(record).issues.join(' ')).toContain(
      'must be absent for a release that was not deployable',
    );
  });
});
