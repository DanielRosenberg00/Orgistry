/**
 * Opaque cursor encoding for cursor pagination.
 *
 * A cursor carries the position needed to fetch the next page (the contract
 * lives in `@orgistry/contracts`). It is base64url-encoded JSON so it is a
 * single opaque string to clients — they must treat it as a token, not parse
 * it. Decoding never throws on bad input; it returns null so callers can map a
 * malformed cursor to a validation error.
 */

export function encodeCursor(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor<T = Record<string, unknown>>(
  cursor: string,
): T | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
