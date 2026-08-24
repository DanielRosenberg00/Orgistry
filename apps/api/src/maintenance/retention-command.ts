import { getConfig } from '@orgistry/config';
import { createDbClient } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import {
  formatRetentionSummary,
  parseRetentionArgs,
  retentionExitCode,
  RETENTION_USAGE,
} from './retention-cli';
import { runRetentionCleanup } from './retention';

/**
 * One-shot retention cleanup command (Sprint 25, ORG-PR-015).
 *
 * Entry points:
 *   source mode     `pnpm db:retention -- --apply`
 *   built artifact  `node dist/retention.mjs --apply`   (apps/api/scripts/build.mjs)
 *
 * It is a COMMAND, not a service: it connects, sweeps, prints a summary,
 * closes the pool, and exits. No scheduler, no queue, no long-running worker
 * (ORG-PR-016 remains open) — an operator or a platform scheduler invokes it.
 *
 * Configuration comes from exactly the same path as the API process:
 * `loadWorkspaceEnv()` then `getConfig()`, which resolves `<NAME>_FILE`
 * mounted secrets and applies every production guard. A misconfigured
 * environment fails here for the same reason it would fail at API boot.
 */
async function main(): Promise<void> {
  const args = parseRetentionArgs(process.argv.slice(2));

  if (args.kind === 'help') {
    console.log(RETENTION_USAGE);
    return;
  }
  if (args.kind === 'error') {
    for (const message of args.messages) {
      console.error(`retention: ${message}`);
    }
    console.error(`\n${RETENTION_USAGE}`);
    process.exitCode = 2;
    return;
  }

  loadWorkspaceEnv();
  const config = getConfig();

  // A single connection is enough: categories run sequentially, and one batch
  // is one transaction.
  const client = createDbClient(config.database.url, { max: 1 });
  try {
    const summary = await runRetentionCleanup(client, {
      mode: args.mode,
      windows: config.retention,
      batchSize: args.batchSize ?? config.retention.cleanupBatchSize,
      maxBatchesPerCategory: args.maxBatchesPerCategory,
      categories: args.categories,
      now: new Date(),
    });

    console.log(
      args.json ? JSON.stringify(summary) : formatRetentionSummary(summary),
    );
    process.exitCode = retentionExitCode(summary);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  // Reaching here means the run could not start (bad configuration,
  // unreachable database). Per-category failures never propagate — they are
  // reported in the summary. The message is printed without its stack's
  // surrounding context; no query parameters or row data are available here.
  console.error(
    'Retention cleanup failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
