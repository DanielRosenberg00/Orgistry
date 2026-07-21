import { randomUUID } from 'node:crypto';

/**
 * Request correlation IDs.
 *
 * A request ID ties a single inbound request to its log lines and its error
 * envelope. It is distinct from public entity IDs (see `ids.ts`) — it is not a
 * persisted entity and uses a `req_` prefix outside the entity registry.
 *
 * Inbound `x-request-id` values are UNTRUSTED input that ends up in response
 * headers, structured logs, error envelopes, and durable security events, so
 * this module is also the single sanitization policy for them (Sprint 19):
 * a client-supplied ID is preserved only when it matches the conservative
 * accepted format below; anything else — empty, overlong, whitespace,
 * CR/LF/NUL, control characters, or any character outside the safe set — is
 * REPLACED with a server-generated ID. Replacement (never partial cleanup)
 * guarantees an unsafe value can never reach a log line or response header.
 */

const REQUEST_ID_PREFIX = 'req';

/**
 * Maximum accepted length for a client-supplied request ID. Generous enough
 * for UUID-based and W3C-trace-style correlation IDs; small enough that a
 * hostile value cannot bloat logs or headers.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Accepted client request-ID format: 1–128 characters of ASCII letters,
 * digits, `_`, `-`, or `.`. Deliberately conservative — no whitespace, no
 * control characters, nothing that could forge log lines or split headers.
 */
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Generate a fresh request ID, e.g. `req_4f1c...`. */
export function generateRequestId(): string {
  return `${REQUEST_ID_PREFIX}_${randomUUID()}`;
}

/** True when a client-supplied value is safe to use verbatim as a request ID. */
export function isSafeRequestId(candidate: string): boolean {
  return SAFE_REQUEST_ID_PATTERN.test(candidate);
}

/**
 * Resolve a request ID from an inbound header value.
 *
 * Accepts the array form Node uses for repeated headers (first value wins).
 * A candidate is preserved ONLY when it matches the accepted format; every
 * other shape — missing, empty, overlong, malformed, or containing whitespace
 * or control characters — yields a freshly generated ID. No partial
 * sanitization: a dangerous value is replaced wholesale, never trimmed into
 * something that still half-resembles client input.
 */
export function resolveRequestId(
  headerValue: string | string[] | undefined,
): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof candidate === 'string' && isSafeRequestId(candidate)) {
    return candidate;
  }
  return generateRequestId();
}
