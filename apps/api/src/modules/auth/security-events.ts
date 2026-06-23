/**
 * Security event types and metadata sanitization.
 *
 * Security events are DURABLE records of auth/security activity (persisted to
 * `security_events`), distinct from request logs and from organization audit
 * logs (which are out of scope). Event names are dotted and stable so they stay
 * understandable to whoever reads them later.
 */

export const SECURITY_EVENT_TYPES = {
  registrationSucceeded: 'auth.registration_succeeded',
  loginSucceeded: 'auth.login_succeeded',
  loginFailed: 'auth.login_failed',
  accessTokenRejected: 'auth.access_token_rejected',
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENT_TYPES)[keyof typeof SECURITY_EVENT_TYPES];

/**
 * Substrings that mark a metadata key as sensitive. Any key whose lowercased
 * name contains one of these is dropped entirely (never masked-in-place, so the
 * value cannot leak through partial redaction). This is a denylist by design:
 * security metadata should be small and intentional, and dropping an unexpected
 * sensitive field is safer than letting it through.
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
];

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 1024;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
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
 * Strip sensitive fields from security-event metadata before persistence.
 *
 * Recursively removes any key that looks like a secret (passwords, tokens,
 * secrets, authorization headers, cookies, hashes, credentials). Raw secret
 * VALUES must never be placed in metadata in the first place; this is the
 * defense-in-depth backstop.
 */
export function sanitizeSecurityMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeObject(metadata, 1);
}
