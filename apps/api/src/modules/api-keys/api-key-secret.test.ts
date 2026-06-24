import { describe, expect, it } from 'vitest';
import {
  generateApiKeySecret,
  hashApiKeySecret,
  parseApiKey,
} from './api-key-secret';

describe('generateApiKeySecret', () => {
  it('produces the orgistry_<displayId>_<secret> format', () => {
    const generated = generateApiKeySecret();
    expect(generated.raw.startsWith('orgistry_')).toBe(true);
    expect(generated.raw.split('_').length).toBeGreaterThanOrEqual(3);
    // The display prefix is the recognizable, non-secret part.
    expect(generated.displayPrefix.startsWith('orgistry_')).toBe(true);
    expect(generated.raw.startsWith(`${generated.displayPrefix}_`)).toBe(true);
  });

  it('returns a hash that is NOT the raw key and not the secret component', () => {
    const generated = generateApiKeySecret();
    expect(generated.secretHash).not.toContain(generated.raw);
    expect(generated.raw).not.toContain(generated.secretHash);
    // SHA-256 hex is 64 chars.
    expect(generated.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is high-entropy: no two generated keys collide', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { raw, secretHash } = generateApiKeySecret();
      expect(seen.has(raw)).toBe(false);
      expect(seen.has(secretHash)).toBe(false);
      seen.add(raw);
      seen.add(secretHash);
    }
  });

  it('hashes deterministically and matches the secret component of the raw key', () => {
    const generated = generateApiKeySecret();
    const parsed = parseApiKey(generated.raw);
    expect(parsed).not.toBeNull();
    expect(hashApiKeySecret(parsed!.secretComponent)).toBe(generated.secretHash);
  });
});

describe('parseApiKey', () => {
  it('round-trips a generated key', () => {
    const generated = generateApiKeySecret();
    const parsed = parseApiKey(generated.raw);
    expect(parsed?.displayPrefix).toBe(generated.displayPrefix);
    expect(parsed?.secretComponent.length).toBeGreaterThan(0);
  });

  it('returns null for malformed input (no throw)', () => {
    expect(parseApiKey(null)).toBeNull();
    expect(parseApiKey(undefined)).toBeNull();
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('orgistry_')).toBeNull();
    expect(parseApiKey('orgistry_onlydisplay')).toBeNull();
    expect(parseApiKey('wrongscheme_abc_def')).toBeNull();
    // A browser JWT is not an API key.
    expect(parseApiKey('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBeNull();
  });

  it('preserves a secret component that itself contains underscores (base64url)', () => {
    const parsed = parseApiKey('orgistry_ABCD1234_sec_ret_with_unders');
    expect(parsed?.displayPrefix).toBe('orgistry_ABCD1234');
    expect(parsed?.secretComponent).toBe('sec_ret_with_unders');
  });
});
