import { PLAN_CATALOG } from '@orgistry/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  evaluateCountQuota,
  requireEntitlement,
  requireQuota,
} from './quota';

/**
 * Pure quota/entitlement POLICY primitives. No IO — these decide allowed vs
 * exceeded vs not-entitled from already-resolved values and counts. They are the
 * layer that keeps permission (RBAC) separate from entitlement/quota.
 */

describe('evaluateCountQuota', () => {
  it('allows when current usage is below the limit', () => {
    expect(evaluateCountQuota(2, 3)).toEqual({
      status: 'allowed',
      limit: 3,
      current: 2,
    });
  });

  it('exceeds when current usage equals the limit (the next unit would not fit)', () => {
    expect(evaluateCountQuota(3, 3)).toEqual({
      status: 'exceeded',
      limit: 3,
      current: 3,
    });
  });

  it('exceeds when current usage is above the limit', () => {
    expect(evaluateCountQuota(4, 3).status).toBe('exceeded');
  });

  it('treats a zero limit as immediately exceeded (capability unavailable)', () => {
    expect(evaluateCountQuota(0, 0).status).toBe('exceeded');
  });
});

describe('requireQuota', () => {
  it('is a no-op when the evaluation is allowed', () => {
    expect(() =>
      requireQuota('max_projects', evaluateCountQuota(1, 3)),
    ).not.toThrow();
  });

  it('throws QUOTA_EXCEEDED with the quota key, limit, and current usage', () => {
    try {
      requireQuota('max_projects', evaluateCountQuota(3, 3));
      throw new Error('expected requireQuota to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('QUOTA_EXCEEDED');
      expect(appError.statusCode).toBe(409);
      expect(appError.details).toEqual({
        quota: 'max_projects',
        limit: 3,
        current: 3,
      });
    }
  });
});

describe('requireEntitlement', () => {
  it('is a no-op when the plan grants the feature', () => {
    expect(() =>
      requireEntitlement(PLAN_CATALOG.pro.entitlements, 'api_keys_access'),
    ).not.toThrow();
  });

  it('throws ENTITLEMENT_REQUIRED naming the missing feature', () => {
    try {
      requireEntitlement(PLAN_CATALOG.free.entitlements, 'api_keys_access');
      throw new Error('expected requireEntitlement to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('ENTITLEMENT_REQUIRED');
      expect(appError.statusCode).toBe(403);
      expect(appError.details).toEqual({ entitlement: 'api_keys_access' });
    }
  });
});
