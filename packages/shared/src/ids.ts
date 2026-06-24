import { randomBytes } from 'node:crypto';

/**
 * Prefixed public identifiers.
 *
 * Every externally-visible entity gets an opaque ID of the form
 * `<prefix>_<random>`. The prefix names the entity type (Stripe-style); the
 * random suffix is Crockford base32 with no numeric, sequential, or
 * database-internal information. This keeps internal numeric/serial keys
 * private and makes IDs self-describing in logs and URLs.
 *
 * The prefix registry below is the complete v1 set. Generating an ID for an
 * unknown prefix is a programming error and throws.
 */

export const ID_PREFIXES = {
  user: 'user',
  org: 'org',
  mem: 'mem',
  role: 'role',
  perm: 'perm',
  inv: 'inv',
  prj: 'prj',
  // Organization plan state (Sprint 7). The plan catalog rows use stable
  // human-readable ids (`plan_free`, …) and are never generated via createId.
  oplan: 'oplan',
  key: 'key',
  sess: 'sess',
  rtok: 'rtok',
  evtok: 'evtok',
  evt: 'evt',
  sevt: 'sevt',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const PREFIX_SET = new Set<string>(Object.values(ID_PREFIXES));

// Crockford base32 alphabet: no I, L, O, U to avoid ambiguity.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_RANDOM_LENGTH = 26;

function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // Map each byte into the 32-char alphabet. Uniform enough for opaque IDs.
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** True when `prefix` is part of the supported v1 registry. */
export function isValidPrefix(prefix: string): prefix is IdPrefix {
  return PREFIX_SET.has(prefix);
}

/**
 * Generate a prefixed public ID, e.g. `createId('user')` -> `user_3F9...`.
 * Throws if the prefix is not in the registry.
 */
export function createId(prefix: IdPrefix, randomLength = DEFAULT_RANDOM_LENGTH): string {
  if (!isValidPrefix(prefix)) {
    throw new Error(`Unknown ID prefix: "${prefix}"`);
  }
  return `${prefix}_${randomBase32(randomLength)}`;
}

/** Parse an ID into its prefix and random parts, or null if it is malformed. */
export function parseId(
  id: string,
): { prefix: IdPrefix; random: string } | null {
  const separator = id.indexOf('_');
  if (separator <= 0) {
    return null;
  }
  const prefix = id.slice(0, separator);
  const random = id.slice(separator + 1);
  if (!isValidPrefix(prefix) || random.length === 0) {
    return null;
  }
  return { prefix, random };
}

/** True when `id` is well-formed and (optionally) of the expected prefix. */
export function isValidId(id: string, expectedPrefix?: IdPrefix): boolean {
  const parsed = parseId(id);
  if (parsed === null) {
    return false;
  }
  return expectedPrefix === undefined || parsed.prefix === expectedPrefix;
}
