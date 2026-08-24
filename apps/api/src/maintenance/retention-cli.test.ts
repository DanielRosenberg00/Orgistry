import { RETENTION_MAX_BATCH_SIZE } from '@orgistry/config';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BATCHES_PER_CATEGORY,
  formatRetentionSummary,
  parseRetentionArgs,
  retentionExitCode,
  RETENTION_USAGE,
} from './retention-cli';
import {
  RETENTION_CATEGORIES,
  RETENTION_CATEGORY_NAMES,
} from './retention-policy';
import type { RetentionRunSummary } from './retention';

/**
 * Operator-contract tests for the retention command's argument surface and
 * report (Sprint 25, ORG-PR-015). No database is involved: these lock the
 * safety defaults (`dry-run` unless `--apply`), the rejection of dangerous or
 * malformed flags, and the fact that the printed report contains counts only.
 */

/** A summary shaped like a real run, used to pin the report format. */
function summaryFixture(
  overrides: Partial<RetentionRunSummary> = {},
): RetentionRunSummary {
  return {
    mode: 'apply',
    startedAt: '2026-08-24T10:00:00.000Z',
    durationMs: 42,
    batchSize: 500,
    results: [
      {
        category: 'security_events',
        table: 'security_events',
        retentionColumn: 'created_at',
        retentionDays: 180,
        cutoff: '2026-02-25T10:00:00.000Z',
        eligible: null,
        deleted: 7,
        batches: 1,
        truncated: false,
      },
    ],
    totalDeleted: 7,
    failedCategories: 0,
    ...overrides,
  };
}

describe('parseRetentionArgs', () => {
  it('defaults to dry-run over the whole catalog', () => {
    const args = parseRetentionArgs([]);

    expect(args).toMatchObject({
      kind: 'run',
      mode: 'dry-run',
      batchSize: undefined,
      maxBatchesPerCategory: DEFAULT_MAX_BATCHES_PER_CATEGORY,
      json: false,
    });
    expect(args.kind === 'run' && args.categories).toEqual(RETENTION_CATEGORIES);
  });

  it('requires --apply to select the deleting mode', () => {
    // The safety property: no other flag combination can reach apply mode.
    const neverApplies = [
      [],
      ['--dry-run'],
      ['--json'],
      ['--batch-size=10'],
      ['--category=security_events'],
      ['--max-batches=1'],
    ];
    for (const argv of neverApplies) {
      expect(parseRetentionArgs(argv)).toMatchObject({ mode: 'dry-run' });
    }
    expect(parseRetentionArgs(['--apply'])).toMatchObject({ mode: 'apply' });
  });

  it('rejects --apply together with --dry-run', () => {
    expect(parseRetentionArgs(['--apply', '--dry-run'])).toEqual({
      kind: 'error',
      messages: ['--apply and --dry-run are mutually exclusive'],
    });
  });

  it('selects categories by name, de-duplicated and in catalog order', () => {
    const args = parseRetentionArgs([
      '--category=expired_sessions',
      '--category=security_events',
      '--category=expired_sessions',
    ]);

    expect(args.kind).toBe('run');
    expect(args.kind === 'run' && args.categories.map((c) => c.name)).toEqual([
      // Catalog order, NOT the order the flags were written.
      'security_events',
      'expired_sessions',
    ]);
  });

  it('rejects an unknown category and lists the known ones', () => {
    const args = parseRetentionArgs(['--category=users']);

    expect(args.kind).toBe('error');
    expect(args.kind === 'error' && args.messages[0]).toContain(
      'Unknown --category "users"',
    );
    expect(args.kind === 'error' && args.messages[0]).toContain(
      RETENTION_CATEGORY_NAMES[0],
    );
  });

  it('rejects non-numeric, zero, negative, and over-sized batch sizes', () => {
    for (const raw of ['abc', '0', '-1', '1.5', '', String(RETENTION_MAX_BATCH_SIZE + 1)]) {
      const args = parseRetentionArgs([`--batch-size=${raw}`]);
      expect(args.kind, `--batch-size=${raw} must be rejected`).toBe('error');
    }
    expect(parseRetentionArgs(['--batch-size=250'])).toMatchObject({
      kind: 'run',
      batchSize: 250,
    });
  });

  it('rejects a max-batches value outside the safety bound', () => {
    expect(parseRetentionArgs(['--max-batches=0']).kind).toBe('error');
    expect(
      parseRetentionArgs([`--max-batches=${DEFAULT_MAX_BATCHES_PER_CATEGORY + 1}`]).kind,
    ).toBe('error');
    expect(parseRetentionArgs(['--max-batches=3'])).toMatchObject({
      maxBatchesPerCategory: 3,
    });
  });

  it('ignores a bare -- (pnpm forwards one)', () => {
    expect(parseRetentionArgs(['--', '--apply'])).toMatchObject({
      kind: 'run',
      mode: 'apply',
    });
  });

  it('rejects unknown arguments instead of ignoring them', () => {
    // A silently-ignored `--aply` typo would run a dry-run the operator
    // believed was an apply (or vice versa); both are unacceptable.
    expect(parseRetentionArgs(['--aply'])).toEqual({
      kind: 'error',
      messages: ['Unknown argument "--aply"'],
    });
  });

  it('collects every error in one pass', () => {
    const args = parseRetentionArgs(['--batch-size=x', '--category=nope']);

    expect(args.kind === 'error' && args.messages).toHaveLength(2);
  });

  it('returns help for --help and -h', () => {
    expect(parseRetentionArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseRetentionArgs(['-h', '--apply'])).toEqual({ kind: 'help' });
  });
});

describe('RETENTION_USAGE', () => {
  it('documents every category the catalog defines', () => {
    for (const name of RETENTION_CATEGORY_NAMES) {
      expect(RETENTION_USAGE).toContain(name);
    }
  });
});

describe('formatRetentionSummary', () => {
  it('reports applied deletions per category and a run total', () => {
    const text = formatRetentionSummary(summaryFixture());

    expect(text).toContain('mode=apply');
    expect(text).toContain(
      'applied security_events table=security_events retention_days=180',
    );
    expect(text).toContain('deleted=7 batches=1');
    expect(text).toContain('failed_categories=0');
  });

  it('states plainly that a dry run deleted nothing', () => {
    const text = formatRetentionSummary(
      summaryFixture({
        mode: 'dry-run',
        totalDeleted: 0,
        results: [
          {
            category: 'expired_sessions',
            table: 'sessions',
            retentionColumn: 'expires_at',
            retentionDays: 90,
            cutoff: '2026-05-26T10:00:00.000Z',
            eligible: 12,
            deleted: 0,
            batches: 0,
            truncated: false,
          },
        ],
      }),
    );

    expect(text).toContain('dry-run expired_sessions');
    expect(text).toContain('eligible=12');
    expect(text).toContain('no rows deleted (dry run)');
    expect(text).not.toContain('deleted=12');
  });

  it('flags a truncated category so the operator reruns it', () => {
    const text = formatRetentionSummary(
      summaryFixture({
        results: [
          { ...summaryFixture().results[0]!, truncated: true, deleted: 5000, batches: 10 },
        ],
        totalDeleted: 5000,
      }),
    );

    expect(text).toContain('truncated=true (rerun to continue)');
  });

  it('reports a failed category with its SQLSTATE and no row data', () => {
    const text = formatRetentionSummary(
      summaryFixture({
        failedCategories: 1,
        totalDeleted: 0,
        results: [
          {
            ...summaryFixture().results[0]!,
            deleted: 0,
            batches: 0,
            failure: { code: '42501', message: 'permission denied for table security_events' },
          },
        ],
      }),
    );

    expect(text).toContain('FAILED  security_events');
    expect(text).toContain('code=42501');
    expect(text).toContain('failed_categories=1');
  });
});

describe('retentionExitCode', () => {
  it('is 0 for a clean run and 1 when any category failed', () => {
    expect(retentionExitCode(summaryFixture())).toBe(0);
    expect(retentionExitCode(summaryFixture({ failedCategories: 1 }))).toBe(1);
  });
});
