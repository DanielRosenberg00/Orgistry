import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_KEY,
  ENTITLEMENT_KEYS,
  PLAN_CATALOG,
  PLAN_KEYS,
  PLAN_KEY_LIST,
  demoPlanChangeRequestSchema,
  entitlementsForPlan,
  entitlementsResponseSchema,
  entitlementValuesSchema,
  organizationPlanResponseSchema,
  planSchema,
  quotaErrorDetailsSchema,
} from './plans';

describe('plan catalog', () => {
  it('contains exactly Free, Pro, and Business', () => {
    expect(PLAN_KEY_LIST).toEqual(['free', 'pro', 'business']);
    expect(Object.keys(PLAN_CATALOG).sort()).toEqual(
      ['business', 'free', 'pro'].sort(),
    );
  });

  it('defaults new organizations to Free', () => {
    expect(DEFAULT_PLAN_KEY).toBe(PLAN_KEYS.free);
  });

  it('every catalog entry has the full, typed entitlement value set', () => {
    for (const key of PLAN_KEY_LIST) {
      const entry = PLAN_CATALOG[key];
      expect(entry.key).toBe(key);
      expect(entitlementValuesSchema.safeParse(entry.entitlements).success).toBe(
        true,
      );
    }
  });

  it('progresses deterministically Free < Pro < Business on numeric quotas', () => {
    const free = PLAN_CATALOG.free.entitlements;
    const pro = PLAN_CATALOG.pro.entitlements;
    const business = PLAN_CATALOG.business.entitlements;
    expect(free.max_members).toBeLessThan(pro.max_members);
    expect(pro.max_members).toBeLessThan(business.max_members);
    expect(free.max_projects).toBeLessThan(pro.max_projects);
    expect(pro.max_projects).toBeLessThan(business.max_projects);
  });

  it('unlocks premium feature access at Pro and above only', () => {
    expect(PLAN_CATALOG.free.entitlements.api_keys_access).toBe(false);
    expect(PLAN_CATALOG.free.entitlements.audit_log_access).toBe(false);
    expect(PLAN_CATALOG.pro.entitlements.api_keys_access).toBe(true);
    expect(PLAN_CATALOG.business.entitlements.audit_log_access).toBe(true);
  });

  it('resolves entitlement values for each plan via entitlementsForPlan', () => {
    expect(entitlementsForPlan('free')).toEqual(PLAN_CATALOG.free.entitlements);
    expect(entitlementsForPlan('business')).toEqual(
      PLAN_CATALOG.business.entitlements,
    );
  });
});

describe('entitlement keys', () => {
  it('exposes the six fixed entitlement/quota keys as snake_case strings', () => {
    expect(Object.values(ENTITLEMENT_KEYS).sort()).toEqual(
      [
        'api_keys_access',
        'audit_log_access',
        'audit_retention_days',
        'max_api_keys',
        'max_members',
        'max_projects',
      ].sort(),
    );
  });

  it('uses the entitlement keys as the entitlement-values object keys', () => {
    expect(Object.keys(entitlementValuesSchema.shape).sort()).toEqual(
      Object.values(ENTITLEMENT_KEYS).sort(),
    );
  });
});

describe('plan DTOs', () => {
  it('the public Plan DTO carries key/name/description only (no raw entitlement columns)', () => {
    expect(Object.keys(planSchema.shape).sort()).toEqual(
      ['description', 'key', 'name'].sort(),
    );
  });

  it('accepts a well-formed organization plan response', () => {
    expect(
      organizationPlanResponseSchema.safeParse({
        organizationId: 'org_1',
        plan: { key: 'pro', name: 'Pro', description: 'x' },
        assignedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('accepts a well-formed entitlements response', () => {
    expect(
      entitlementsResponseSchema.safeParse({
        organizationId: 'org_1',
        planKey: 'business',
        entitlements: PLAN_CATALOG.business.entitlements,
      }).success,
    ).toBe(true);
  });
});

describe('demoPlanChangeRequestSchema', () => {
  it('accepts a fixed plan key', () => {
    expect(demoPlanChangeRequestSchema.safeParse({ planKey: 'pro' }).success).toBe(
      true,
    );
  });

  it('rejects an unknown plan key', () => {
    expect(
      demoPlanChangeRequestSchema.safeParse({ planKey: 'enterprise' }).success,
    ).toBe(false);
  });

  it('rejects a client-supplied entitlements override (no client-controlled values)', () => {
    const parsed = demoPlanChangeRequestSchema.parse({
      planKey: 'free',
      entitlements: { max_projects: 9999 },
    });
    expect(parsed).toEqual({ planKey: 'free' });
    expect('entitlements' in parsed).toBe(false);
  });
});

describe('quotaErrorDetailsSchema', () => {
  it('describes the exhausted quota with limit and current usage', () => {
    expect(
      quotaErrorDetailsSchema.safeParse({
        quota: 'max_projects',
        limit: 3,
        current: 3,
      }).success,
    ).toBe(true);
  });
});
