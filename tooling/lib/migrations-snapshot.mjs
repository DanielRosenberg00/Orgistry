// Content snapshotting for the schema-drift check.
//
// The drift check must answer exactly one question: "did regenerating
// migrations from the current schema CHANGE anything under the migrations
// directory?" That is a before/after comparison of directory CONTENT — it is
// deliberately independent of git state, so a correctly generated migration
// that is not yet committed does not read as drift, while any file that
// generation adds, rewrites, or removes does.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Snapshot a directory as a Map of relative POSIX path -> SHA-256 content
 * hash, recursing into subdirectories. A missing root yields an empty
 * snapshot (generation may create the directory on first use).
 */
export function snapshotDirectory(rootDir) {
  const snapshot = new Map();
  let rootStat;
  try {
    rootStat = statSync(rootDir);
  } catch {
    return snapshot;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const hash = createHash('sha256')
          .update(readFileSync(absolute))
          .digest('hex');
        snapshot.set(relative(rootDir, absolute).split('\\').join('/'), hash);
      }
    }
  };
  walk(rootDir);
  return snapshot;
}

/**
 * Compare two snapshots. Returns human-readable difference lines
 * (`added/removed/changed <path>`), sorted; an empty array means the
 * directories have identical content.
 */
export function diffSnapshots(before, after) {
  const differences = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) {
      differences.push(`added   ${path}`);
    } else if (before.get(path) !== hash) {
      differences.push(`changed ${path}`);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      differences.push(`removed ${path}`);
    }
  }
  return differences.sort();
}
