import { describe, expect, it } from 'vitest';
import { redactAuthorizationHeader, redactSecret } from './redaction';

describe('redactSecret', () => {
  it('masks a non-empty secret without revealing its length', () => {
    expect(redactSecret('super-secret-value')).toBe('[REDACTED]');
    expect(redactSecret('x')).toBe('[REDACTED]');
  });

  it('returns an empty string for empty/null/undefined', () => {
    expect(redactSecret('')).toBe('');
    expect(redactSecret(null)).toBe('');
    expect(redactSecret(undefined)).toBe('');
  });
});

describe('redactAuthorizationHeader', () => {
  it('keeps the scheme but masks the credential', () => {
    expect(redactAuthorizationHeader('Bearer eyJhbGciOi.payload.sig')).toBe(
      'Bearer [REDACTED]',
    );
  });

  it('fully masks a header with no scheme', () => {
    expect(redactAuthorizationHeader('rawtokenwithnoscheme')).toBe('[REDACTED]');
  });
});
