import { loadConfig } from '@orgistry/config';
import { describe, expect, it } from 'vitest';
import {
  RETENTION_CATEGORIES,
  RETENTION_CATEGORY_NAMES,
  findRetentionCategory,
  retentionCutoff,
} from './retention-policy';

/**
 * Catalog invariants for the retention policy (Sprint 25, ORG-PR-015).
 *
 * These are the guarantees a reviewer should be able to trust WITHOUT reading
 * every predicate: the catalog covers exactly the declared categories, it
 * never names a durable table, cutoffs are derived from configuration, and
 * the ordering that keeps the foreign-key-dependent sweep correct is stable.
 */

/** Minimum environment for `loadConfig` — no secret files, no production guard. */
function envWith(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/orgistry',
    JWT_SECRET: 'unit-test-jwt-secret-value',
    ...overrides,
  };
}

describe('retention catalog', () => {
  it('exposes exactly the declared category names, in a stable order', () => {
    expect(RETENTION_CATEGORIES.map((category) => category.name)).toEqual([
      ...RETENTION_CATEGORY_NAMES,
    ]);
  });

  it('deletes refresh tokens before sessions', () => {
    // `refresh_tokens.session_id` is a foreign key: sweeping the children
    // first keeps the parent sweep from doing the bulk of the child deletes.
    const names = RETENTION_CATEGORIES.map((category) => category.name);
    expect(names.indexOf('expired_refresh_tokens')).toBeLessThan(
      names.indexOf('expired_sessions'),
    );
  });

  it('never targets a table the schema declares durable', () => {
    // invitations / api_keys are append-only lifecycle records; users,
    // organizations, memberships, and projects are account and tenant state.
    const durableTables = [
      'invitations',
      'api_keys',
      'users',
      'organizations',
      'memberships',
      'projects',
      'plans',
      'organization_plans',
      'roles',
      'permissions',
      'role_permissions',
      'app_meta',
    ];
    for (const category of RETENTION_CATEGORIES) {
      expect(durableTables).not.toContain(category.table);
    }
  });

  it('applies the cutoff to a timestamp column, never to a status field', () => {
    for (const category of RETENTION_CATEGORIES) {
      expect(['created_at', 'expires_at']).toContain(category.retentionColumn);
      expect(category.supportingIndex).toMatch(/^ix_/);
    }
  });

  it('gives sessions and refresh tokens the SAME window', () => {
    // `expired_sessions` holds a session back until every refresh token in its
    // family is past the SESSION's cutoff. That is only equivalent to "every
    // child is independently eligible" while both categories read the same
    // configured window. If they ever diverge, the hold-back predicate must be
    // revisited before this test is changed.
    const { retention } = loadConfig(envWith({ RETENTION_ENDED_SESSION_DAYS: '45' }));

    expect(findRetentionCategory('expired_sessions')!.windowDays(retention)).toBe(
      findRetentionCategory('expired_refresh_tokens')!.windowDays(retention),
    );
  });

  it('resolves each category to a positive configured window', () => {
    const { retention } = loadConfig(envWith());
    for (const category of RETENTION_CATEGORIES) {
      expect(category.windowDays(retention)).toBeGreaterThan(0);
    }
  });

  it('finds a category by name and rejects an unknown one', () => {
    expect(findRetentionCategory('security_events')?.table).toBe('security_events');
    expect(findRetentionCategory('invitations')).toBeUndefined();
  });
});

describe('retentionCutoff', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');

  it('subtracts the configured window from the supplied instant', () => {
    const { retention } = loadConfig(
      envWith({ RETENTION_SECURITY_EVENT_DAYS: '30' }),
    );
    const securityEvents = findRetentionCategory('security_events');

    expect(retentionCutoff(securityEvents!, retention, now).toISOString()).toBe(
      '2026-07-25T12:00:00.000Z',
    );
  });

  it('moves the cutoff further into the past as the window grows', () => {
    const shortWindow = loadConfig(
      envWith({ RETENTION_ENDED_SESSION_DAYS: '7' }),
    ).retention;
    const longWindow = loadConfig(
      envWith({ RETENTION_ENDED_SESSION_DAYS: '365' }),
    ).retention;
    const sessions = findRetentionCategory('expired_sessions')!;

    expect(retentionCutoff(sessions, longWindow, now).getTime()).toBeLessThan(
      retentionCutoff(sessions, shortWindow, now).getTime(),
    );
  });
});
