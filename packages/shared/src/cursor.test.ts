import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor encoding', () => {
  it('round-trips a payload through an opaque token', () => {
    const payload = { id: 'org_123', createdAt: 1700000000000 };
    const cursor = encodeCursor(payload);

    // Opaque to clients: not the raw JSON.
    expect(cursor).not.toContain('org_123');
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it('returns null for a malformed cursor instead of throwing', () => {
    expect(decodeCursor('!!!not-base64-json!!!')).toBeNull();
  });
});
