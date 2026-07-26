import { describe, expect, it } from 'vitest';
import {
  assertUniformAlphabet,
  randomAlphabetString,
} from './random-alphabet';

/**
 * Uniform alphabet sampling (Sprint 22).
 *
 * These are deterministic tests of the PRECONDITION that makes byte-modulo
 * sampling unbiased — not statistical tests of the output distribution, which
 * would be flaky by construction. The guarantee is arithmetic: when the
 * alphabet length divides 256, every character is the image of exactly
 * 256 / length byte values, so uniform bytes produce uniform characters.
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('assertUniformAlphabet', () => {
  it('accepts the Crockford base32 alphabet used for ids and API key display ids', () => {
    expect(CROCKFORD_BASE32).toHaveLength(32);
    expect(256 % CROCKFORD_BASE32.length).toBe(0);
    expect(() => assertUniformAlphabet(CROCKFORD_BASE32, 'test')).not.toThrow();
  });

  it('accepts every alphabet length that divides the byte domain', () => {
    for (const length of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
      const alphabet = 'x'.repeat(length);
      expect(() => assertUniformAlphabet(alphabet, 'test')).not.toThrow();
    }
  });

  it('rejects a length that would bias modulo reduction', () => {
    // 30 and 31 are the realistic regressions: dropping or adding a character
    // to a base32 alphabet.
    for (const length of [3, 30, 31, 33, 62]) {
      const alphabet = 'x'.repeat(length);
      expect(() => assertUniformAlphabet(alphabet, 'test')).toThrow(
        /does not divide 256/,
      );
    }
  });

  it('rejects an empty alphabet', () => {
    expect(() => assertUniformAlphabet('', 'test')).toThrow(/does not divide 256/);
  });

  it('names the offending alphabet so a failure is actionable', () => {
    expect(() => assertUniformAlphabet('abc', 'my-alphabet')).toThrow(
      /^my-alphabet: alphabet length 3/,
    );
  });
});

describe('randomAlphabetString', () => {
  it('returns the requested length', () => {
    for (const length of [0, 1, 8, 26, 64]) {
      expect(randomAlphabetString(CROCKFORD_BASE32, length)).toHaveLength(length);
    }
  });

  it('draws only from the supplied alphabet', () => {
    const allowed = new Set(CROCKFORD_BASE32);
    const generated = randomAlphabetString(CROCKFORD_BASE32, 512);
    for (const character of generated) {
      expect(allowed.has(character)).toBe(true);
    }
  });

  it('does not repeat a fixed value across calls', () => {
    // A guard against an accidental constant/seeded implementation. With a
    // 32-character alphabet and 26 characters this collides with probability
    // 32^-26, which is not a flake risk.
    const first = randomAlphabetString(CROCKFORD_BASE32, 26);
    const second = randomAlphabetString(CROCKFORD_BASE32, 26);
    expect(first).not.toBe(second);
  });
});
