import { createHash, randomBytes } from 'node:crypto';

/**
 * API key secret format & hashing.
 *
 * A raw API key has the stable shape:
 *
 *   orgistry_<displayId>_<secret>
 *
 *  - `orgistry`  — a fixed, recognizable scheme prefix;
 *  - `<displayId>` — a short, high-entropy, NON-secret identifier. It is stored
 *    (as part of `display_prefix`) and is safe to show in lists/logs;
 *  - `<secret>`  — the high-entropy secret component. Only its SHA-256 hash is
 *    stored; the raw value is shown once and is unrecoverable afterwards.
 *
 * Why SHA-256 (not Argon2): the secret component is already high-entropy random
 * data, so the threat model is exfiltrated-database lookup, not offline brute
 * force. A fast one-way hash gives constant-cost, indexable, deterministic
 * lookups while keeping the raw secret unrecoverable — identical reasoning to
 * the opaque refresh-token hashing.
 *
 * Parsing is total and safe: any input that does not match the format yields
 * `null` (never a throw), so a malformed credential is rejected cleanly without
 * leaking which part was wrong.
 */

const SCHEME = 'orgistry';
const SEPARATOR = '_';

// Crockford base32 (no I, L, O, U) for the display id — unambiguous, no
// separator character, safe to print.
const DISPLAY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DISPLAY_ID_LENGTH = 8;
const SECRET_BYTES = 32;

function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += DISPLAY_ALPHABET[bytes[i] % DISPLAY_ALPHABET.length];
  }
  return out;
}

/** The result of generating a new key: the parts a caller needs, no more. */
export interface GeneratedApiKey {
  /** The full raw key (`orgistry_<displayId>_<secret>`). Returned to the client ONCE. */
  raw: string;
  /** The display-safe prefix (`orgistry_<displayId>`). Stored and shown; never secret. */
  displayPrefix: string;
  /** Deterministic hash of the secret component. The only persisted form. */
  secretHash: string;
}

/** Hash a secret component for storage/lookup (SHA-256, hex). Deterministic. */
export function hashApiKeySecret(secretComponent: string): string {
  return createHash('sha256').update(secretComponent).digest('hex');
}

/** Generate a new API key: raw value (shown once), display prefix, secret hash. */
export function generateApiKeySecret(): GeneratedApiKey {
  const displayId = randomBase32(DISPLAY_ID_LENGTH);
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const displayPrefix = `${SCHEME}${SEPARATOR}${displayId}`;
  return {
    raw: `${displayPrefix}${SEPARATOR}${secret}`,
    displayPrefix,
    secretHash: hashApiKeySecret(secret),
  };
}

/** The parts recovered from a well-formed raw key. */
export interface ParsedApiKey {
  /** The display-safe prefix (`orgistry_<displayId>`). */
  displayPrefix: string;
  /** The secret component (hash THIS to look the key up). */
  secretComponent: string;
}

/**
 * Parse a raw API key into its display prefix and secret component, or return
 * `null` for ANY malformed input (missing, wrong scheme, missing parts, empty
 * display id or secret). Total and side-effect-free — callers map `null` to a
 * uniform unauthorized without leaking the reason.
 */
export function parseApiKey(raw: string | null | undefined): ParsedApiKey | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const schemePrefix = `${SCHEME}${SEPARATOR}`;
  if (!raw.startsWith(schemePrefix)) {
    return null;
  }
  // Everything after `orgistry_`: `<displayId>_<secret>`. The secret may itself
  // contain `_` (base64url), so split only on the FIRST separator.
  const remainder = raw.slice(schemePrefix.length);
  const separatorIndex = remainder.indexOf(SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const displayId = remainder.slice(0, separatorIndex);
  const secretComponent = remainder.slice(separatorIndex + 1);
  if (displayId.length === 0 || secretComponent.length === 0) {
    return null;
  }
  return {
    displayPrefix: `${SCHEME}${SEPARATOR}${displayId}`,
    secretComponent,
  };
}
