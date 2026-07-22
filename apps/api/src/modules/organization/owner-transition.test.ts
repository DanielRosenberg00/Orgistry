import { ROLE_IDS } from '@orgistry/db';
import { describe, expect, it } from 'vitest';
import {
  assertOwnerChangeAuthority,
  roleChangeTouchesOwner,
} from './owner-transition';

/**
 * The DG-2 policy predicate and guard in isolation. The full allowed/forbidden
 * transition matrix is proven end-to-end in `member.routes.test.ts` (routes)
 * and `member.integration.test.ts` (live PostgreSQL); this pins the central
 * definition both repositories share.
 */
describe('roleChangeTouchesOwner', () => {
  it('is true when the change GRANTS Owner', () => {
    expect(roleChangeTouchesOwner(ROLE_IDS.member, ROLE_IDS.owner)).toBe(true);
  });

  it('is true when the change REMOVES Owner', () => {
    expect(roleChangeTouchesOwner(ROLE_IDS.owner, ROLE_IDS.admin)).toBe(true);
  });

  it('is true for an Owner->Owner no-op (assigning Owner is Owner-only)', () => {
    expect(roleChangeTouchesOwner(ROLE_IDS.owner, ROLE_IDS.owner)).toBe(true);
  });

  it('is false for transitions among non-Owner roles', () => {
    expect(roleChangeTouchesOwner(ROLE_IDS.member, ROLE_IDS.viewer)).toBe(false);
    expect(roleChangeTouchesOwner(ROLE_IDS.admin, ROLE_IDS.member)).toBe(false);
  });
});

describe('assertOwnerChangeAuthority', () => {
  it('passes for an active Owner actor', () => {
    expect(() => assertOwnerChangeAuthority(true)).not.toThrow();
  });

  it('rejects a non-Owner actor with the standard safe 403', () => {
    expect(() => assertOwnerChangeAuthority(false)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }),
    );
  });
});
