// Schema drift check.
//
// Drizzle migrations are generated from the TypeScript schema
// (`packages/db/src/schema`). If someone edits the schema but forgets to run
// `pnpm db:generate`, the committed SQL migrations no longer match the schema —
// a silent drift that only surfaces on the next deploy.
//
// This guard snapshots the migrations directory, regenerates migrations
// (offline, no database needed), and fails if regeneration changed anything.
// The comparison is CONTENT before-vs-after generation, not git status: a
// correctly generated migration that is not yet committed is in sync and must
// pass, while any file generation adds, rewrites, or removes is drift. CI runs
// this on a clean checkout, so a schema change committed without its migration
// still fails there (generation produces the missing files).
//
// Exit 0 = in sync. Exit 1 = drift detected (or the check itself errored).

import { execFileSync } from 'node:child_process';
import { diffSnapshots, snapshotDirectory } from './lib/migrations-snapshot.mjs';

const MIGRATIONS_PATH = 'packages/db/migrations';

try {
  const before = snapshotDirectory(MIGRATIONS_PATH);

  // Regenerate from the current schema. Idempotent when already in sync.
  execFileSync('pnpm', ['--filter', '@orgistry/db', 'run', 'generate'], {
    encoding: 'utf8',
  });

  const differences = diffSnapshots(before, snapshotDirectory(MIGRATIONS_PATH));

  if (differences.length > 0) {
    console.error('Schema drift detected: regenerating migrations changed the migrations directory.');
    console.error('The schema was edited without `pnpm db:generate`. Review the generated migration and include it with the schema change.\n');
    console.error('Changes under ' + MIGRATIONS_PATH + ':');
    console.error(differences.join('\n'));
    process.exit(1);
  }

  console.log('Schema drift check passed: migrations are in sync with the schema.');
} catch (error) {
  console.error('Schema drift check failed to run.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
