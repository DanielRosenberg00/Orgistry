import { RETENTION_MAX_BATCH_SIZE } from '@orgistry/config';
import {
  RETENTION_CATEGORIES,
  RETENTION_CATEGORY_NAMES,
  findRetentionCategory,
  type RetentionCategory,
} from './retention-policy';
import type { RetentionMode, RetentionRunSummary } from './retention';

/**
 * Argument surface and report formatting for the retention command
 * (Sprint 25, ORG-PR-015).
 *
 * Kept free of process, database, and filesystem access so the operator
 * contract — which flags exist, what they reject, and exactly what the
 * command prints — is unit-testable without a database. Process wiring lives
 * in `retention-command.ts`.
 *
 * Operator-safety rule that shapes the whole parser: **deletion requires
 * `--apply`.** The default mode is `dry-run`, so a forgotten flag, a typo
 * that drops an argument, or a copied command line without its tail can only
 * ever produce a report. `--apply` and `--dry-run` are mutually exclusive and
 * both may be written explicitly.
 */

/** Safety stop on batches per category, per execution. */
export const DEFAULT_MAX_BATCHES_PER_CATEGORY = 1_000;

export const RETENTION_USAGE = `Usage: orgistry-retention [options]

Deletes expired, retention-eligible rows from the Orgistry database. Reports
only counts — never row contents.

Options:
  --dry-run              Report eligible rows and delete nothing (default).
  --apply                Delete eligible rows. Required for any mutation.
  --category=<name>      Limit the run to one category. Repeatable.
  --batch-size=<n>       Rows per batch (1-${RETENTION_MAX_BATCH_SIZE}).
                         Defaults to RETENTION_CLEANUP_BATCH_SIZE.
  --max-batches=<n>      Batches per category before stopping (default ${DEFAULT_MAX_BATCHES_PER_CATEGORY}).
  --json                 Emit the summary as one JSON object.
  --help                 Show this message.

Categories:
${RETENTION_CATEGORY_NAMES.map((name) => `  ${name}`).join('\n')}

Retention windows come from the runtime configuration
(RETENTION_SECURITY_EVENT_DAYS, RETENTION_EXPIRED_AUTH_TOKEN_DAYS,
RETENTION_ENDED_SESSION_DAYS). See docs/retention.md.`;

export interface RetentionRunRequest {
  readonly kind: 'run';
  readonly mode: RetentionMode;
  readonly categories: readonly RetentionCategory[];
  /** `undefined` means "use the configured RETENTION_CLEANUP_BATCH_SIZE". */
  readonly batchSize: number | undefined;
  readonly maxBatchesPerCategory: number;
  readonly json: boolean;
}

export type RetentionArgs =
  | RetentionRunRequest
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly messages: readonly string[] };

/** Parse `--name=value`, returning `null` for anything that is not that flag. */
function flagValue(argument: string, name: string): string | null {
  const prefix = `--${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

/**
 * Parse a bounded positive integer flag. Rejects empty values, non-digits,
 * and anything outside `[1, max]` — a silently-clamped batch size would hide
 * an operator mistake behind a working run.
 */
function parseBoundedInteger(
  raw: string,
  flag: string,
  max: number,
  errors: string[],
): number | undefined {
  if (!/^\d+$/.test(raw)) {
    errors.push(`${flag} must be a positive integer (got "${raw}")`);
    return undefined;
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    errors.push(`${flag} must be between 1 and ${max} (got ${value})`);
    return undefined;
  }
  return value;
}

/** Parse the command-line arguments (everything after the script name). */
export function parseRetentionArgs(argv: readonly string[]): RetentionArgs {
  const errors: string[] = [];
  const selected: RetentionCategory[] = [];
  let apply = false;
  let dryRun = false;
  let batchSize: number | undefined;
  let maxBatchesPerCategory = DEFAULT_MAX_BATCHES_PER_CATEGORY;
  let json = false;

  for (const argument of argv) {
    // `pnpm run <script> -- --apply` forwards a bare `--`. Treat it as the
    // conventional end-of-options marker rather than an unknown argument.
    if (argument === '--') {
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { kind: 'help' };
    }
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }

    const categoryName = flagValue(argument, 'category');
    if (categoryName !== null) {
      const category = findRetentionCategory(categoryName);
      if (category === undefined) {
        errors.push(
          `Unknown --category "${categoryName}". Known categories: ${RETENTION_CATEGORY_NAMES.join(', ')}`,
        );
      } else if (!selected.includes(category)) {
        selected.push(category);
      }
      continue;
    }

    const rawBatchSize = flagValue(argument, 'batch-size');
    if (rawBatchSize !== null) {
      batchSize = parseBoundedInteger(
        rawBatchSize,
        '--batch-size',
        RETENTION_MAX_BATCH_SIZE,
        errors,
      );
      continue;
    }

    const rawMaxBatches = flagValue(argument, 'max-batches');
    if (rawMaxBatches !== null) {
      const parsed = parseBoundedInteger(
        rawMaxBatches,
        '--max-batches',
        DEFAULT_MAX_BATCHES_PER_CATEGORY,
        errors,
      );
      if (parsed !== undefined) {
        maxBatchesPerCategory = parsed;
      }
      continue;
    }

    errors.push(`Unknown argument "${argument}"`);
  }

  if (apply && dryRun) {
    errors.push('--apply and --dry-run are mutually exclusive');
  }
  if (errors.length > 0) {
    return { kind: 'error', messages: errors };
  }

  return {
    kind: 'run',
    mode: apply ? 'apply' : 'dry-run',
    // Catalog order is preserved (it encodes the refresh-token-before-session
    // dependency), so a `--category` selection can never reorder the sweep.
    categories:
      selected.length > 0
        ? RETENTION_CATEGORIES.filter((category) => selected.includes(category))
        : RETENTION_CATEGORIES,
    batchSize,
    maxBatchesPerCategory,
    json,
  };
}

/**
 * Render a summary as operator-readable lines.
 *
 * Every value here is a count, a table/column name, a day count, or an ISO
 * cutoff — the formatter has no access to row data and cannot leak any.
 */
export function formatRetentionSummary(summary: RetentionRunSummary): string {
  const lines: string[] = [
    `retention cleanup: mode=${summary.mode} batch_size=${summary.batchSize} started_at=${summary.startedAt}`,
  ];

  for (const result of summary.results) {
    const scope = `${result.category} table=${result.table} retention_days=${result.retentionDays} cutoff=${result.cutoff}`;
    if (result.failure !== undefined) {
      const code = result.failure.code === undefined ? '' : ` code=${result.failure.code}`;
      lines.push(`  FAILED  ${scope}${code} error=${result.failure.message}`);
      continue;
    }
    if (summary.mode === 'dry-run') {
      lines.push(`  dry-run ${scope} eligible=${result.eligible ?? 0}`);
      continue;
    }
    const truncated = result.truncated ? ' truncated=true (rerun to continue)' : '';
    lines.push(
      `  applied ${scope} deleted=${result.deleted} batches=${result.batches}${truncated}`,
    );
  }

  lines.push(
    `retention cleanup: ${summary.mode === 'dry-run' ? 'no rows deleted (dry run)' : `deleted=${summary.totalDeleted}`} failed_categories=${summary.failedCategories} duration_ms=${summary.durationMs}`,
  );
  return lines.join('\n');
}

/** Process exit code: non-zero when any category failed. */
export function retentionExitCode(summary: RetentionRunSummary): number {
  return summary.failedCategories > 0 ? 1 : 0;
}
