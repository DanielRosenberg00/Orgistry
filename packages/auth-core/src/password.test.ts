import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('hashPassword / verifyPassword', () => {
  it('produces an Argon2id hash that is not the raw password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'wrong password value!')).toBe(false);
  });

  it('salts: identical passwords yield different hashes', async () => {
    const a = await hashPassword('same-password-value');
    const b = await hashPassword('same-password-value');
    expect(a).not.toBe(b);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-real-hash', 'whatever')).toBe(false);
  });
});
