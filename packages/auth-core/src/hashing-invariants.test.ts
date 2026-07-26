import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token';

/**
 * The password/token hashing boundary (Sprint 22).
 *
 * `password.test.ts` and `opaque-token.test.ts` each prove their own
 * primitive. This file proves the invariant BETWEEN them, which is what the
 * security model actually promises and what CodeQL's
 * `js/insufficient-password-hash` alerts turn on:
 *
 *   human-selected password        -> Argon2id, always, with no fast-hash path
 *   server-generated opaque token  -> SHA-256 lookup digest
 *
 * The distinction is entropy, not habit. A password is chosen by a person and
 * must survive offline brute force, so it needs a deliberately slow, salted
 * KDF. An opaque token is 32 CSPRNG bytes — 256 bits, unguessable by
 * construction — so the only threat is an exfiltrated database being replayed,
 * which a one-way digest already defeats. A fast hash there buys constant-cost
 * indexed lookups at no security cost; a slow hash on a password is the whole
 * defense.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ARGON2ID_PREFIX = '$argon2id$';

describe('password hashing is Argon2id-only', () => {
  it('emits an Argon2id encoded hash, never a bare digest', async () => {
    const stored = await hashPassword('a-strong-password-123');
    expect(stored.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(SHA256_HEX.test(stored)).toBe(false);
  });

  it('never produces the SHA-256 digest of the password', async () => {
    const password = 'a-strong-password-123';
    const sha256 = createHash('sha256').update(password).digest('hex');
    const stored = await hashPassword(password);
    expect(stored).not.toBe(sha256);
    expect(stored).not.toContain(sha256);
  });

  it('does not accept a SHA-256 digest as a stored password hash', async () => {
    // If any fast-hash verification path existed, this would pass. It must not:
    // a SHA-256 digest is not a credential this system can verify against.
    const password = 'a-strong-password-123';
    const sha256 = createHash('sha256').update(password).digest('hex');
    expect(await verifyPassword(sha256, password)).toBe(false);
  });

  it('salts, so the same password never yields a deterministic lookup key', async () => {
    // The property that makes password hashes unusable as lookup keys — and
    // token digests usable as them.
    const [first, second] = await Promise.all([
      hashPassword('a-strong-password-123'),
      hashPassword('a-strong-password-123'),
    ]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, 'a-strong-password-123')).toBe(true);
    expect(await verifyPassword(second, 'a-strong-password-123')).toBe(true);
  });
});

describe('opaque token hashing is a SHA-256 lookup digest', () => {
  it('carries enough entropy that a fast hash is appropriate', () => {
    // 32 bytes of CSPRNG output -> 43 base64url characters, 256 bits. This is
    // the premise of the whole argument: there is nothing to brute-force.
    const token = generateOpaqueToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a deterministic SHA-256 digest, not an Argon2 hash', () => {
    const token = generateOpaqueToken();
    const digest = hashOpaqueToken(token);
    expect(digest).toMatch(SHA256_HEX);
    expect(digest.startsWith(ARGON2ID_PREFIX)).toBe(false);
    // Determinism is required: the digest IS the unique-index lookup value.
    expect(hashOpaqueToken(token)).toBe(digest);
  });

  it('never round-trips to the raw token', () => {
    const token = generateOpaqueToken();
    const digest = hashOpaqueToken(token);
    expect(digest).not.toBe(token);
    expect(digest).not.toContain(token);
  });

  it('separates the two families: a token digest is not a password hash', () => {
    // A shape assertion a reviewer can rely on when auditing storage columns:
    // anything matching SHA256_HEX is a token digest, anything starting with
    // the Argon2id prefix is a credential. The sets are disjoint.
    const digest = hashOpaqueToken(generateOpaqueToken());
    expect(SHA256_HEX.test(digest)).toBe(true);
    expect(digest.startsWith(ARGON2ID_PREFIX)).toBe(false);
  });
});
