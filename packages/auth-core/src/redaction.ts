/**
 * Secret redaction helpers.
 *
 * Used when auth values must appear in a log or diagnostic context: replace the
 * secret with a fixed mask so its length and content never leak. These never
 * return any portion of the original secret.
 */

const REDACTION_MASK = '[REDACTED]';

/** Replace a secret with a fixed mask, preserving null/undefined for callers. */
export function redactSecret(value: string | null | undefined): string {
  return value == null || value.length === 0 ? '' : REDACTION_MASK;
}

/**
 * Mask a Bearer/authorization header value while keeping the scheme visible,
 * e.g. `Bearer eyJ...` -> `Bearer [REDACTED]`. Useful for safe request logging.
 */
export function redactAuthorizationHeader(header: string): string {
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex <= 0) {
    return REDACTION_MASK;
  }
  return `${header.slice(0, spaceIndex)} ${REDACTION_MASK}`;
}
