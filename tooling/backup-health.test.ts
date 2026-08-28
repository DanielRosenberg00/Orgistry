/**
 * Backup and WAL-archive health contract (Sprint 28, ORG-PR-005).
 *
 * Each test pins one way a backup programme dies quietly. A health check that
 * returns PASS in any of these situations is worse than no health check,
 * because it converts an outage into a surprise during recovery.
 */
import { describe, expect, it } from 'vitest';

import { evaluateBackupHealth, evaluateWalArchiveHealth, renderHealth } from './lib/backup-health.mjs';

const NOW = '2026-08-27T12:00:00Z';
const THRESHOLDS = { backupMaxAgeHours: 26, walMaxAgeMinutes: 15 };

function recoveryPoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'orgistry-20260827T100354Z.dump',
    takenAt: '2026-08-27T10:03:54Z',
    uploadState: 'uploaded',
    encrypted: true,
    encryptionKeyId: '0123456789abcdef',
    plaintextSha256: 'f'.repeat(64),
    ...overrides,
  };
}

function catalogWith(logical: unknown[]) {
  return { logical, baseBackups: [], wal: { segments: 0 } } as never;
}

describe('evaluateBackupHealth', () => {
  it('is healthy when a fresh, encrypted, checksummed backup is off-host', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint()]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'succeeded', finishedAt: '2026-08-27T10:04:10Z' },
    });
    expect(result.healthy).toBe(true);
    expect(result.recoveryPoints).toBe(1);
    expect(result.latestRecoveryPoint).toEqual({ id: recoveryPoint().id, takenAt: '2026-08-27T10:03:54Z' });
  });

  it('fails when nothing has ever been stored off-host', () => {
    const result = evaluateBackupHealth({ catalog: catalogWith([]), now: NOW, thresholds: THRESHOLDS });
    expect(result.healthy).toBe(false);
    expect(renderHealth('Backup health', result)).toContain('no uploaded logical backup exists off-host');
  });

  it('fails when the newest backup is older than the freshness limit', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint({ takenAt: '2026-08-25T10:00:00Z' })]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'succeeded', finishedAt: '2026-08-25T10:01:00Z' },
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('Backup health', result)).toMatch(/older than the 26h limit/);
  });

  it('fails when the newest backup is stored unencrypted', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint({ encrypted: false })]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'succeeded', finishedAt: NOW },
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('Backup health', result)).toContain('is stored unencrypted');
  });

  it('fails on an interrupted upload even though the metadata looks complete', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint(), recoveryPoint({ id: 'half.dump', uploadState: 'orphaned-metadata' })]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'succeeded', finishedAt: NOW },
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('Backup health', result)).toContain('metadata document(s) with no artifact: half.dump');
  });

  it('fails on a recorded failed run even while an older artifact is still fresh', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint()]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'failed', finishedAt: '2026-08-27T11:00:00Z', detail: 'pg_dump failed (exit 1)' },
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('Backup health', result)).toContain('pg_dump failed (exit 1)');
  });

  it('warns — but stays healthy — before the first scheduled run has fired', () => {
    const result = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint()]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: null,
    });
    expect(result.healthy).toBe(true);
    expect(result.warnedCount).toBe(1);
  });
});

const ARCHIVER = {
  archiveMode: 'on',
  // The database has written into the current segment since the last switch,
  // so freshness limits apply. The idle case is covered separately below.
  walPending: true,
  pendingWalBytes: 4096,
  currentWalFile: '00000001000000000000000A',
  archivedCount: 42,
  lastArchivedTime: '2026-08-27T11:55:00Z',
  failedCount: 0,
  lastFailedTime: '',
  lastFailedWal: '',
  lastArchivedWal: '000000010000000000000009',
};

const WAL_WINDOW = {
  segments: 9,
  earliestSegment: '000000010000000000000001',
  latestSegment: '000000010000000000000009',
  earliestArchivedAt: '2026-08-27T10:00:00Z',
  latestArchivedAt: '2026-08-27T11:56:00Z',
};

const DRAINED_SPOOL = { pendingSegments: 0, oldestPendingAgeMinutes: 0 };

describe('evaluateWalArchiveHealth', () => {
  it('is healthy when archiving, shipping, and the off-host window all agree', () => {
    const result = evaluateWalArchiveHealth({
      archiver: ARCHIVER,
      spool: DRAINED_SPOOL,
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(true);
    expect(result.recoveryWindow.segments).toBe(9);
  });

  it('fails when archive_mode is off — there is no WAL at all', () => {
    const result = evaluateWalArchiveHealth({
      archiver: { ...ARCHIVER, archiveMode: 'off', archivedCount: 0, lastArchivedTime: '', walPending: false },
      spool: DRAINED_SPOOL,
      walWindow: { segments: 0 },
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toContain('no WAL is being archived');
  });

  it('fails while archive_command is currently failing', () => {
    const result = evaluateWalArchiveHealth({
      archiver: {
        ...ARCHIVER,
        failedCount: 3,
        lastFailedTime: '2026-08-27T11:58:00Z',
        lastFailedWal: '00000001000000000000000A',
      },
      spool: DRAINED_SPOOL,
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toContain('archive_command is failing');
  });

  it('only warns about failures the archiver has since recovered from', () => {
    const result = evaluateWalArchiveHealth({
      archiver: { ...ARCHIVER, failedCount: 3, lastFailedTime: '2026-08-27T10:30:00Z' },
      spool: DRAINED_SPOOL,
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(true);
    expect(result.warnedCount).toBe(1);
  });

  it('fails when WAL is archiving locally but is not reaching off-host storage', () => {
    const result = evaluateWalArchiveHealth({
      archiver: ARCHIVER,
      spool: { pendingSegments: 12, oldestPendingAgeMinutes: 90 },
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toContain('is NOT reaching off-host storage');
  });

  it('tolerates a spool that is merely between shipments', () => {
    const result = evaluateWalArchiveHealth({
      archiver: ARCHIVER,
      spool: { pendingSegments: 1, oldestPendingAgeMinutes: 2 },
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(true);
  });

  it('does not penalise an IDLE database for an ageing archive', () => {
    // Regression: `archive_timeout` only forces a switch when something was
    // written, so an untouched database archives nothing and its newest
    // segment ages forever while remaining fully recoverable. Reporting that
    // as unhealthy would refuse deployments to a protected environment.
    const result = evaluateWalArchiveHealth({
      archiver: {
        ...ARCHIVER,
        walPending: false,
        pendingWalBytes: 96,
        lastArchivedTime: '2026-08-27T02:00:00Z',
      },
      spool: DRAINED_SPOOL,
      walWindow: { ...WAL_WINDOW, latestArchivedAt: '2026-08-27T02:00:30Z' },
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(true);
    const rendered = renderHealth('WAL', result);
    expect(rendered).toContain('no WAL pending');
    expect(rendered).toContain('nothing left to archive');
  });

  it('still fails when WAL IS pending and the archive has fallen behind', () => {
    const result = evaluateWalArchiveHealth({
      archiver: { ...ARCHIVER, walPending: true, lastArchivedTime: '2026-08-27T09:00:00Z' },
      spool: DRAINED_SPOOL,
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toContain('WAL is pending but the last segment was archived');
  });

  it('fails when PostgreSQL has stopped producing segments', () => {
    const result = evaluateWalArchiveHealth({
      archiver: { ...ARCHIVER, walPending: true, lastArchivedTime: '2026-08-27T09:00:00Z' },
      spool: DRAINED_SPOOL,
      walWindow: WAL_WINDOW,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toMatch(/older than the 15m limit/);
  });

  it('fails when nothing is archived off-host, which means no PITR window', () => {
    const result = evaluateWalArchiveHealth({
      archiver: ARCHIVER,
      spool: DRAINED_SPOOL,
      walWindow: { segments: 0 },
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.healthy).toBe(false);
    expect(renderHealth('WAL', result)).toContain('there is no PITR window');
  });
});

describe('renderHealth', () => {
  it('ends with an unambiguous verdict line', () => {
    const healthy = evaluateBackupHealth({
      catalog: catalogWith([recoveryPoint()]),
      now: NOW,
      thresholds: THRESHOLDS,
      lastRun: { result: 'succeeded', finishedAt: NOW },
    });
    expect(renderHealth('Backup health', healthy).trim().endsWith('=> HEALTHY (0 warning(s))')).toBe(true);
    const unhealthy = evaluateBackupHealth({ catalog: catalogWith([]), now: NOW, thresholds: THRESHOLDS });
    expect(renderHealth('Backup health', unhealthy)).toContain('=> UNHEALTHY');
  });
});
