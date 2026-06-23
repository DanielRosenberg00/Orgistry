import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token';

describe('generateOpaqueToken', () => {
  it('produces unique, URL-safe tokens', () => {
    const tokens = new Set(
      Array.from({ length: 1000 }, () => generateOpaqueToken()),
    );
    expect(tokens.size).toBe(1000);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('hashOpaqueToken', () => {
  it('is deterministic and never equals the raw token', () => {
    const raw = generateOpaqueToken();
    const hash = hashOpaqueToken(raw);
    expect(hash).toBe(hashOpaqueToken(raw));
    expect(hash).not.toBe(raw);
    // SHA-256 hex digest length.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps different tokens to different hashes', () => {
    expect(hashOpaqueToken(generateOpaqueToken())).not.toBe(
      hashOpaqueToken(generateOpaqueToken()),
    );
  });
});
