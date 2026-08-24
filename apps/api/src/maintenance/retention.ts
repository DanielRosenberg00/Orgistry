import type { DbClient } from '@orgistry/db';
import {
  RETENTION_CATEGORIES,
  retentionCutoff,
  type RetentionCategory,
  type RetentionCategoryName,
  type RetentionRunContext,
  type RetentionWindows,
} from './retention-policy';

/**
 * Retention cleanup executor (Sprint 25, ORG-PR-015).
 *
 * Runs the categories declared in `retention-policy.ts` and reports what it
 * found or removed. It owns exactly three behaviors and no policy:
 *
 *  - **Mode.** `dry-run` counts and mutates NOTHING — not one statement in
 *    this file writes in dry-run mode. `apply` deletes.
 *  - **Batching.** Apply mode repeats bounded batches until a batch comes
 *    back short (nothing left) or `maxBatchesPerCategory` is reached. Each
 *    batch is ONE transaction, so a sweep never holds a long destructive
 *    lock and an interrupted run leaves whole batches committed rather than a
 *    half-deleted category.
 *  - **Isolation.** A category that throws is recorded as failed and the run
 *    continues with the next one; the summary reports the failure and the
 *    caller exits non-zero.
 *
 * Output discipline: the summary carries COUNTS and category metadata only.
 * No row, id, email, token, hash, or connection string is ever placed in a
 * result — the summary is printed to a terminal and may be captured by CI.
 */

export type RetentionMode = 'dry-run' | 'apply';

export interface RetentionRunOptions {
  /** `dry-run` counts only; `apply` deletes. */
  readonly mode: RetentionMode;
  /** Configured retention windows (from `Config['retention']`). */
  readonly windows: RetentionWindows;
  /** Rows per batch. One batch is one transaction. */
  readonly batchSize: number;
  /**
   * Safety stop: the most batches one category may run in a single execution.
   * Reaching it marks the category `truncated` — the run did not finish the
   * backlog, and the operator should simply run the command again.
   */
  readonly maxBatchesPerCategory: number;
  /** Categories to run, in catalog order. */
  readonly categories: readonly RetentionCategory[];
  /** The instant every cutoff is derived from. Explicit so runs are reproducible. */
  readonly now: Date;
}

export interface RetentionCategoryResult {
  readonly category: RetentionCategoryName;
  readonly table: string;
  readonly retentionColumn: string;
  readonly retentionDays: number;
  /** ISO-8601 instant; rows strictly older than this were eligible. */
  readonly cutoff: string;
  /** Eligible rows counted in dry-run mode; `null` in apply mode. */
  readonly eligible: number | null;
  /** Rows deleted. Always `0` in dry-run mode. */
  readonly deleted: number;
  /** Batches executed. Always `0` in dry-run mode. */
  readonly batches: number;
  /** True when the batch cap stopped the category before the backlog was clear. */
  readonly truncated: boolean;
  /** Present only when the category failed; carries no row data (see `describeFailure`). */
  readonly failure?: RetentionFailure;
}

export interface RetentionFailure {
  /** PostgreSQL SQLSTATE when the driver reported one. */
  readonly code?: string;
  /** The error's primary message. Never its `detail`/`hint` (those can echo row values). */
  readonly message: string;
}

export interface RetentionRunSummary {
  readonly mode: RetentionMode;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly batchSize: number;
  readonly results: readonly RetentionCategoryResult[];
  readonly totalDeleted: number;
  readonly failedCategories: number;
}

/**
 * Reduce an unknown thrown value to a summary-safe description.
 *
 * Two deliberate narrowings:
 *  - PostgreSQL puts offending column VALUES in the `detail` and `hint`
 *    fields of a constraint error, so only `message` (the primary message —
 *    object names, not row values) and `code` are carried forward;
 *  - Drizzle appends a `\nparams: …` block listing the bound parameters to
 *    its `Failed query` message. Cleanup only ever binds a cutoff instant and
 *    a batch size, but the summary is printed to terminals and CI logs, so the
 *    message is truncated at the first newline rather than relying on that.
 */
function describeFailure(error: unknown): RetentionFailure {
  if (typeof error !== 'object' || error === null) {
    return { message: 'Unknown cleanup failure' };
  }
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const message =
    typeof candidate.message === 'string' && candidate.message.length > 0
      ? (candidate.message.split('\n')[0] as string)
      : 'Unknown cleanup failure';
  if (code !== undefined) {
    return { code, message };
  }
  // Drizzle wraps driver errors; look one level down for the SQLSTATE.
  const causeCode = (candidate.cause as { code?: unknown } | undefined)?.code;
  return typeof causeCode === 'string' ? { code: causeCode, message } : { message };
}

/** Count eligible rows without mutating anything. */
async function runDryRunCategory(
  client: DbClient,
  category: RetentionCategory,
  cutoff: Date,
  context: RetentionRunContext,
): Promise<{ eligible: number }> {
  return { eligible: await category.countEligible(client.db, cutoff, context) };
}

/**
 * Delete eligible rows in bounded batches, one transaction per batch. Stops
 * on the first short batch (the backlog is clear) or at the batch cap.
 */
async function runApplyCategory(
  client: DbClient,
  category: RetentionCategory,
  cutoff: Date,
  options: Pick<RetentionRunOptions, 'batchSize' | 'maxBatchesPerCategory'>,
  context: RetentionRunContext,
): Promise<{ deleted: number; batches: number; truncated: boolean }> {
  let deleted = 0;
  let batches = 0;

  while (batches < options.maxBatchesPerCategory) {
    const batchDeleted = await client.db.transaction((tx) =>
      category.deleteBatch(tx, cutoff, options.batchSize, context),
    );
    batches += 1;
    deleted += batchDeleted;

    // A short batch means the predicate has nothing left to match.
    if (batchDeleted < options.batchSize) {
      return { deleted, batches, truncated: false };
    }
  }

  return { deleted, batches, truncated: true };
}

/**
 * Run the retention cleanup and return a summary. Never throws for a
 * category-level failure — the failure is recorded in that category's result
 * and `failedCategories` is incremented.
 */
export async function runRetentionCleanup(
  client: DbClient,
  options: RetentionRunOptions,
): Promise<RetentionRunSummary> {
  const startedAt = Date.now();
  const results: RetentionCategoryResult[] = [];
  const context: RetentionRunContext = {
    windows: options.windows,
    now: options.now,
  };

  for (const category of options.categories) {
    const cutoff = retentionCutoff(category, options.windows, options.now);
    const common = {
      category: category.name,
      table: category.table,
      retentionColumn: category.retentionColumn,
      retentionDays: category.windowDays(options.windows),
      cutoff: cutoff.toISOString(),
    } as const;

    try {
      if (options.mode === 'dry-run') {
        const { eligible } = await runDryRunCategory(client, category, cutoff, context);
        results.push({ ...common, eligible, deleted: 0, batches: 0, truncated: false });
      } else {
        const outcome = await runApplyCategory(client, category, cutoff, options, context);
        results.push({ ...common, eligible: null, ...outcome });
      }
    } catch (error) {
      results.push({
        ...common,
        eligible: null,
        deleted: 0,
        batches: 0,
        truncated: false,
        failure: describeFailure(error),
      });
    }
  }

  return {
    mode: options.mode,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    batchSize: options.batchSize,
    results,
    totalDeleted: results.reduce((total, result) => total + result.deleted, 0),
    failedCategories: results.filter((result) => result.failure !== undefined).length,
  };
}

/** The full catalog, for callers that did not narrow with `--category`. */
export const ALL_RETENTION_CATEGORIES = RETENTION_CATEGORIES;
