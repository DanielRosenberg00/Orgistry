import { randomUUID } from 'node:crypto';

/**
 * Request correlation IDs.
 *
 * A request ID ties a single inbound request to its log lines and its error
 * envelope. It is distinct from public entity IDs (see `ids.ts`) — it is not a
 * persisted entity and uses a `req_` prefix outside the entity registry.
 */

const REQUEST_ID_PREFIX = 'req';

/** Generate a fresh request ID, e.g. `req_4f1c...`. */
export function generateRequestId(): string {
  return `${REQUEST_ID_PREFIX}_${randomUUID()}`;
}

/**
 * Resolve a request ID from an inbound header value, falling back to a fresh
 * one. Accepts the array form Node uses for repeated headers. Only non-empty
 * string values are trusted; anything else yields a new ID.
 */
export function resolveRequestId(
  headerValue: string | string[] | undefined,
): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return generateRequestId();
}
