import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });

  it('treats case-different addresses as the same normalized value', () => {
    expect(normalizeEmail('Alice@Example.com')).toBe(
      normalizeEmail('alice@example.com'),
    );
  });

  it('does not strip dots or plus tags (avoids over-merging accounts)', () => {
    expect(normalizeEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
  });
});
