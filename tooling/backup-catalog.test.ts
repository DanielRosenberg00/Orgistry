/**
 * Backup catalog contract (Sprint 28, ORG-PR-005).
 *
 * The catalog is what an operator reads during an incident, so the tests are
 * about the two things that would mislead one: a recovery point that does not
 * really exist, and a rendering that leaks something it should not.
 */
import { describe, expect, it } from 'vitest';

import {
  baseBackupObjectKeys,
  buildCatalog,
  buildRecoveryPoint,
  logicalObjectKeys,
  renderCatalog,
  summariseWalWindow,
  walObjectKey,
  walSegmentName,
} from './lib/backup-catalog.mjs';

const METADATA = {
  artifact: 'orgistry-20260827T100354Z-scheduled.dump',
  created_at: '2026-08-27T10:03:54Z',
  database: 'orgistry',
  source_environment: 'staging-like',
  source_host: 'orgistry-staging-01',
  postgres_server_version: '16.14',
  applied_migrations: 13,
  bytes: 91_234,
  sha256: 'f'.repeat(64),
  encrypted: true,
  encryption_key_id: '0123456789abcdef',
  object_key: 'orgistry/staging-like/logical/orgistry-20260827T100354Z-scheduled.dump.enc',
};

const STORED = {
  key: METADATA.object_key,
  size: 91_300,
  lastModified: '2026-08-27T10:04:02.000Z',
  etag: 'abc',
};

describe('object key layout', () => {
  it('places each artifact class under its own prefix', () => {
    expect(logicalObjectKeys('x.dump')).toEqual({
      artifact: 'logical/x.dump.enc',
      metadata: 'logical/x.dump.meta.json',
    });
    expect(baseBackupObjectKeys('orgistry-base-1')).toEqual({
      artifact: 'basebackup/orgistry-base-1.tar.gz.enc',
      metadata: 'basebackup/orgistry-base-1.meta.json',
    });
    expect(walObjectKey('000000010000000000000003')).toBe('wal/000000010000000000000003.enc');
  });

  it('round-trips a WAL segment name through its stored key', () => {
    const segment = '000000010000000000000003';
    expect(walSegmentName(`orgistry/staging-like/${walObjectKey(segment)}`)).toBe(segment);
  });
});

describe('buildRecoveryPoint', () => {
  it('records a stored recovery point as uploaded with its lifecycle date', () => {
    const point = buildRecoveryPoint({ metadata: METADATA, storedObject: STORED, retentionDays: 30, kind: 'logical' });
    expect(point.uploadState).toBe('uploaded');
    expect(point.encrypted).toBe(true);
    expect(point.encryptionKeyId).toBe('0123456789abcdef');
    expect(point.storedBytes).toBe(91_300);
    expect(point.retentionExpiresAt).toBe('2026-09-26T10:03:54Z');
    expect(point.sourceHost).toBe('orgistry-staging-01');
  });

  it('reports metadata with no artifact as orphaned rather than dropping it', () => {
    const point = buildRecoveryPoint({ metadata: METADATA, storedObject: undefined, retentionDays: 30, kind: 'logical' });
    expect(point.uploadState).toBe('orphaned-metadata');
    expect(point.objectKey).toBe('');
  });

  it('never claims encryption that the metadata does not assert', () => {
    const point = buildRecoveryPoint({
      metadata: { ...METADATA, encrypted: false },
      storedObject: STORED,
      retentionDays: 30,
      kind: 'logical',
    });
    expect(point.encrypted).toBe(false);
  });
});

describe('summariseWalWindow', () => {
  it('reports no window when nothing is archived', () => {
    expect(summariseWalWindow([]).segments).toBe(0);
    expect(summariseWalWindow([]).earliestSegment).toBe('');
  });

  it('derives the window from the earliest and latest segments', () => {
    const window = summariseWalWindow([
      { key: 'p/wal/000000010000000000000005.enc', size: 100, lastModified: '2026-08-27T11:00:00.000Z', etag: '' },
      { key: 'p/wal/000000010000000000000003.enc', size: 120, lastModified: '2026-08-27T10:00:00.000Z', etag: '' },
    ]);
    expect(window.segments).toBe(2);
    expect(window.earliestSegment).toBe('000000010000000000000003');
    expect(window.latestSegment).toBe('000000010000000000000005');
    expect(window.earliestArchivedAt).toBe('2026-08-27T10:00:00.000Z');
    expect(window.latestArchivedAt).toBe('2026-08-27T11:00:00.000Z');
    expect(window.bytes).toBe(220);
  });
});

describe('buildCatalog / renderCatalog', () => {
  const catalog = buildCatalog({
    target: {
      endpoint: 'https://ams3.digitaloceanspaces.com',
      region: 'ams3',
      bucket: 'orgistry-backups',
      prefix: 'orgistry/staging-like',
      addressing: 'path',
    },
    logicalPoints: [
      buildRecoveryPoint({ metadata: METADATA, storedObject: STORED, retentionDays: 30, kind: 'logical' }),
      buildRecoveryPoint({
        metadata: { ...METADATA, artifact: 'older.dump', created_at: '2026-08-26T10:03:54Z' },
        storedObject: { ...STORED, key: 'older' },
        retentionDays: 30,
        kind: 'logical',
      }),
    ],
    basePoints: [],
    walObjects: [
      { key: 'p/wal/000000010000000000000003.enc', size: 120, lastModified: '2026-08-27T10:00:00.000Z', etag: '' },
    ],
    generatedAt: '2026-08-27T12:00:00Z',
  });

  it('orders recovery points newest first — the one an incident reaches for', () => {
    expect(catalog.logical.map((point) => point.id)).toEqual([METADATA.artifact, 'older.dump']);
  });

  it('renders every field an operator needs to plan a recovery', () => {
    const rendered = renderCatalog(catalog);
    expect(rendered).toContain('orgistry-backups/orgistry/staging-like');
    expect(rendered).toContain(METADATA.artifact);
    expect(rendered).toContain('encrypted=yes(key 0123456789abcdef)');
    expect(rendered).toContain('000000010000000000000003');
  });

  it('states plainly when there is no point-in-time recovery window', () => {
    const empty = buildCatalog({ ...catalog, walObjects: [], logicalPoints: [], basePoints: [] });
    expect(renderCatalog(empty)).toContain('no point-in-time recovery window exists');
  });

  it('renders a truncated digest, never a connection string or key material', () => {
    const rendered = renderCatalog(catalog);
    expect(rendered).toContain('sha256=ffffffffffff…');
    expect(rendered).not.toContain('f'.repeat(64));
    expect(rendered).not.toContain('postgres://');
  });
});
