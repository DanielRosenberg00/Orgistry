import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import { assertLocalTarget } from './lib/demo-target-guard.mjs';

/**
 * The demo seed prints a one-time API key secret to stdout — the credential's
 * only delivery channel. These tests pin the compensating control: the tool
 * must refuse to run anywhere but loopback, so that print can never happen
 * against a shared or hosted environment (Sprint 22, ORG-PR-056).
 */

describe('assertLocalTarget', () => {
  it('accepts the loopback hosts the local stack actually uses', () => {
    for (const url of [
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'https://localhost:3000',
    ]) {
      expect(() => assertLocalTarget(url)).not.toThrow();
    }
  });

  it('refuses a hosted target', () => {
    for (const url of [
      'https://api.orgistry.example.com',
      'https://staging.internal:3000',
      'http://10.0.0.5:3000',
    ]) {
      expect(() => assertLocalTarget(url)).toThrow(/non-loopback API/);
    }
  });

  it('is not fooled by a hostname that merely starts with a loopback name', () => {
    // A prefix or substring check would wave these through; hostname equality
    // does not.
    expect(() => assertLocalTarget('http://localhost.evil.example.com')).toThrow(
      /non-loopback API/,
    );
    expect(() => assertLocalTarget('http://127.0.0.1.evil.example.com')).toThrow(
      /non-loopback API/,
    );
  });

  it('names the rejected host so the failure is self-explanatory', () => {
    expect(() => assertLocalTarget('https://api.example.com')).toThrow(
      /\(api\.example\.com\)/,
    );
  });

  it('rejects a malformed target rather than passing it through', () => {
    expect(() => assertLocalTarget('not a url')).toThrow(/not a valid URL/);
    expect(() => assertLocalTarget('')).toThrow(/not a valid URL/);
  });
});
