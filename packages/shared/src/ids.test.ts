import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  createId,
  isValidId,
  isValidPrefix,
  parseId,
} from './ids';

const ALL_PREFIXES = Object.values(ID_PREFIXES);

describe('createId', () => {
  it('generates an id for every supported v1 prefix', () => {
    for (const prefix of ALL_PREFIXES) {
      const id = createId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(parseId(id)?.prefix).toBe(prefix);
    }
  });

  it('does not expose numeric or sequential identifiers', () => {
    const id = createId('user');
    const random = id.slice('user_'.length);
    // Random suffix must not be a plain number.
    expect(Number.isNaN(Number(random))).toBe(true);
  });

  it('produces unique ids across many generations', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId('org')));
    expect(ids.size).toBe(1000);
  });

  it('throws for an unknown prefix', () => {
    // @ts-expect-error intentionally passing an unsupported prefix
    expect(() => createId('bogus')).toThrow(/Unknown ID prefix/);
  });
});

describe('isValidPrefix', () => {
  it('accepts registered prefixes and rejects others', () => {
    expect(isValidPrefix('user')).toBe(true);
    expect(isValidPrefix('rtok')).toBe(true);
    expect(isValidPrefix('account')).toBe(false);
  });
});

describe('parseId / isValidId', () => {
  it('parses a well-formed id', () => {
    const parsed = parseId('prj_ABC123');
    expect(parsed).toEqual({ prefix: 'prj', random: 'ABC123' });
  });

  it('rejects malformed ids', () => {
    expect(parseId('no-separator')).toBeNull();
    expect(parseId('_leadingsep')).toBeNull();
    expect(parseId('unknown_xyz')).toBeNull();
    expect(parseId('user_')).toBeNull();
  });

  it('checks an expected prefix when provided', () => {
    const id = createId('key');
    expect(isValidId(id, 'key')).toBe(true);
    expect(isValidId(id, 'user')).toBe(false);
    expect(isValidId(id)).toBe(true);
  });
});
