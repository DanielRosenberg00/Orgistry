/**
 * Security/audit metadata sanitization.
 *
 * Shared by the auth security-event writer and the organization member-management
 * audit seam: any structured metadata attached to a durable security/audit record
 * is passed through this sanitizer first. Raw secret VALUES must never be placed
 * in metadata in the first place — this is the defense-in-depth backstop.
 */

/**
 * Substrings that mark a metadata key as sensitive. Any key whose lowercased
 * name contains one of these is dropped entirely (never masked-in-place, so the
 * value cannot leak through partial redaction). This is a denylist by design:
 * security metadata should be small and intentional, and dropping an unexpected
 * sensitive field is safer than letting it through.
 *
 * `ipaddress` / `useragent` / `sessionid` are request-correlation identifiers,
 * not secrets: they are surfaced (when at all) through dedicated columns and DTO
 * fields, never freeform metadata. Denylisting them keeps them out of any
 * metadata blob defensively, so an audit/security reader can never expose them.
 */
const FORBIDDEN_KEY_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'hash',
  'credential',
  'otp',
  'apikey',
  'api_key',
  'ipaddress',
  'useragent',
  'sessionid',
];

/**
 * Exact key names (lowercased) that are SAFE opaque identifiers and must be kept
 * even though they contain a denylisted substring. These are non-secret,
 * already-public ids the audit/security DTOs rely on for actor/target summaries
 * (e.g. `apiKeyId` contains `apikey` but is just an opaque `key_…` id). Matching
 * is EXACT — `apiKey` (a raw secret) or `apiKeySecret` is never allowlisted, so
 * only the precise id keys survive, never a secret that merely shares a prefix.
 */
const SAFE_IDENTIFIER_KEYS = new Set([
  'apikeyid',
  'targetapikeyid',
  'actorapikeyid',
  'targetkeyid',
  'membershipid',
  'actormembershipid',
  'targetmembershipid',
  'userid',
  'actoruserid',
  'targetuserid',
  'projectid',
  'targetprojectid',
  'invitationid',
  'targetinvitationid',
  'organizationid',
  'targetorganizationid',
]);

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 1024;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Safe opaque identifiers win over the substring denylist (exact match only).
  if (SAFE_IDENTIFIER_KEYS.has(lower)) {
    return false;
  }
  return FORBIDDEN_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  // number | boolean | null | undefined — safe primitives.
  return value;
}

function sanitizeObject(
  input: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isForbiddenKey(key)) {
      continue;
    }
    output[key] = sanitizeValue(value, depth);
  }
  return output;
}

/**
 * Strip sensitive fields from security/audit metadata.
 *
 * Recursively removes any key that looks like a secret (passwords, tokens,
 * secrets, authorization headers, cookies, hashes, credentials) or a
 * request-correlation identifier (ip/user-agent/session id), caps string length,
 * and bounds nesting depth. Safe opaque identifiers (`*Id` keys in
 * `SAFE_IDENTIFIER_KEYS`) are deliberately preserved so actor/target summaries
 * keep their ids. Used both at write time (producers) and at read time (the
 * audit API), so a careless producer can never leak through the reader.
 */
export function sanitizeSecurityMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeObject(metadata, 1);
}
