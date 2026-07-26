import { describe, expect, it } from 'vitest';
import { requireRow } from './db-rows';
import { requireDefined } from './invariant';

describe('requireDefined', () => {
  it('returns the value when defined (including falsy values)', () => {
    expect(requireDefined('x', 'label')).toBe('x');
    expect(requireDefined(0, 'label')).toBe(0);
    expect(requireDefined(null, 'label')).toBeNull();
  });

  it('throws naming the violated invariant when undefined', () => {
    expect(() => requireDefined(undefined, 'matrix entry for role owner')).toThrow(
      "Expected matrix entry for role owner to be defined",
    );
  });
});

describe('requireRow', () => {
  it('returns the first row when present', () => {
    expect(requireRow([{ id: 'a' }, { id: 'b' }], 'ctx')).toEqual({ id: 'a' });
  });

  it('throws with the query context when the guaranteed row is missing', () => {
    expect(() => requireRow([], 'users insert')).toThrow(
      'Expected a row from users insert, got none',
    );
  });
});
