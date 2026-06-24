import {
  DEFAULT_PLAN_KEY,
  PLAN_CATALOG,
  PLAN_KEYS,
  PLAN_KEY_LIST,
  planKeySchema,
} from '@orgistry/contracts';
import { describe, expect, it } from 'vitest';
import { PLAN_SEED, planRowId } from './plans';

/**
 * Drift guard (no database required).
 *
 * The fixed internal demo plan catalog lives in `@orgistry/contracts`
 * (colocated with the public DTOs, mirroring the Sprint 5 `PERMISSION_CATALOG`
 * precedent — see the package-boundary note in
 * `docs/entitlements-plans-quotas.md`). `@orgistry/db` DERIVES its `plans` seed
 * rows from it. These assertions prove the two cannot silently diverge — if the
 * catalog changes without the seed (or vice versa), this fails in the plain
 * `pnpm test` run, before any migration. The DB-backed `migrate.integration.test`
 * then proves the migration SQL matches these same seed constants.
 */
describe('plan seed derives from the contracts catalog', () => {
  it('PLAN_SEED covers exactly the catalog, with stable derived ids and values', () => {
    expect(PLAN_SEED).toHaveLength(PLAN_KEY_LIST.length);
    for (const key of PLAN_KEY_LIST) {
      const entry = PLAN_CATALOG[key];
      const seeded = PLAN_SEED.find((p) => p.key === key);
      expect(seeded, `seed missing ${key}`).toBeDefined();
      expect(seeded?.id).toBe(planRowId(key));
      expect(seeded?.name).toBe(entry.name);
      expect(seeded?.description).toBe(entry.description);
      // Every entitlement column equals the catalog value (no drift).
      expect(seeded?.maxMembers).toBe(entry.entitlements.max_members);
      expect(seeded?.maxProjects).toBe(entry.entitlements.max_projects);
      expect(seeded?.apiKeysAccess).toBe(entry.entitlements.api_keys_access);
      expect(seeded?.maxApiKeys).toBe(entry.entitlements.max_api_keys);
      expect(seeded?.auditLogAccess).toBe(entry.entitlements.audit_log_access);
      expect(seeded?.auditRetentionDays).toBe(
        entry.entitlements.audit_retention_days,
      );
    }
  });

  it('plan keys agree between the PLAN_KEYS constant and the planKeySchema enum', () => {
    expect(Object.values(PLAN_KEYS).sort()).toEqual(
      [...planKeySchema.options].sort(),
    );
    expect(PLAN_KEY_LIST.length).toBe(planKeySchema.options.length);
  });

  it('the default plan key is part of the catalog', () => {
    expect(PLAN_CATALOG[DEFAULT_PLAN_KEY]).toBeDefined();
    expect(DEFAULT_PLAN_KEY).toBe(PLAN_KEYS.free);
  });
});
