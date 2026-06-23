import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with Argon2id.
 *
 * Argon2id is the only algorithm used: it resists both GPU and side-channel
 * attacks. bcrypt and plain SHA hashing are intentionally NOT used. The
 * parameters below follow current OWASP guidance for interactive logins; they
 * are encoded into the hash string, so increasing them later does not break
 * verification of existing hashes.
 */
// `@node-rs/argon2` exposes `Algorithm` as an ambient const enum, which
// `isolatedModules` forbids importing. `Algorithm.Argon2id` is value 2.
const ALGORITHM_ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  // ~19 MiB memory, 2 passes, 1 lane. Balanced for server-side auth.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a plaintext password into an encoded Argon2id string for storage. */
export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored Argon2id hash.
 *
 * Returns `false` (never throws) when the hash is malformed or the password
 * does not match, so callers can treat any failure as a generic credential
 * rejection without branching on error types.
 */
export async function verifyPassword(
  storedHash: string,
  plainPassword: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plainPassword);
  } catch {
    return false;
  }
}
