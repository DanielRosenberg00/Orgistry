// Schema drift check.
//
// Drizzle migrations are generated from the TypeScript schema
// (`packages/db/src/schema`). If someone edits the schema but forgets to run
// `pnpm db:generate`, the committed SQL migrations no longer match the schema —
// a silent drift that only surfaces on the next deploy.
//
// This guard regenerates migrations (offline, no database needed) and fails if
// that produced any change under `packages/db/migrations`. A clean tree means
// the committed migrations are in sync with the schema.
//
// Exit 0 = in sync. Exit 1 = drift detected (or the check itself errored).

import { execFileSync } from 'node:child_process';

const MIGRATIONS_PATH = 'packages/db/migrations';

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

try {
  // Regenerate from the current schema. Idempotent when already in sync.
  run('pnpm', ['--filter', '@orgistry/db', 'run', 'generate']);

  // `git status --porcelain` lists any added/modified/untracked migration files.
  const status = run('git', ['status', '--porcelain', '--', MIGRATIONS_PATH]);

  if (status.length > 0) {
    console.error('Schema drift detected: committed migrations are out of sync with the schema.');
    console.error('Run `pnpm db:generate`, review the new migration, and commit it.\n');
    console.error('Pending changes under ' + MIGRATIONS_PATH + ':');
    console.error(status);
    process.exit(1);
  }

  console.log('Schema drift check passed: migrations are in sync with the schema.');
} catch (error) {
  console.error('Schema drift check failed to run.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
