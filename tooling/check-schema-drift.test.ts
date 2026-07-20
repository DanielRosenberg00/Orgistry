import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import { diffSnapshots, snapshotDirectory } from './lib/migrations-snapshot.mjs';

/**
 * The drift check's contract is a CONTENT before/after comparison around
 * migration generation — deliberately independent of git state, so a
 * correctly generated but uncommitted migration passes while anything
 * generation adds, rewrites, or removes fails. These tests pin that contract
 * at the helper level (the script itself is a thin CLI around them).
 */

const tempDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-check-'));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(dir, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('snapshotDirectory', () => {
  it('captures nested files with content hashes, keyed by relative path', () => {
    const dir = makeDir({
      '0001_a.sql': 'CREATE TABLE a;',
      'meta/_journal.json': '{"entries":[]}',
    });
    const snapshot = snapshotDirectory(dir);
    expect([...snapshot.keys()].sort()).toEqual([
      '0001_a.sql',
      'meta/_journal.json',
    ]);
    for (const hash of snapshot.values()) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('treats a missing directory as an empty snapshot (first generation)', () => {
    expect(snapshotDirectory(join(tmpdir(), 'does-not-exist-drift'))).toEqual(
      new Map(),
    );
  });
});

describe('diffSnapshots', () => {
  it('reports no differences for identical content (uncommitted is NOT drift)', () => {
    const dir = makeDir({
      '0009_new.sql': 'CREATE TABLE t;',
      'meta/_journal.json': '{"entries":[1]}',
    });
    // Same directory snapshotted twice = the idempotent-generation case.
    expect(
      diffSnapshots(snapshotDirectory(dir), snapshotDirectory(dir)),
    ).toEqual([]);
  });

  it('reports a file generation added', () => {
    const before = snapshotDirectory(makeDir({ '0001_a.sql': 'a' }));
    const after = snapshotDirectory(
      makeDir({ '0001_a.sql': 'a', '0002_b.sql': 'b' }),
    );
    expect(diffSnapshots(before, after)).toEqual(['added   0002_b.sql']);
  });

  it('reports a file generation rewrote', () => {
    const before = snapshotDirectory(makeDir({ 'meta/_journal.json': 'v1' }));
    const after = snapshotDirectory(makeDir({ 'meta/_journal.json': 'v2' }));
    expect(diffSnapshots(before, after)).toEqual([
      'changed meta/_journal.json',
    ]);
  });

  it('reports a file generation removed', () => {
    const before = snapshotDirectory(
      makeDir({ '0001_a.sql': 'a', '0002_b.sql': 'b' }),
    );
    const after = snapshotDirectory(makeDir({ '0001_a.sql': 'a' }));
    expect(diffSnapshots(before, after)).toEqual(['removed 0002_b.sql']);
  });
});
